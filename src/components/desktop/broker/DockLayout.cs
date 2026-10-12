using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DSHDesktopBroker;

/// <summary>
/// 右侧停靠：本窗口（DeepSeek Harness）以最小宽度贴在工作区右侧，
/// 当前操作的目标窗口铺满左侧。布局计算与 Win32 调用分离，便于单测。
/// </summary>
static class DockLayout
{
    public const string EnvFlag = "DSH_DESKTOP_DOCK";
    const int DebounceMs = 300;
    const string HarnessProcessName = "DeepSeek Harness";
    const string ElevatedMsg = "目标窗口权限高于本程序，无法调整其位置。";
    const string MinWidthMsg = "目标窗口最小宽度超出可用区域。";
    const string NoDshMsg = "没有找到 DSH 主窗口（DeepSeek Harness）。";
    const string NoTargetMsg = "没有可用的目标窗口。";

    static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    static readonly object Gate = new();
    static bool _bootstrapped;
    static bool _enabled;
    static IntPtr _lastTarget;
    static bool _lastTargetTiled;
    static long _lastTileTicks;
    static readonly Dictionary<long, Win32.SavedPlacement> Saved = new();
    /// <summary>保存位置时窗口所属进程号；恢复前核对，防止句柄被复用或程序已重启。</summary>
    static readonly Dictionary<long, uint> SavedPid = new();
    static Win32.SavedPlacement? _savedDsh;
    static bool _exitHooked;

    internal readonly record struct Rect(int Left, int Top, int Right, int Bottom)
    {
        public int Width => Right - Left;
        public int Height => Bottom - Top;
        public bool IsEmpty => Width <= 0 || Height <= 0;
    }

    internal readonly record struct Size(int Width, int Height);

    /// <summary>外框相对可见边框的伸出量（通常含不可见边，左/右约 7px）。</summary>
    internal readonly record struct FrameInsets(int Left, int Top, int Right, int Bottom)
    {
        public static FrameInsets FromOuterAndFrame(Rect outer, Rect frame) => new(
            Math.Max(0, frame.Left - outer.Left),
            Math.Max(0, frame.Top - outer.Top),
            Math.Max(0, outer.Right - frame.Right),
            Math.Max(0, outer.Bottom - frame.Bottom));
    }

    internal readonly record struct LayoutInput(
        Rect Work,
        Size DshMinOuter,
        FrameInsets DshInsets,
        Size TargetMinOuter,
        FrameInsets TargetInsets);

    internal readonly record struct LayoutResult(
        Rect DshOuter,
        Rect TargetOuter,
        int DockVisibleWidth,
        int TargetVisibleWidth,
        bool TargetMinExceeded);

    /// <summary>
    /// 纯布局：DSH 可见边框贴工作区右缘，宽度取最小外宽去掉左右伸出后的可见宽；
    /// 目标可见边框铺满左侧至 DSH 左缘，上下贴齐工作区。
    /// </summary>
    internal static LayoutResult Compute(LayoutInput input)
    {
        var work = input.Work;
        if (work.IsEmpty)
            return new LayoutResult(default, default, 0, 0, false);

        var dshVisibleW = Math.Max(1, input.DshMinOuter.Width - input.DshInsets.Left - input.DshInsets.Right);
        var dshFrame = new Rect(
            work.Right - dshVisibleW,
            work.Top,
            work.Right,
            work.Bottom);
        var dshOuter = FrameToOuter(dshFrame, input.DshInsets);

        var targetFrame = new Rect(work.Left, work.Top, dshFrame.Left, work.Bottom);
        var targetVisibleMin = Math.Max(0, input.TargetMinOuter.Width - input.TargetInsets.Left - input.TargetInsets.Right);
        var exceeded = targetFrame.Width > 0 && targetVisibleMin > targetFrame.Width;
        var targetOuter = FrameToOuter(targetFrame, input.TargetInsets);
        return new LayoutResult(dshOuter, targetOuter, dshVisibleW, targetFrame.Width, exceeded);
    }

    internal enum SizeMode { Fill, KeepSize }

    /// <summary>目标窗口的尺寸特征。MaxTrackWidth 为 0 表示未声明上限。</summary>
    internal readonly record struct SizingInput(
        bool Resizable, string ProcessName, string ClassName, int MaxTrackWidth, int AvailableOuterWidth);

    /// <summary>固定内容宽度的进程（微信小程序窗口：内容固定在左侧手机宽度，拉宽只会留白）。</summary>
    static readonly string[] FixedContentProcesses = ["WeChatAppEx"];

