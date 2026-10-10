using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

[assembly: InternalsVisibleTo("DSHDesktopBroker.Tests")]

namespace DSHDesktopBroker;

/// <summary>把按键名收成可弹出的键帽。组合键按加号拆开。</summary>
static class OverlayCaption
{
    internal static string[] KeyChips(string key, int times)
    {
        var parts = (key ?? "").Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return [];
        var chips = parts.Select(Pretty).ToArray();
        if (times > 1)
            chips = [..chips, "×" + Math.Clamp(times, 2, 20)];
        return chips;
    }

    internal static string TypeLine(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var line = text.Replace("\r", "").Replace('\n', ' ').Trim();
        if (line.Length == 0) return "";
        return line.Length > 240 ? line[..240] : line;
    }

    internal static bool TypeScrolls(string line) => line.Length > 14;

    static string Pretty(string raw)
    {
        var key = raw.Trim().ToLowerInvariant();
        return key switch
        {
            "ctrl" or "control" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "win" or "meta" or "super" => "Win",
            "enter" or "return" => "Enter",
            "tab" => "Tab",
            "backspace" => "Backspace",
            "delete" or "del" => "Delete",
            "escape" or "esc" => "Esc",
            "left" => "←",
            "up" => "↑",
            "right" => "→",
            "down" => "↓",
            "space" => "Space",
            _ => raw.Length == 1 ? raw.ToUpperInvariant() : raw.Trim(),
        };
    }
}

enum OverlayKind { Click, Scroll, Keys, Type }

/// <summary>
/// 点击穿透的顶层光标。点击和滚动有各自的动作，输入和按键在落点右下方弹出。
/// 坐标是物理像素。窗口不接收鼠标，避免挡住下一次点击。
/// </summary>
static class ActionOverlay
{
    const int WM_TIMER = 0x0113;
    const int WM_CUE = 0x0401;
    const uint WS_POPUP = 0x80000000;
    const uint WS_EX_TOPMOST = 0x00000008;
    const uint WS_EX_TOOLWINDOW = 0x00000080;
    const uint WS_EX_TRANSPARENT = 0x00000020;
    const uint WS_EX_LAYERED = 0x00080000;
    const uint WS_EX_NOACTIVATE = 0x08000000;
    const int SW_HIDE = 0;
    const int SW_SHOWNOACTIVATE = 4;
    const uint ULW_ALPHA = 2;

    static readonly ConcurrentQueue<Cue> Queue = new();
    static readonly WndProcDelegate Proc = WindowProc;
    static readonly object Gate = new();
    static readonly ManualResetEventSlim Ready = new(false);
    static Thread? UiThread;
    static IntPtr Hwnd;
    static volatile bool Failed;
    static bool TimerOn;
    static bool Visible;

    const int DwellMs = 10_000;
    const string PluginName = "工作组件";

    static bool HasCursor;
    static float CursorX;
    static float CursorY;
    static int TargetX;
    static int TargetY;
    static bool Gliding;
    static long GlideStart;
    static CursorMotion.Plan GlidePlan;
    static float Heading = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
    static long HoldUntil;
    static bool Hovering;
    static ManualResetEventSlim? MotionDone;
    static bool PendingClick;
    static bool PendingScroll;
    static bool PendingBadge;
    static long ClickStart;
    static long ScrollStart;
    static long BadgeStart;
    static int ScrollDelta;
    static bool ScrollHorizontal;
    static int ScrollNotches = 1;
    static string[] BadgeChips = [];
    static string BadgeText = "";
    static bool BadgeIsKeys;
    static bool BadgeScroll;
    static int BadgeHoldMs = 1320;

    readonly record struct Cue(OverlayKind Kind, int X, int Y, int Delta, bool Horizontal, string Text, int Times, ManualResetEventSlim? Done);

    public static void ShowClick(int x, int y)
    {
        var done = new ManualResetEventSlim(false);
        Enqueue(new Cue(OverlayKind.Click, x, y, 0, false, "", 1, done));
        done.Wait(1000);
    }

