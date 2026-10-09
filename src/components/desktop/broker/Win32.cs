using System.Runtime.InteropServices;
using System.Text;

namespace DSHDesktopBroker;

/// <summary>前台确认、SendInput、完整性与截图。坐标是 Per-Monitor V2 下的物理像素。</summary>
static class Win32
{
    public const int IntegrityMedium = 0x2000;
    public const int IntegrityHigh = 0x3000;

    const uint TOKEN_QUERY = 0x0008;
    const int TokenIntegrityLevel = 25;
    const int TokenUIAccess = 26;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int GA_ROOT = 2;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;
    const int DWMWA_CLOAKED = 14;
    const uint PW_RENDERFULLCONTENT = 2;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP = 0x0101;
    public const int WM_CHAR = 0x0102;

    public static bool SelfHasUiAccess { get; } = ReadUiAccess(GetCurrentProcess());
    public static int SelfIntegrity { get; } = ReadIntegrity(GetCurrentProcess());

    public static string IntegrityName(int rid) => rid switch
    {
        >= 0x4000 => "system",
        >= IntegrityHigh => "high",
        >= IntegrityMedium => "medium",
        >= 0x1000 => "low",
        > 0 => "untrusted",
        _ => "unknown",
    };

    public static int ProcessIntegrity(int pid)
    {
        if (pid <= 0) return 0;
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (handle == IntPtr.Zero) return 0;
        try { return ReadIntegrity(handle); }
        finally { CloseHandle(handle); }
    }

    public static bool IsHigherThanSelf(int pid)
    {
        var rid = ProcessIntegrity(pid);
        return rid > 0 && SelfIntegrity > 0 && rid > SelfIntegrity;
    }

    public static string ClassName(IntPtr hwnd)
    {
        var buf = new StringBuilder(256);
        _ = GetClassName(hwnd, buf, buf.Capacity);
        return buf.ToString();
    }

    public static string WindowText(IntPtr hwnd)
    {
        var len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        var buf = new StringBuilder(len + 1);
        _ = GetWindowText(hwnd, buf, buf.Capacity);
        return buf.ToString();
    }

    public static int WindowPid(IntPtr hwnd)
    {
        _ = GetWindowThreadProcessId(hwnd, out var pid);
        return (int)pid;
    }