    /// <summary>
    /// 是否允许拉伸目标窗口铺满左侧。以下情况只移动、不改尺寸：
    /// 无 WS_THICKFRAME；已知固定内容进程；声明的最大跟踪宽度小于可用宽度。
    /// </summary>
    internal static SizeMode DecideSizing(SizingInput s)
    {
        if (!s.Resizable) return SizeMode.KeepSize;
        foreach (var p in FixedContentProcesses)
            if (string.Equals(s.ProcessName, p, StringComparison.OrdinalIgnoreCase)) return SizeMode.KeepSize;
        if (s.MaxTrackWidth > 0 && s.MaxTrackWidth < s.AvailableOuterWidth) return SizeMode.KeepSize;
        return SizeMode.Fill;
    }

    /// <summary>保持尺寸：可见右缘贴 DSH 左缘（放不下时贴工作区左缘），纵向保持原位并夹在工作区内。</summary>
    internal static Rect PlaceKeepSize(Rect currentOuter, FrameInsets insets, Rect work, int dockFrameLeft)
    {
        var frameW = Math.Max(1, currentOuter.Width - insets.Left - insets.Right);
        var frameH = Math.Max(1, currentOuter.Height - insets.Top - insets.Bottom);
        var frameLeft = Math.Max(work.Left, dockFrameLeft - frameW);
        var frameTop = currentOuter.Top + insets.Top;
        if (frameH >= work.Height) frameTop = work.Top;
        else frameTop = Math.Clamp(frameTop, work.Top, work.Bottom - frameH);
        return FrameToOuter(new Rect(frameLeft, frameTop, frameLeft + frameW, frameTop + frameH), insets);
    }

    internal static Rect FrameToOuter(Rect frame, FrameInsets insets) => new(
        frame.Left - insets.Left,
        frame.Top - insets.Top,
        frame.Right + insets.Right,
        frame.Bottom + insets.Bottom);