    public static void ShowScroll(int x, int y, int delta, bool horizontal) =>
        Enqueue(new Cue(OverlayKind.Scroll, x, y, delta, horizontal, "", Math.Clamp(Math.Abs(delta) / 120, 1, 20), null));

    public static void ShowKey(int x, int y, string key, int times) =>
        Enqueue(new Cue(OverlayKind.Keys, x, y, 0, false, key ?? "", times, null));

    public static void ShowType(int x, int y, string text) =>
        Enqueue(new Cue(OverlayKind.Type, x, y, 0, false, text ?? "", 1, null));

    static void Enqueue(Cue cue)
    {
        try
        {
            Ensure();
            if (Failed || Hwnd == IntPtr.Zero)
            {
                cue.Done?.Set();
                return;
            }
            Queue.Enqueue(cue);
            PostMessage(Hwnd, WM_CUE, IntPtr.Zero, IntPtr.Zero);
        }
        catch
        {
            Failed = true;
            cue.Done?.Set();
        }
    }

    static void Ensure()
    {
        if (Failed || Hwnd != IntPtr.Zero) return;
        lock (Gate)
        {
            if (Failed || UiThread != null) return;
            Ready.Reset();
            UiThread = new Thread(Run)
            {
                IsBackground = true,
                Name = "desktop-overlay",
            };
            UiThread.SetApartmentState(ApartmentState.STA);
            UiThread.Start();
        }
        if (!Ready.Wait(TimeSpan.FromMilliseconds(800))) Failed = true;
    }

    static void Run()
    {
        try
        {
            var cls = new WNDCLASS
            {
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Proc),
                hInstance = GetModuleHandle(null),
                lpszClassName = "DshDesktopCue",
            };
            _ = RegisterClass(ref cls);
            Hwnd = CreateWindowEx(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                cls.lpszClassName,
                "",
                WS_POPUP,
                0, 0, 32, 32,
                IntPtr.Zero, IntPtr.Zero, cls.hInstance, IntPtr.Zero);
            if (Hwnd == IntPtr.Zero)
            {
                Failed = true;
                Ready.Set();
                return;
            }
            Ready.Set();
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch
        {
            Failed = true;
            Ready.Set();
        }
    }