    public static bool IsCloaked(IntPtr hwnd)
    {
        try
        {
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out var cloaked, sizeof(int)) != 0) return false;
            return cloaked != 0;
        }
        catch { return false; }
    }

    public static List<IntPtr> TopLevelWindows()
    {
        var list = new List<IntPtr>();
        EnumWindows((hwnd, _) =>
        {
            if (IsWindowVisible(hwnd) && !IsCloaked(hwnd)) list.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static IntPtr FindRenderWidget(IntPtr root)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(root, (hwnd, _) =>
        {
            if (ClassName(hwnd) == "Chrome_RenderWidgetHostHWND")
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool IsChromiumTop(IntPtr hwnd, IntPtr renderWidget) =>
        renderWidget != IntPtr.Zero || ClassName(hwnd).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal);

    public static bool TryGetRect(IntPtr hwnd, out BoundsRect rect)
    {
        rect = default;
        if (!GetWindowRect(hwnd, out var r)) return false;
        rect = new BoundsRect(r.Left, r.Top, Math.Max(0, r.Right - r.Left), Math.Max(0, r.Bottom - r.Top));
        return rect.Width > 0 && rect.Height > 0;
    }

    /// <summary>目标或其拥有者必须成为前台。失败时调用方不得发 SendInput。不最小化其它窗口。</summary>
    public static bool ConfirmForeground(IntPtr target)
    {
        if (target == IntPtr.Zero) return false;
        if (IsForeground(target)) return true;
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        _ = SetForegroundWindow(target);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(80);
        return IsForeground(target);
    }

    public static bool IsForeground(IntPtr target)
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || target == IntPtr.Zero) return false;
        if (fg == target) return true;
        if (GetAncestor(fg, GA_ROOT) == target) return true;
        if (GetAncestor(target, GA_ROOT) == fg) return true;
        return false;
    }

    public static IntPtr RootFromPoint(int x, int y)
    {
        var hwnd = WindowFromPoint(new POINT { X = x, Y = y });
        if (hwnd == IntPtr.Zero) return IntPtr.Zero;
        var root = GetAncestor(hwnd, GA_ROOT);
        return root == IntPtr.Zero ? hwnd : root;
    }

    public static void Click(int x, int y)
    {
        var (ax, ay) = ToAbsolute(x, y);
        const uint flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        var inputs = new[]
        {
            Mouse(ax, ay, MOUSEEVENTF_MOVE | flags),
            Mouse(ax, ay, MOUSEEVENTF_LEFTDOWN | flags),
            Mouse(ax, ay, MOUSEEVENTF_LEFTUP | flags),
        };
        _ = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void TypeUnicode(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        var inputs = new INPUT[text.Length * 2];
        var n = 0;
        foreach (var ch in text)
        {
            inputs[n++] = KeyScan(ch, down: true);
            inputs[n++] = KeyScan(ch, down: false);
        }
        _ = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    public static bool TryVirtualKey(string name, out ushort vk) =>
        (vk = name.Trim().ToLowerInvariant() switch
        {
            "enter" or "return" => 0x0D,
            "tab" => 0x09,
            "backspace" => 0x08,
            "delete" or "del" => 0x2E,
            "escape" or "esc" => 0x1B,
            "left" => 0x25,
            "up" => 0x26,
            "right" => 0x27,
            "down" => 0x28,
            "space" => 0x20,
            _ => 0,
        }) != 0;

    public static void KeyPress(ushort vk, int times)
    {
        times = Math.Clamp(times, 1, 20);
        var inputs = new INPUT[times * 2];
        for (var i = 0; i < times; i++)
        {
            inputs[i * 2] = KeyVk(vk, up: false);
            inputs[i * 2 + 1] = KeyVk(vk, up: true);
        }
        _ = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void PostChars(IntPtr hwnd, string text)
    {
        foreach (var ch in text)
            _ = PostMessage(hwnd, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
    }

    public static void PostKey(IntPtr hwnd, ushort vk, int times)
    {
        times = Math.Clamp(times, 1, 20);
        for (var i = 0; i < times; i++)
        {
            _ = PostMessage(hwnd, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
            _ = PostMessage(hwnd, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
        }
    }

    public static byte[]? CaptureWindow(IntPtr hwnd)
    {
        if (!TryGetRect(hwnd, out var rect)) return null;
        return Capture(rect.Width, rect.Height, (g, hdc) =>
        {
            if (!PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT))
                g.CopyFromScreen(rect.X, rect.Y, 0, 0, new System.Drawing.Size(rect.Width, rect.Height), System.Drawing.CopyPixelOperation.SourceCopy);
        });
    }

    public static byte[]? CaptureScreen()
    {
        var x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        var h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (w <= 0 || h <= 0) return null;
        return Capture(w, h, (g, _) =>
            g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h), System.Drawing.CopyPixelOperation.SourceCopy));
    }

    static byte[]? Capture(int width, int height, Action<System.Drawing.Graphics, IntPtr> draw)
    {
        if (width <= 0 || height <= 0 || width > 10000 || height > 10000) return null;
        using var bmp = new System.Drawing.Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try { draw(g, hdc); }
            finally { g.ReleaseHdc(hdc); }
        }
        using var ms = new MemoryStream();
        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        return ms.ToArray();
    }

    static bool ReadUiAccess(IntPtr process)
    {
        if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return false;
        try
        {
            var buffer = Marshal.AllocHGlobal(4);
            try
            {
                if (!GetTokenInformation(token, TokenUIAccess, buffer, 4, out _)) return false;
                return Marshal.ReadInt32(buffer) != 0;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    static int ReadIntegrity(IntPtr process)
    {
        if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return 0;
        try
        {
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out var needed);
            if (needed <= 0) return 0;
            var buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, needed, out _)) return 0;
                var sid = Marshal.ReadIntPtr(buffer);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) return 0;
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    static (int X, int Y) ToAbsolute(int x, int y)
    {
        var vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        var vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (vw <= 1 || vh <= 1) return (0, 0);
        var ax = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
        var ay = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
        return (Math.Clamp(ax, 0, 65535), Math.Clamp(ay, 0, 65535));
    }

    static INPUT Mouse(int x, int y, uint flags) => new()
    {
        Type = 0,
        U = new INPUTUNION { mi = new MOUSEINPUT { dx = x, dy = y, dwFlags = flags } },
    };

    static INPUT KeyScan(char ch, bool down) => new()
    {
        Type = 1,
        U = new INPUTUNION
        {
            ki = new KEYBDINPUT
            {
                wScan = ch,
                dwFlags = KEYEVENTF_UNICODE | (down ? 0 : KEYEVENTF_KEYUP),
            },
        },
    };

    static INPUT KeyVk(ushort vk, bool up) => new()
    {
        Type = 1,
        U = new INPUTUNION
        {
            ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0 },
        },
    };

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public int Type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X, Y;
    }

    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buffer, int length, out int retLen);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
}

readonly record struct BoundsRect(int X, int Y, int Width, int Height)
{
    public int CenterX => X + Width / 2;
    public int CenterY => Y + Height / 2;
    public bool IsEmpty => Width <= 0 || Height <= 0;
}