    public static void BootstrapFromEnv()
    {
        lock (Gate)
        {
            if (_bootstrapped) return;
            _bootstrapped = true;
            var flag = Environment.GetEnvironmentVariable(EnvFlag);
            if (string.Equals(flag, "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(flag, "true", StringComparison.OrdinalIgnoreCase)
                || string.Equals(flag, "yes", StringComparison.OrdinalIgnoreCase))
            {
                _enabled = true;
            }
            EnsureExitHook();
        }
        if (_enabled)
        {
            // 上一个经纪人被直接结束（没跑到退出恢复）时，接上它保存的原始位置，避免被新的停靠位置覆盖。
            lock (Gate) { LoadFileIntoSavedUnlocked(); }
            // 开关打开后经纪人重启：立即停靠，不等下一次工具调用。
            new Thread(() =>
            {
                Thread.Sleep(400);
                lock (Gate) { var tgt = PickInitialTarget(); var (e, w) = TileCore(tgt); Console.Error.WriteLine($"dock-initial target=0x{tgt.ToInt64():X} error={e ?? "-"} warning={w ?? "-"}"); }
            }) { IsBackground = true, Name = "dock-initial" }.Start();
        }
        else
        {
            // 开关关闭后经纪人以无停靠方式重启：恢复上一进程保存的位置。
            lock (Gate) { RestoreFromFileUnlocked(); }
        }
    }

    /// <summary>首选前台非 DSH 窗口，否则按 Z 序取第一个普通应用窗口。</summary>
    internal static IntPtr PickInitialTarget()
    {
        var dsh = FindDshWindow();
        var fg = Win32.ForegroundRoot();
        if (fg != IntPtr.Zero && fg != dsh && Win32.IsNormalAppWindow(fg)) return fg;
        foreach (var hwnd in Win32.TopLevelWindows())
        {
            if (hwnd == dsh) continue;
            if (Win32.IsNormalAppWindow(hwnd)) return hwnd;
        }
        return IntPtr.Zero;
    }

    public static string Control(string mode, string hwnd)
    {
        BootstrapFromEnv();
        mode = (mode ?? "status").Trim().ToLowerInvariant();
        return mode switch
        {
            "on" => Enable(hwnd),
            "off" => Disable(),
            "status" => StatusJson(),
            _ => Json(new { ok = false, reason = "mode 须为 on、off 或 status。" }),
        };
    }

    /// <summary>操作目标窗口前调用：停靠开启且目标变化时重新铺排（带去抖）。</summary>
    public static void MaybeRetile(IntPtr target)
    {
        BootstrapFromEnv();
        if (!_enabled || target == IntPtr.Zero) return;
        if (IsDshWindow(target)) return;

        lock (Gate)
        {
            var now = Environment.TickCount64;
            if (target == _lastTarget && _lastTargetTiled) return;
            if (now - _lastTileTicks < DebounceMs && target == _lastTarget) return;
            _ = TileCore(target);
        }
    }

    static string Enable(string hwnd)
    {
        lock (Gate)
        {
            EnsureExitHook();
            _enabled = true;
            if (TryParseHwnd(hwnd, out var target) && target != IntPtr.Zero && !IsDshWindow(target))
            {
                var (err, warn) = TileCore(target);
                if (err != null)
                    return Json(new { ok = false, enabled = true, reason = err, docked = false });
                return StatusJsonUnlocked(ok: true, note: warn ?? "已停靠");
            }
            var (e2, w2) = TileCore(PickInitialTarget());
            if (e2 != null)
                return StatusJsonUnlocked(ok: true, note: "已进入停靠模式：" + e2);
            return StatusJsonUnlocked(ok: true, note: w2 ?? "已停靠");
        }
    }

    static string Disable()
    {
        lock (Gate)
        {
            RestoreAllUnlocked();
            _enabled = false;
            _lastTarget = IntPtr.Zero;
            _lastTargetTiled = false;
            return Json(new { ok = true, enabled = false, note = "已关闭停靠，并尝试恢复各窗口原有位置。" });
        }
    }

    static string StatusJson()
    {
        lock (Gate) return StatusJsonUnlocked(ok: true, note: null);
    }

    static string StatusJsonUnlocked(bool ok, string? note)
    {
        IntPtr dsh = FindDshWindow();
        BoundsRect? dshBounds = null;
        if (dsh != IntPtr.Zero && Win32.TryGetRect(dsh, out var r)) dshBounds = r;
        return Json(new
        {
            ok,
            enabled = _enabled,
            docked = _lastTargetTiled && _lastTarget != IntPtr.Zero,
            dshHwnd = dsh == IntPtr.Zero ? null : FormatHwnd(dsh),
            targetHwnd = _lastTarget == IntPtr.Zero ? null : FormatHwnd(_lastTarget),
            dshBounds,
            note,
        });
    }

    /// <summary>返回 (error, warning)。error 非空表示未铺排；warning 为仍已铺排时的提示。调用方须已持有 Gate。</summary>
    static (string? Error, string? Warning) TileCore(IntPtr target)
    {
        var dsh = FindDshWindow();
        if (dsh == IntPtr.Zero) return (NoDshMsg, null);
        if (target == IntPtr.Zero || !Win32.IsWindow(target)) return (NoTargetMsg, null);
        if (IsDshWindow(target)) return ("不能把 DSH 自身作为停靠目标。", null);

        var pid = Win32.WindowPid(target);
        if (Win32.IsHigherThanSelf(pid)) return (ElevatedMsg, null);

        if (Win32.IsCloaked(target)) return ("目标窗口当前不可见（已被遮蔽）。", null);

        Remember(dsh, isDsh: true);
        Remember(target, isDsh: false);

        Win32.RestoreIfNeeded(dsh);
        Win32.RestoreIfNeeded(target);

        if (!Win32.TryGetMonitorWorkArea(dsh, out var workLeft, out var workTop, out var workRight, out var workBottom))
            return ("无法读取显示器工作区。", null);

        if (!Win32.TryGetRect(dsh, out var dshOuterR) || !Win32.TryGetExtendedFrame(dsh, out var dshFrameR))
            return ("无法读取 DSH 窗口矩形。", null);
        if (!Win32.TryGetRect(target, out var targetOuterR) || !Win32.TryGetExtendedFrame(target, out var targetFrameR))
            return ("无法读取目标窗口矩形。", null);

        var probed = Win32.ProbeMinOuterWidth(dsh, workRight - 1, workTop, Math.Max(1, workBottom - workTop));
        var dshMin = probed > 1
            ? new Size(probed, 1)
            : Win32.TryGetMinTrackSize(dsh, out var dshMinW, out var dshMinH)
                ? new Size(Math.Max(dshMinW, 1), Math.Max(dshMinH, 1))
                : new Size(Math.Max(dshOuterR.Width, 1), Math.Max(dshOuterR.Height, 1));
        var targetMin = Win32.TryGetMinTrackSize(target, out var tMinW, out var tMinH)
            ? new Size(Math.Max(tMinW, 1), Math.Max(tMinH, 1))
            : new Size(1, 1);

        var dshOuter = ToRect(dshOuterR);
        var dshFrame = ToRect(dshFrameR);
        var targetOuter = ToRect(targetOuterR);
        var targetFrame = ToRect(targetFrameR);

        var input = new LayoutInput(
            new Rect(workLeft, workTop, workRight, workBottom),
            dshMin,
            FrameInsets.FromOuterAndFrame(dshOuter, dshFrame),
            targetMin,
            FrameInsets.FromOuterAndFrame(targetOuter, targetFrame));
        var layout = Compute(input);
        var targetInsets = input.TargetInsets;
        var dockFrameLeft = layout.DshOuter.Left + input.DshInsets.Left;
        var keepBase = targetOuter;
        if (Saved.TryGetValue(target.ToInt64(), out var orig) && orig.NormalRight > orig.NormalLeft)
            keepBase = new Rect(targetOuter.Left, targetOuter.Top,
                targetOuter.Left + (orig.NormalRight - orig.NormalLeft), targetOuter.Top + (orig.NormalBottom - orig.NormalTop));
        Win32.TryGetMaxTrackSize(target, out var maxTrackW);
        var mode = DecideSizing(new SizingInput(
            Win32.IsResizable(target), Win32.ProcessNameOf(target), Win32.ClassName(target),
            maxTrackW, layout.TargetOuter.Width));
        var tgt = mode == SizeMode.KeepSize
            ? PlaceKeepSize(keepBase, targetInsets, input.Work, dockFrameLeft)
            : layout.TargetOuter;
        Console.Error.WriteLine($"dock-sizing mode={mode} proc={Win32.ProcessNameOf(target)} maxTrackW={maxTrackW} tgt={tgt}");

        Console.Error.WriteLine($"dock-layout work=({workLeft},{workTop},{workRight},{workBottom}) dshMin={dshMin} dshOut={layout.DshOuter} tgtOut={layout.TargetOuter}");
        if (!Win32.SetOuterRects(
                dsh, layout.DshOuter.Left, layout.DshOuter.Top, layout.DshOuter.Width, layout.DshOuter.Height,
                target, tgt.Left, tgt.Top, tgt.Width, tgt.Height))
            return ("调整窗口位置失败。", null);

        // 核对目标是否真的接受了尺寸；没接受就按实际尺寸重新贴边，不留缝也不重叠。
        if (mode == SizeMode.Fill && Win32.TryGetRect(target, out var actual)
            && (Math.Abs(actual.Width - tgt.Width) > 8 || Math.Abs(actual.Height - tgt.Height) > 8))
        {
            var fixedRect = PlaceKeepSize(ToRect(actual), targetInsets, input.Work, dockFrameLeft);
            Win32.MoveOnly(target, fixedRect.Left, fixedRect.Top);
            return (null, "目标窗口不接受调整尺寸，已保持原尺寸贴靠。");
        }

        _lastTarget = target;
        _lastTargetTiled = true;
        _lastTileTicks = Environment.TickCount64;

        if (mode == SizeMode.KeepSize) return (null, "目标窗口为固定尺寸，已保持原尺寸贴靠。");
        return (null, layout.TargetMinExceeded ? MinWidthMsg : null);
    }

    static void Remember(IntPtr hwnd, bool isDsh)
    {
        if (!Win32.TryGetPlacement(hwnd, out var placement)) return;
        if (isDsh)
        {
            if (_savedDsh == null) _savedDsh = placement;
        }
        else
        {
            var key = hwnd.ToInt64();
            if (!Saved.ContainsKey(key)) { Saved[key] = placement; SavedPid[key] = (uint)Win32.WindowPid(hwnd); }
        }
        SaveFileUnlocked();
    }

    sealed record StateEntry(long Hwnd, bool IsDsh, Win32.SavedPlacement P, uint Pid = 0);

    static string StateFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DSHDesktopBroker", "dock-state.json");

    static void SaveFileUnlocked()
    {
        try
        {
            var list = new List<StateEntry>();
            var dsh = FindDshWindow();
            if (_savedDsh is { } d && dsh != IntPtr.Zero) list.Add(new StateEntry(dsh.ToInt64(), true, d, (uint)Win32.WindowPid(dsh)));
            foreach (var (k, p) in Saved) list.Add(new StateEntry(k, false, p, SavedPid.GetValueOrDefault(k)));
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile)!);
            File.WriteAllText(StateFile, JsonSerializer.Serialize(list, JsonOpts));
        }
        catch { }
    }

    static void LoadFileIntoSavedUnlocked()
    {
        try
        {
            if (!File.Exists(StateFile)) return;
            var list = JsonSerializer.Deserialize<List<StateEntry>>(File.ReadAllText(StateFile), JsonOpts) ?? new();
            foreach (var e in list)
            {
                var h = new IntPtr(e.Hwnd);
                if (!Win32.IsWindow(h)) continue;
                if (e.Pid != 0 && (uint)Win32.WindowPid(h) != e.Pid) continue;
                if (e.IsDsh) { if (h == FindDshWindow()) _savedDsh ??= e.P; continue; }
                if (Saved.TryAdd(e.Hwnd, e.P)) SavedPid[e.Hwnd] = e.Pid != 0 ? e.Pid : (uint)Win32.WindowPid(h);
            }
        }
        catch { }
    }

    static void RestoreFromFileUnlocked()
    {
        try
        {
            if (!File.Exists(StateFile)) return;
            var list = JsonSerializer.Deserialize<List<StateEntry>>(File.ReadAllText(StateFile), JsonOpts) ?? new();
            var dsh = FindDshWindow();
            foreach (var e in list)
            {
                var h = new IntPtr(e.Hwnd);
                if (e.IsDsh)
                {
                    // 只恢复同一个 DSH 窗口（句柄与进程号都对得上），且不同步、不隐藏、不最小化。
                    if (h != IntPtr.Zero && h == dsh && (e.Pid == 0 || (uint)Win32.WindowPid(h) == e.Pid))
                        Win32.RestoreHostWindow(h, e.P);
                    continue;
                }
                // 旧句柄被复用成了 DSH 窗口：跳过，不能拿别的窗口的位置去摆 DSH。
                if (h == dsh) continue;
                // 旧文件没有 Pid 时只恢复仍可见的窗口，SafeRestorePlacement 不会显示隐藏窗口。
                Win32.SafeRestorePlacement(h, e.P, e.Pid);
            }
            File.Delete(StateFile);
        }
        catch { }
    }

    static void RestoreAllUnlocked()
    {
        var dsh = FindDshWindow();
        if (_savedDsh is { } dshPlacement)
        {
            // 不用同步的 SetWindowPlacement：退出时 DSH 可能正等经纪人结束；保存的 showCmd 也可能是最小化。
            if (dsh != IntPtr.Zero) Win32.RestoreHostWindow(dsh, dshPlacement);
            _savedDsh = null;
        }
        foreach (var (key, placement) in Saved)
        {
            var hwnd = new IntPtr(key);
            if (hwnd == dsh) continue;
            Win32.SafeRestorePlacement(hwnd, placement, SavedPid.GetValueOrDefault(key));
        }
        Saved.Clear();
        SavedPid.Clear();
        _lastTargetTiled = false;
        try { if (File.Exists(StateFile)) File.Delete(StateFile); } catch { }
    }

    static void EnsureExitHook()
    {
        if (_exitHooked) return;
        _exitHooked = true;
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            lock (Gate)
            {
                if (_enabled) RestoreAllUnlocked();
            }
        };
    }

    public static IntPtr FindDshWindow()
    {
        var selfPid = (uint)Environment.ProcessId;
        var pid = selfPid;
        for (var depth = 0; depth < 24; depth++)
        {
            var parent = Win32.ParentProcessId(pid);
            if (parent == 0 || parent == pid) break;
            if (IsHarnessPid(parent))
            {
                var hwnd = Win32.FindTopLevelForPid(parent);
                if (hwnd != IntPtr.Zero) return hwnd;
            }
            pid = parent;
        }
        foreach (var p in Process.GetProcessesByName(HarnessProcessName))
        {
            try
            {
                var hwnd = Win32.FindTopLevelForPid((uint)p.Id);
                if (hwnd != IntPtr.Zero) return hwnd;
            }
            finally { p.Dispose(); }
        }
        return IntPtr.Zero;
    }

    static bool IsHarnessPid(uint pid)
    {
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName.Equals(HarnessProcessName, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static bool IsDshWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        var dsh = FindDshWindow();
        return dsh != IntPtr.Zero && dsh == hwnd;
    }

    static Rect ToRect(BoundsRect r) => new(r.X, r.Y, r.X + r.Width, r.Y + r.Height);

    static bool TryParseHwnd(string text, out IntPtr hwnd)
    {
        hwnd = IntPtr.Zero;
        text = (text ?? "").Trim();
        if (text.Length == 0) return false;
        var body = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;
        var style = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? NumberStyles.HexNumber : NumberStyles.Integer;
        if (!long.TryParse(body, style, CultureInfo.InvariantCulture, out var value) || value == 0) return false;
        hwnd = new IntPtr(value);
        return true;
    }

    static string FormatHwnd(IntPtr hwnd) => "0x" + hwnd.ToInt64().ToString("X", CultureInfo.InvariantCulture);

    static string Json(object value) => JsonSerializer.Serialize(value, JsonOpts);
}
