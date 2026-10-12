using System.Runtime.InteropServices;
using System.Text;

namespace DSHDesktopBroker;

static partial class Win32
{
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int WM_GETMINMAXINFO = 0x0024;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    const int SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint TH32CS_SNAPPROCESS = 0x00000002;

    public readonly record struct SavedPlacement(int ShowCmd, int Flags, int NormalLeft, int NormalTop, int NormalRight, int NormalBottom);

    public static bool IsWindow(IntPtr hwnd) => hwnd != IntPtr.Zero && IsWindowNative(hwnd);

    public static bool TryGetExtendedFrame(IntPtr hwnd, out BoundsRect rect)
    {
        rect = default;
        if (hwnd == IntPtr.Zero) return false;
        if (DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out var r, Marshal.SizeOf<RECT>()) != 0)
            return TryGetRect(hwnd, out rect);
        rect = new BoundsRect(r.Left, r.Top, Math.Max(0, r.Right - r.Left), Math.Max(0, r.Bottom - r.Top));
        return rect.Width > 0 && rect.Height > 0;
    }

    public static bool TryGetMinTrackSize(IntPtr hwnd, out int minWidth, out int minHeight)
    {
        minWidth = 0;
        minHeight = 0;
        if (hwnd == IntPtr.Zero) return false;
        var info = new MINMAXINFO();
        var result = SendMessageTimeout(
            hwnd, WM_GETMINMAXINFO, IntPtr.Zero, ref info, SMTO_ABORTIFHUNG, 200, out _);
        if (result == IntPtr.Zero) return false;
        minWidth = info.ptMinTrackSize.X;
        minHeight = info.ptMinTrackSize.Y;
        return minWidth > 0 && minHeight > 0;
    }

    public static bool TryGetMonitorWorkArea(IntPtr hwnd, out int left, out int top, out int right, out int bottom)
    {
        left = top = right = bottom = 0;
        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (monitor == IntPtr.Zero) return false;
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(monitor, ref mi)) return false;
        left = mi.rcWork.Left;
        top = mi.rcWork.Top;
        right = mi.rcWork.Right;
        bottom = mi.rcWork.Bottom;
        return right > left && bottom > top;
    }

    public static void RestoreIfNeeded(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        if (IsZoomed(hwnd) || IsIconic(hwnd))
            _ = ShowWindow(hwnd, SW_RESTORE);
    }

    public static bool TryGetPlacement(IntPtr hwnd, out SavedPlacement placement)
    {
        placement = default;
        var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf<WINDOWPLACEMENT>() };
        if (!GetWindowPlacement(hwnd, ref wp)) return false;
        placement = new SavedPlacement(
            wp.showCmd,
            wp.flags,
            wp.rcNormalPosition.Left,
            wp.rcNormalPosition.Top,
            wp.rcNormalPosition.Right,
            wp.rcNormalPosition.Bottom);
        return true;
    }

    /// <summary>
    /// 安全恢复别的程序的窗口位置：
    /// - 句柄已失效，或进程号与保存时不同（句柄被复用 / 程序已重启）则跳过；
    /// - 从不改变可见性：当前隐藏的窗口（如微信关掉后留在后台复用的小程序窗口）只挪位置不显示，
    ///   可见窗口用不抢焦点的 showCmd，保存值为 SW_HIDE 时按普通窗口处理；
    /// - 正常位置与任何显示器工作区都不相交（显示器布局变了）时，挪进最近的工作区。
    /// </summary>
    public static List<IntPtr> AllTopLevelWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows((hwnd, _) => { list.Add(hwnd); return true; }, IntPtr.Zero);
        return list;
    }

    public static bool IsVisible(IntPtr hwnd) => IsWindowVisible(hwnd);
    public static bool IsMinimized(IntPtr hwnd) => IsIconic(hwnd);

    /// <summary>SW_RESTORE 显示窗口，必要时挪进最近显示器的工作区，再切到前台。</summary>
    public static bool Reveal(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        _ = ShowWindow(hwnd, SW_RESTORE);
        if (GetWindowRect(hwnd, out var r))
        {
            var c = ClampToWorkArea(r.Left, r.Top, r.Right, r.Bottom);
            if (c != (r.Left, r.Top, r.Right, r.Bottom))
                SetWindowPos(hwnd, IntPtr.Zero, c.Left, c.Top, c.Right - c.Left, c.Bottom - c.Top, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        _ = ConfirmForeground(hwnd);
        return IsWindowVisible(hwnd);
    }

    public static bool SafeRestorePlacement(IntPtr hwnd, SavedPlacement placement, uint expectedPid)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        if (expectedPid != 0 && (uint)WindowPid(hwnd) != expectedPid) return false;
        var fixedRect = ClampToWorkArea(placement.NormalLeft, placement.NormalTop, placement.NormalRight, placement.NormalBottom);
        placement = placement with
        {
            NormalLeft = fixedRect.Left, NormalTop = fixedRect.Top, NormalRight = fixedRect.Right, NormalBottom = fixedRect.Bottom,
        };
        if (!IsWindowVisible(hwnd))
        {
            if (IsIconic(hwnd) || IsZoomed(hwnd)) return false;
            return SetWindowPos(hwnd, IntPtr.Zero, fixedRect.Left, fixedRect.Top,
                fixedRect.Right - fixedRect.Left, fixedRect.Bottom - fixedRect.Top, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        var show = placement.ShowCmd switch
        {
            2 or 6 or 7 => 7,  // SW_SHOWMINNOACTIVE
            3 => 3,            // SW_SHOWMAXIMIZED
            _ => 4,            // SW_SHOWNOACTIVATE（含 0 / 1）
        };
        return TrySetPlacement(hwnd, placement with { ShowCmd = show });
    }

    /// <summary>矩形与所有显示器工作区的交集不足 100×60 时，挪进最近显示器的工作区（必要时缩小）。</summary>
    public static (int Left, int Top, int Right, int Bottom) ClampToWorkArea(int left, int top, int right, int bottom)
    {
        if (right <= left || bottom <= top) return (left, top, right, bottom);
        var r = new RECT { Left = left, Top = top, Right = right, Bottom = bottom };
        var monitor = MonitorFromRect(ref r, MONITOR_DEFAULTTONEAREST);
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref mi)) return (left, top, right, bottom);
        var w = mi.rcWork;
        var ix = Math.Min(right, w.Right) - Math.Max(left, w.Left);
        var iy = Math.Min(bottom, w.Bottom) - Math.Max(top, w.Top);
        if (ix >= 100 && iy >= 60) return (left, top, right, bottom);
        var width = Math.Min(right - left, w.Right - w.Left);
        var height = Math.Min(bottom - top, w.Bottom - w.Top);
        var nl = Math.Clamp(left, w.Left, w.Right - width);
        var nt = Math.Clamp(top, w.Top, w.Bottom - height);
        return (nl, nt, nl + width, nt + height);
    }

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromRect(ref RECT lprc, uint dwFlags);

    public static bool TrySetPlacement(IntPtr hwnd, SavedPlacement placement)
    {
        if (hwnd == IntPtr.Zero) return false;
        var wp = new WINDOWPLACEMENT
        {
            length = Marshal.SizeOf<WINDOWPLACEMENT>(),
            flags = placement.Flags,
            showCmd = placement.ShowCmd,
            rcNormalPosition = new RECT
            {
                Left = placement.NormalLeft,
                Top = placement.NormalTop,
                Right = placement.NormalRight,
                Bottom = placement.NormalBottom,
            },
        };
        return SetWindowPlacement(hwnd, ref wp);
    }

    public static bool SetOuterRects(
        IntPtr hwndA, int leftA, int topA, int widthA, int heightA,
        IntPtr hwndB, int leftB, int topB, int widthB, int heightB)
    {
        if (hwndA == IntPtr.Zero || hwndB == IntPtr.Zero) return false;
        if (widthA <= 0 || heightA <= 0 || widthB <= 0 || heightB <= 0) return false;
        var hdwp = BeginDeferWindowPos(2);
        if (hdwp == IntPtr.Zero)
        {
            var okA = SetWindowPos(hwndA, IntPtr.Zero, leftA, topA, widthA, heightA, SWP_NOZORDER | SWP_NOACTIVATE);
            var okB = SetWindowPos(hwndB, IntPtr.Zero, leftB, topB, widthB, heightB, SWP_NOZORDER | SWP_NOACTIVATE);
            return okA && okB;
        }
        var h1 = DeferWindowPos(hdwp, hwndA, IntPtr.Zero, leftA, topA, widthA, heightA, SWP_NOZORDER | SWP_NOACTIVATE);
        var h2 = h1 == IntPtr.Zero ? IntPtr.Zero : DeferWindowPos(h1, hwndB, IntPtr.Zero, leftB, topB, widthB, heightB, SWP_NOZORDER | SWP_NOACTIVATE);
        if (h2 != IntPtr.Zero && EndDeferWindowPos(h2)) return true;
        // 跨进程窗口上 DeferWindowPos 可能失败：逐个 SetWindowPos 兜底。
        var a = SetWindowPos(hwndA, IntPtr.Zero, leftA, topA, widthA, heightA, SWP_NOZORDER | SWP_NOACTIVATE);
        var b = SetWindowPos(hwndB, IntPtr.Zero, leftB, topB, widthB, heightB, SWP_NOZORDER | SWP_NOACTIVATE);
        if (!(a && b)) Console.Error.WriteLine($"dock-setpos a={a} b={b} err={Marshal.GetLastWin32Error()}");
        return a && b;
    }

    /// <summary>实测最小外宽：把窗口压到 1px 宽，读回被应用钳制后的宽度（Electron 的 minWidth 不一定反映在 WM_GETMINMAXINFO）。</summary>
    public static int ProbeMinOuterWidth(IntPtr hwnd, int left, int top, int height)
    {
        if (!SetWindowPos(hwnd, IntPtr.Zero, left, top, 1, height, SWP_NOZORDER | SWP_NOACTIVATE)) return 0;
        Thread.Sleep(60);
        return TryGetRect(hwnd, out var r) ? r.Width : 0;
    }

    public static uint ParentProcessId(uint pid)
    {
        var snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
        try
        {
            var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (!Process32First(snap, ref entry)) return 0;
            do
            {
                if (entry.th32ProcessID == pid) return entry.th32ParentProcessID;
            } while (Process32Next(snap, ref entry));
            return 0;
        }
        finally { CloseHandle(snap); }
    }

    public static IntPtr FindTopLevelForPid(uint pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd) || IsCloaked(hwnd)) return true;
            GetWindowThreadProcessId(hwnd, out uint windowPid);
            if (windowPid != pid) return true;
            if (WindowText(hwnd).Length == 0) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x80;
    const uint GW_OWNER = 4;

    const long WS_THICKFRAME = 0x00040000;

    public static bool IsResizable(IntPtr hwnd) => (GetWindowLongPtr(hwnd, -16).ToInt64() & WS_THICKFRAME) != 0;

    public static string ProcessNameOf(IntPtr hwnd)
    {
        try { using var p = System.Diagnostics.Process.GetProcessById(WindowPid(hwnd)); return p.ProcessName; }
        catch { return ""; }
    }

    public static bool TryGetMaxTrackSize(IntPtr hwnd, out int maxWidth)
    {
        maxWidth = 0;
        var info = new MINMAXINFO();
        if (SendMessageTimeout(hwnd, WM_GETMINMAXINFO, IntPtr.Zero, ref info, SMTO_ABORTIFHUNG, 200, out _) == IntPtr.Zero
            && info.ptMaxTrackSize.X == 0) return false;
        // 未声明上限时常见 0 或 int.MaxValue。
        maxWidth = info.ptMaxTrackSize.X is > 0 and < 100000 ? info.ptMaxTrackSize.X : 0;
        return maxWidth > 0;
    }

    public static bool MoveOnly(IntPtr hwnd, int left, int top) =>
        SetWindowPos(hwnd, IntPtr.Zero, left, top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);

    public static ElementLocator.Box VirtualScreenBox() => new(
        GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));

    public static IntPtr ForegroundRoot()
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return IntPtr.Zero;
        var root = GetAncestor(fg, GA_ROOT);
        return root == IntPtr.Zero ? fg : root;
    }

    /// <summary>可见、未遮蔽、有标题、无拥有者、非工具窗、非本进程、非桌面/任务栏的顶层窗口。</summary>
    public static bool IsNormalAppWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || IsCloaked(hwnd)) return false;
        if (IsIconic(hwnd)) return false;
        if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return false;
        if ((GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64() & WS_EX_TOOLWINDOW) != 0) return false;
        if (WindowText(hwnd).Length == 0) return false;
        if (WindowPid(hwnd) == Environment.ProcessId) return false;
        var cls = ClassName(hwnd);
        if (cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd" or "DshDesktopCue") return false;
        if (!TryGetRect(hwnd, out var r) || r.Width < 200 || r.Height < 150) return false;
        return true;
    }

    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);

    [StructLayout(LayoutKind.Sequential)]
    struct POINTXY
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO
    {
        public POINTXY ptReserved;
        public POINTXY ptMaxSize;
        public POINTXY ptMaxPosition;
        public POINTXY ptMinTrackSize;
        public POINTXY ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINTXY ptMinPosition;
        public POINTXY ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("user32.dll", EntryPoint = "IsWindow")]
    static extern bool IsWindowNative(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr hwndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern IntPtr BeginDeferWindowPos(int nNumWindows);

    [DllImport("user32.dll")]
    static extern IntPtr DeferWindowPos(IntPtr hWinPosInfo, IntPtr hwnd, IntPtr hwndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern bool EndDeferWindowPos(IntPtr hWinPosInfo);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll")]
    static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll")]
    static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, int msg, IntPtr wParam, ref MINMAXINFO lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    static extern int DwmGetWindowAttributeRect(IntPtr hwnd, int attr, out RECT value, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
}
