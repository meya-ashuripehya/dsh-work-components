namespace DSHDesktopBroker;

/// <summary>
/// 微信小程序窗口（WeChatAppEx / Chrome_WidgetWin_0）有时打开后一直隐藏（微信自身行为：关闭的小程序窗口隐藏留存复用，
/// 再次打开偶尔不重新显示）。list_windows 只列可见窗口，模型看不到它；这里把这类窗口报出来，并提供 reveal_window 显示。
/// 只显示，从不隐藏、关闭或结束别的程序的窗口。
/// </summary>
static partial class DesktopSession
{
    internal static List<IntPtr> HiddenMiniProgramWindows()
    {
        var list = new List<IntPtr>();
        foreach (var h in Win32.AllTopLevelWindows())
        {
            if (Win32.IsVisible(h)) continue;
            if (Win32.ClassName(h) != "Chrome_WidgetWin_0") continue;
            if (Win32.WindowText(h).Length == 0) continue;
            if (!string.Equals(Win32.ProcessNameOf(h), "WeChatAppEx", StringComparison.OrdinalIgnoreCase)) continue;
            list.Add(h);
        }
        return list;
    }

    static object[] HiddenMiniProgramInfo() => HiddenMiniProgramWindows()
        .Select(h => (object)new { hwnd = FormatHwnd(h), title = Trim(Win32.WindowText(h), 100) })
        .ToArray();

    public static string RevealWindow(string hwnd, string title) => Sta.Call(() =>
    {
        var targets = new List<IntPtr>();
        if (!string.IsNullOrWhiteSpace(hwnd))
        {
            if (!TryParseHwnd(hwnd, out var h) || !Win32.IsWindow(h)) return Json(new { ok = false, reason = "hwnd 无效。" });
            targets.Add(h);
        }
        else
        {
            var q = (title ?? "").Trim();
            foreach (var h in Win32.AllTopLevelWindows())
            {
                var t = Win32.WindowText(h);
                if (t.Length == 0) continue;
                if (q.Length > 0 ? t.Contains(q, StringComparison.OrdinalIgnoreCase) && (!Win32.IsVisible(h) || Win32.IsMinimized(h))
                                 : HiddenMiniProgramWindows().Contains(h))
                    targets.Add(h);
            }
            if (targets.Count == 0)
                return Json(new { ok = false, reason = q.Length > 0 ? "没有找到标题包含该文字的隐藏或最小化窗口。" : "没有隐藏的小程序窗口。" });
        }
        var results = new List<object>();
        foreach (var h in targets.Take(5))
        {
            var ok = Win32.Reveal(h);
            Win32.TryGetRect(h, out var b);
            results.Add(new { hwnd = FormatHwnd(h), title = Trim(Win32.WindowText(h), 100), visible = Win32.IsVisible(h), ok, bounds = b });
        }
        return Json(new { ok = results.Count > 0, windows = results });
    });
}