    static IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (msg == WM_CUE || msg == WM_TIMER)
            {
                Drain();
                Advance();
                if (!Alive())
                {
                    StopTimer();
                    Hide();
                }
                else
                {
                    StartTimer();
                    Render();
                }
                return IntPtr.Zero;
            }
        }
        catch
        {
            Hide();
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    static void Drain()
    {
        while (Queue.TryDequeue(out var cue)) Apply(cue);
    }

    static void Apply(Cue cue)
    {
        var now = Now();
        BeginMove(cue.X, cue.Y, now);
        switch (cue.Kind)
        {
            case OverlayKind.Click:
                PendingClick = true;
                break;
            case OverlayKind.Scroll:
                PendingScroll = true;
                ScrollDelta = cue.Delta;
                ScrollHorizontal = cue.Horizontal;
                ScrollNotches = Math.Max(1, cue.Times);
                break;
            case OverlayKind.Keys:
                var chips = OverlayCaption.KeyChips(cue.Text, cue.Times);
                if (chips.Length == 0) break;
                PendingBadge = true;
                BadgeIsKeys = true;
                BadgeChips = chips;
                BadgeText = "";
                BadgeScroll = false;
                BadgeHoldMs = 1320;
                break;
            case OverlayKind.Type:
                var line = OverlayCaption.TypeLine(cue.Text);
                if (line.Length == 0) break;
                PendingBadge = true;
                BadgeIsKeys = false;
                BadgeText = line;
                BadgeChips = [];
                BadgeScroll = OverlayCaption.TypeScrolls(line);
                BadgeHoldMs = BadgeScroll ? ScrollBadgeMs(line) : 1320;
                break;
        }
        HoldUntil = Math.Max(HoldUntil, now + DwellMs);
        if (cue.Done != null)
        {
            MotionDone?.Set();
            if (Gliding) MotionDone = cue.Done;
            else
            {
                MotionDone = null;
                cue.Done.Set();
            }
        }
        if (!Gliding) FlushPending(now);
    }

    static int ScrollBadgeMs(string line)
    {
        var travel = Math.Max(0, line.Length * 13f - 150f);
        return (int)Math.Clamp(420f + travel / 0.2f, 1100f, 4800f);
    }

    static void BeginMove(int x, int y, long now)
    {
        TargetX = x;
        TargetY = y;
        var departX = 0f;
        var departY = 0f;
        if (!HasCursor)
        {
            var (sx, sy, dx, dy) = EntryPoint(x, y);
            CursorX = sx;
            CursorY = sy;
            HasCursor = true;
            departX = dx;
            departY = dy;
        }
        GlidePlan = CursorMotion.Build(CursorX, CursorY, x, y, departX, departY);
        if (!GlidePlan.Moves)
        {
            CursorX = x;
            CursorY = y;
            Heading = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
            Gliding = false;
            return;
        }
        GlideStart = now;
        Gliding = true;
    }

    static (float x, float y, float departX, float departY) EntryPoint(int x, int y)
    {
        var left = 0f;
        var top = 0f;
        var right = 1920f;
        var bottom = 1080f;
        try
        {
            var monitor = MonitorFromPoint(new POINT { X = x, Y = y }, 2);
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info))
            {
                left = info.rcMonitor.Left;
                top = info.rcMonitor.Top;
                right = info.rcMonitor.Right;
                bottom = info.rcMonitor.Bottom;
            }
            else
            {
                left = GetSystemMetrics(76);
                top = GetSystemMetrics(77);
                right = left + GetSystemMetrics(78);
                bottom = top + GetSystemMetrics(79);
            }
        }
        catch { /* 用默认屏幕 */ }
        if (right <= left || bottom <= top)
        {
            left = GetSystemMetrics(76);
            top = GetSystemMetrics(77);
            right = left + Math.Max(GetSystemMetrics(78), 1);
            bottom = top + Math.Max(GetSystemMetrics(79), 1);
        }
        return CursorMotion.OffscreenStart(x, y, left, top, right, bottom);
    }

    static void Advance()
    {
        if (!Gliding) return;
        var span = Math.Max(GlidePlan.DurationMs, 1);
        var u = (Now() - GlideStart) / (float)span;
        CursorMotion.Sample(GlidePlan, Math.Min(u, 1f), out var x, out var y, out Heading);
        CursorX = x;
        CursorY = y;
        if (u < 1f) return;
        CursorX = TargetX;
        CursorY = TargetY;
        Heading = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
        Gliding = false;
        var now = Now();
        HoldUntil = now + DwellMs;
        FlushPending(now);
        MotionDone?.Set();
        MotionDone = null;
    }

    static void FlushPending(long now)
    {
        if (PendingClick)
        {
            ClickStart = now;
            ScrollStart = 0;
            PendingClick = false;
        }
        if (PendingScroll)
        {
            ScrollStart = now;
            ClickStart = 0;
            PendingScroll = false;
        }
        if (PendingBadge)
        {
            BadgeStart = now;
            ScrollStart = 0;
            PendingBadge = false;
        }
    }

    static bool Alive()
    {
        var now = Now();
        return Gliding || PendingClick || PendingScroll || PendingBadge ||
            Hovering || now < HoldUntil ||
            ClickAlive(now) || ScrollAlive(now) || BadgeAlive(now);
    }

    static void Render()
    {
        var now = Now();
        var scale = ScaleAt(TargetX, TargetY);
        var click = ClickAlive(now);
        var scroll = ScrollAlive(now);
        var badge = BadgeAlive(now);
        var tipScreenX = Gliding ? CursorX : TargetX;
        var tipScreenY = Gliding ? CursorY : TargetY;
        Hovering = PointerHit(tipScreenX, tipScreenY, scale) || (Hovering && NameHit(tipScreenX, tipScreenY, scale));
        if (Hovering) HoldUntil = now + DwellMs;
        var pad = (int)Math.Ceiling(64f * scale);
        var labelH = Hovering ? (int)Math.Ceiling(42f * scale) : 0;
        MeasureBadge(scale, badge, out var badgeW, out var badgeH);
        Direction(ScrollDelta, ScrollHorizontal, out var scrollDx, out var scrollDy);
        var reach = scroll ? (int)Math.Ceiling((52f + Math.Min(ScrollNotches, 8) * 4f) * scale) : 0;
        var extraLeft = scroll && scrollDx < 0 ? reach : 0;
        var extraUp = scroll && scrollDy < 0 ? reach : 0;
        var extraRight = (badge ? (int)Math.Ceiling(20 * scale) + badgeW : 0) + (scroll && scrollDx > 0 ? reach : 0);
        var extraBottom = (badge ? (int)Math.Ceiling(22 * scale) + badgeH : 0) + (scroll && scrollDy > 0 ? reach : 0);
        var left = pad + extraLeft;
        var top = pad + extraUp + labelH;
        var width = Math.Clamp(left + Math.Max(pad, extraRight + 12), 48, 720);
        var height = Math.Clamp(top + Math.Max(pad, extraBottom + 12), 48, 420);
        using var bmp = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            g.Clear(Color.Transparent);
            var tipX = left;
            var tipY = top;
            if (!Gliding && click) DrawRings(g, tipX, tipY, scale, (now - ClickStart) / 1000f, click: true);
            if (!Gliding && scroll) DrawScroll(g, tipX, tipY, scale, (now - ScrollStart) / 1000f);
            DrawPointer(g, tipX, tipY, scale, click ? Press((now - ClickStart) / 1000f) : 0f, Gliding ? 0.92f : 1f, PointerDegrees());
            if (Hovering) DrawPluginName(g, tipX, tipY, scale);
            if (!Gliding && badge)
                DrawBadge(g, tipX + 18 * scale, tipY + 20 * scale, scale, (now - BadgeStart) / 1000f);
        }
        var originX = (int)Math.Round(tipScreenX - left);
        var originY = (int)Math.Round(tipScreenY - top);
        Present(bmp, originX, originY);
    }

    static float PointerDegrees()
    {
        var rest = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
        var delta = Heading - rest;
        while (delta > MathF.PI) delta -= MathF.PI * 2f;
        while (delta < -MathF.PI) delta += MathF.PI * 2f;
        return delta * (180f / MathF.PI);
    }

    static bool PointerHit(float tipX, float tipY, float scale)
    {
        if (!TryCursor(out var x, out var y)) return false;
        var x0 = tipX - 12f * scale;
        var y0 = tipY - 10f * scale;
        var x1 = tipX + 30f * scale;
        var y1 = tipY + 36f * scale;
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    }

    static bool NameHit(float tipX, float tipY, float scale)
    {
        if (!TryCursor(out var x, out var y)) return false;
        var width = 86f * scale;
        var height = 28f * scale;
        var left = tipX - 8f * scale;
        var top = tipY - height - 12f * scale;
        return x >= left && x <= left + width && y >= top && y <= tipY;
    }

    static bool TryCursor(out int x, out int y)
    {
        if (GetCursorPos(out var pt))
        {
            x = pt.X;
            y = pt.Y;
            return true;
        }
        x = 0;
        y = 0;
        return false;
    }

    static void DrawPluginName(Graphics g, float tipX, float tipY, float scale)
    {
        using var font = MakeFont(12f * scale, FontStyle.Regular);
        var size = g.MeasureString(PluginName, font);
        var width = size.Width + 16f * scale;
        var height = Math.Max(24f * scale, size.Height + 8f * scale);
        var x = tipX - 6f * scale;
        var y = tipY - height - 8f * scale;
        using var shadow = RoundRect(new RectangleF(x, y + 3f * scale, width, height), 12f * scale);
        using var body = RoundRect(new RectangleF(x, y, width, height), 12f * scale);
        using var shadowBrush = new SolidBrush(Color.FromArgb(50, 0, 0, 0));
        using var fill = new SolidBrush(Color.FromArgb(236, 18, 24, 34));
        using var text = new SolidBrush(Color.FromArgb(245, 244, 248, 252));
        g.FillPath(shadowBrush, shadow);
        g.FillPath(fill, body);
        g.DrawString(PluginName, font, text, x + 8f * scale, y + (height - size.Height) / 2f - 1f);
    }

    static void DrawPointer(Graphics g, float x, float y, float scale, float press, float alpha, float degrees)
    {
        var s = scale * (1f - 0.14f * press);
        var state = g.Save();
        g.TranslateTransform(x, y);
        g.RotateTransform(degrees);
        g.ScaleTransform(s, s);
        using var glow = new SolidBrush(Color.FromArgb((int)(78 * alpha), 70, 214, 255));
        g.FillEllipse(glow, -16, -12, 34, 34);
        using var shadow = new SolidBrush(Color.FromArgb((int)(54 * alpha), 12, 22, 36));
        using var shadowPath = PointerPath();
        g.TranslateTransform(1.4f, 2.2f);
        g.FillPath(shadow, shadowPath);
        g.TranslateTransform(-1.4f, -2.2f);
        using var fill = new SolidBrush(Color.FromArgb((int)(245 * alpha), 248, 252, 255));
        using var edge = new Pen(Color.FromArgb((int)(230 * alpha), 46, 196, 255), 2.4f)
        {
            LineJoin = LineJoin.Round,
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
        };
        using var path = PointerPath();
        g.DrawPath(edge, path);
        g.FillPath(fill, path);
        g.Restore(state);
    }

    static GraphicsPath PointerPath()
    {
        var path = new GraphicsPath();
        path.AddLines([
            new PointF(1.2f, 1.2f),
            new PointF(1.2f, 18.5f),
            new PointF(6.2f, 14.4f),
            new PointF(10.2f, 22.6f),
            new PointF(13.4f, 21.1f),
            new PointF(9.3f, 13.1f),
            new PointF(16.2f, 12.6f),
        ]);
        path.CloseFigure();
        return path;
    }

    static void DrawRings(Graphics g, float x, float y, float scale, float seconds, bool click)
    {
        DrawRing(g, x, y, scale, seconds, 0f, click ? Color.FromArgb(120, 230, 255) : Color.FromArgb(255, 196, 90));
        DrawRing(g, x, y, scale, seconds, 0.07f, Color.FromArgb(255, 255, 255));
    }

    static void DrawRing(Graphics g, float x, float y, float scale, float seconds, float delay, Color color)
    {
        var u = (seconds - delay) / 0.44f;
        if (u is < 0 or > 1) return;
        var eased = EaseOut(u);
        var radius = (7f + 40f * eased) * scale;
        var alpha = (int)((1f - eased) * color.A);
        if (alpha <= 0) return;
        using var pen = new Pen(Color.FromArgb(alpha, color), 2.2f * scale);
        g.DrawEllipse(pen, x - radius, y - radius, radius * 2, radius * 2);
    }

    static void DrawScroll(Graphics g, float x, float y, float scale, float seconds)
    {
        if (seconds >= 0.68f) return;
        Direction(ScrollDelta, ScrollHorizontal, out var dx, out var dy);
        var travel = (26f + Math.Min(ScrollNotches, 8) * 3f) * scale;
        using var pen = new Pen(Color.FromArgb(230, 255, 186, 72), 3.4f * scale)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };
        for (var wave = 0; wave < 2; wave++)
        {
            var local = seconds - wave * 0.18f;
            if (local < 0) continue;
            var u = local / 0.46f;
            if (u >= 1) continue;
            var eased = EaseOut(u);
            var alphaBase = u < 0.62f ? 1f : (1f - u) / 0.38f;
            for (var i = 0; i < 3; i++)
            {
                var along = 14f * scale + eased * travel + i * 12f * scale;
                var fade = (1f - i * 0.2f) * alphaBase;
                pen.Color = Color.FromArgb((int)(235 * fade), 255, 186, 72);
                DrawChevron(g, pen, x + dx * along, y + dy * along, dx, dy, 9f * scale);
            }
        }
    }

    static void DrawChevron(Graphics g, Pen pen, float x, float y, float dx, float dy, float size)
    {
        var px = -dy;
        var py = dx;
        var tail = size * 0.95f;
        g.DrawLines(pen, [
            new PointF(x - dx * tail + px * size, y - dy * tail + py * size),
            new PointF(x + dx * size * 0.35f, y + dy * size * 0.35f),
            new PointF(x - dx * tail - px * size, y - dy * tail - py * size),
        ]);
    }

    static void DrawBadge(Graphics g, float x, float y, float scale, float seconds)
    {
        var pop = EaseOutBack(Math.Clamp(seconds / 0.2f, 0f, 1f));
        var life = BadgeHoldMs / 1000f;
        var fadeStart = Math.Max(0.35f, life - 0.28f);
        var fade = seconds < fadeStart ? 1f : 1f - (seconds - fadeStart) / 0.24f;
        if (fade <= 0) return;
        var alpha = Math.Clamp(fade, 0f, 1f);
        var rise = (1f - Math.Clamp(pop, 0f, 1f)) * 8f * scale;
        using var font = MakeFont(13f * scale, FontStyle.Regular);
        if (BadgeIsKeys) DrawKeycaps(g, x, y + rise, scale, alpha, pop, font);
        else DrawTextPill(g, x, y + rise, scale, alpha, pop, font);
    }

    static void DrawKeycaps(Graphics g, float x, float y, float scale, float alpha, float pop, Font font)
    {
        var gap = 6f * scale;
        var plus = 10f * scale;
        var chips = BadgeChips;
        var width = 0f;
        var sizes = new SizeF[chips.Length];
        for (var i = 0; i < chips.Length; i++)
        {
            sizes[i] = g.MeasureString(chips[i], font);
            width += sizes[i].Width + 16f * scale;
            if (i > 0) width += gap + plus;
        }
        var height = 30f * scale;
        var state = g.Save();
        g.TranslateTransform(x + width / 2f, y + height / 2f);
        g.ScaleTransform(0.9f + 0.1f * Math.Clamp(pop, 0f, 1.08f), 0.9f + 0.1f * Math.Clamp(pop, 0f, 1.08f));
        g.TranslateTransform(-width / 2f, -height / 2f);
        var cursor = 0f;
        for (var i = 0; i < chips.Length; i++)
        {
            if (i > 0)
            {
                using var plusBrush = new SolidBrush(Color.FromArgb((int)(160 * alpha), 186, 198, 214));
                g.DrawString("+", font, plusBrush, cursor, 6f * scale);
                cursor += plus + gap;
            }
            var chipW = sizes[i].Width + 16f * scale;
            var chipPop = EaseOutBack(Math.Clamp((pop - i * 0.08f) / 0.92f, 0f, 1f));
            var chipAlpha = alpha * Math.Clamp(chipPop, 0f, 1f);
            using var shadowPath = RoundRect(new RectangleF(cursor, 3f * scale, chipW, height), 9f * scale);
            using var path = RoundRect(new RectangleF(cursor, 0, chipW, height), 9f * scale);
            using var shadow = new SolidBrush(Color.FromArgb((int)(40 * chipAlpha), 0, 0, 0));
            g.FillPath(shadow, shadowPath);
            using var fill = new SolidBrush(Color.FromArgb((int)(245 * chipAlpha), 244, 247, 252));
            g.FillPath(fill, path);
            using var text = new SolidBrush(Color.FromArgb((int)(255 * chipAlpha), 24, 32, 44));
            var tx = cursor + (chipW - sizes[i].Width) / 2f;
            var ty = (height - sizes[i].Height) / 2f - 1f;
            g.DrawString(chips[i], font, text, tx, ty);
            cursor += chipW + gap;
        }
        g.Restore(state);
    }

    static void DrawTextPill(Graphics g, float x, float y, float scale, float alpha, float pop, Font font)
    {
        var size = g.MeasureString(BadgeText, font);
        var view = BadgeScroll ? Math.Min(size.Width, 168f * scale) : size.Width;
        var width = view + 22f * scale;
        var height = Math.Max(32f * scale, size.Height + 12f * scale);
        var state = g.Save();
        g.TranslateTransform(x + width / 2f, y + height / 2f);
        g.ScaleTransform(0.92f + 0.08f * Math.Clamp(pop, 0f, 1.06f), 0.92f + 0.08f * Math.Clamp(pop, 0f, 1.06f));
        g.TranslateTransform(-width / 2f, -height / 2f);
        using var shadow = RoundRect(new RectangleF(0, 4f * scale, width, height), 16f * scale);
        using var body = RoundRect(new RectangleF(0, 0, width, height), 16f * scale);
        using var shadowBrush = new SolidBrush(Color.FromArgb((int)(48 * alpha), 0, 0, 0));
        using var fill = new SolidBrush(Color.FromArgb((int)(232 * alpha), 22, 28, 38));
        using var edge = new Pen(Color.FromArgb((int)(48 * alpha), 255, 255, 255), 1f * scale);
        g.FillPath(shadowBrush, shadow);
        g.FillPath(fill, body);
        g.DrawPath(edge, body);
        using var text = new SolidBrush(Color.FromArgb((int)(245 * alpha), 244, 248, 252));
        var textX = 11f * scale;
        if (BadgeScroll)
        {
            var travel = Math.Max(0f, size.Width - view + 8f * scale);
            var life = BadgeHoldMs / 1000f;
            var span = Math.Max(0.45f, life - 0.42f);
            var u = Math.Clamp((nowSeconds() - 0.12f) / span, 0f, 1f);
            textX -= u * travel;
            g.SetClip(body);
        }
        g.DrawString(BadgeText, font, text, textX, (height - size.Height) / 2f - 1f);
        g.Restore(state);

        float nowSeconds() => BadgeStart == 0 ? 0f : (Now() - BadgeStart) / 1000f;
    }

    static void MeasureBadge(float scale, bool badge, out int width, out int height)
    {
        width = 0;
        height = 0;
        if (!badge) return;
        using var font = MakeFont(13f * scale, FontStyle.Regular);
        using var bmp = new Bitmap(1, 1);
        using var g = Graphics.FromImage(bmp);
        if (BadgeIsKeys)
        {
            var total = 0f;
            foreach (var chip in BadgeChips)
                total += g.MeasureString(chip, font).Width + 16f * scale + 16f * scale;
            width = (int)Math.Ceiling(total);
            height = (int)Math.Ceiling(34f * scale);
            return;
        }
        var size = g.MeasureString(BadgeText, font);
        var view = BadgeScroll ? Math.Min(size.Width, 168f * scale) : size.Width;
        width = (int)Math.Ceiling(view + 22f * scale);
        height = (int)Math.Ceiling(Math.Max(32f * scale, size.Height + 12f * scale));
    }

    static GraphicsPath RoundRect(RectangleF rect, float radius)
    {
        var path = new GraphicsPath();
        var d = Math.Min(radius * 2f, Math.Min(rect.Width, rect.Height));
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    static Font MakeFont(float px, FontStyle style)
    {
        try { return new Font("Microsoft YaHei UI", Math.Max(8f, px), style, GraphicsUnit.Pixel); }
        catch { return new Font(FontFamily.GenericSansSerif, Math.Max(8f, px), style, GraphicsUnit.Pixel); }
    }

    static void Present(Bitmap bmp, int x, int y)
    {
        var screen = GetDC(IntPtr.Zero);
        var mem = CreateCompatibleDC(screen);
        IntPtr dib = IntPtr.Zero;
        IntPtr old = IntPtr.Zero;
        try
        {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
            try
            {
                var info = new BITMAPINFO();
                info.biSize = 40;
                info.biWidth = bmp.Width;
                info.biHeight = -bmp.Height;
                info.biPlanes = 1;
                info.biBitCount = 32;
                dib = CreateDIBSection(screen, ref info, 0, out var bits, IntPtr.Zero, 0);
                if (dib == IntPtr.Zero) return;
                var rowBytes = bmp.Width * 4;
                for (var row = 0; row < bmp.Height; row++)
                    CopyMemory(bits + row * rowBytes, data.Scan0 + row * data.Stride, rowBytes);
            }
            finally { bmp.UnlockBits(data); }
            old = SelectObject(mem, dib);
            var size = new SIZE { cx = bmp.Width, cy = bmp.Height };
            var src = new POINT();
            var dst = new POINT { X = x, Y = y };
            var blend = new BLENDFUNCTION { BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
            UpdateLayeredWindow(Hwnd, screen, ref dst, ref size, mem, ref src, 0, ref blend, ULW_ALPHA);
            if (!Visible)
            {
                ShowWindow(Hwnd, SW_SHOWNOACTIVATE);
                Visible = true;
            }
        }
        finally
        {
            if (old != IntPtr.Zero) SelectObject(mem, old);
            if (dib != IntPtr.Zero) DeleteObject(dib);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    static void Hide()
    {
        HasCursor = false;
        Hovering = false;
        Heading = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
        if (!Visible || Hwnd == IntPtr.Zero) return;
        ShowWindow(Hwnd, SW_HIDE);
        Visible = false;
    }

    static void StartTimer()
    {
        if (TimerOn) return;
        SetTimer(Hwnd, 1, 16, IntPtr.Zero);
        TimerOn = true;
    }

    static void StopTimer()
    {
        if (!TimerOn) return;
        KillTimer(Hwnd, 1);
        TimerOn = false;
    }

    static bool ClickAlive(long now) => ClickStart != 0 && now - ClickStart < 520;
    static bool ScrollAlive(long now) => ScrollStart != 0 && now - ScrollStart < 700;
    static bool BadgeAlive(long now) => (BadgeChips.Length > 0 || BadgeText.Length > 0) && BadgeStart != 0 && now - BadgeStart < BadgeHoldMs;

    static float Press(float seconds)
    {
        if (seconds < 0 || seconds > 0.42f) return 0;
        if (seconds < 0.08f) return seconds / 0.08f;
        return 1f - (seconds - 0.08f) / 0.34f;
    }

    static float EaseOut(float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        var inv = 1f - t;
        return 1f - inv * inv * inv;
    }

    static float EaseOutBack(float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        const float c1 = 1.70158f;
        const float c3 = c1 + 1f;
        var p = t - 1f;
        return 1f + c3 * p * p * p + c1 * p * p;
    }

    static void Direction(int delta, bool horizontal, out float dx, out float dy)
    {
        var sign = Math.Sign(delta);
        if (horizontal) { dx = sign; dy = 0; }
        else { dx = 0; dy = -sign; }
    }

    static float ScaleAt(int x, int y)
    {
        try
        {
            var monitor = MonitorFromPoint(new POINT { X = x, Y = y }, 2);
            if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 && dpi >= 96)
                return dpi / 96f;
        }
        catch { /* 拿不到 DPI 时按 100% */ }
        return 1f;
    }

    static long Now() => Environment.TickCount64;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
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
    struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SIZE
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFO
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern ushort RegisterClass(ref WNDCLASS lpWndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG msg);

    [DllImport("user32.dll")]
    static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr proc);

    [DllImport("user32.dll")]
    static extern bool KillTimer(IntPtr hwnd, IntPtr id);

    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("user32.dll")]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, uint colorKey, ref BLENDFUNCTION blend, uint flags);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO info, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string? name);

    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")]
    static extern void CopyMemory(IntPtr dest, IntPtr src, int length);

    [DllImport("shcore.dll")]
    static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
}
