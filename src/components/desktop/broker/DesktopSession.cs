using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

namespace DSHDesktopBroker;

static class DesktopSession
{
    const int MaxNodes = 250;
    const int MaxDepth = 8;
    const string Stale = "元素引用已过期或不存在，请重新 inspect。";
    const string ForegroundBlocked = "前台没有切到目标窗口，已取消操作。";

    static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    static UIA3Automation? _automation;
    static Cache _cache = new();

    static UIA3Automation Automation => _automation ??= new UIA3Automation();

    public static string Status() => Sta.Call(() =>
    {
        var integrity = Win32.IntegrityName(Win32.SelfIntegrity);
        string? warning = Win32.SelfIntegrity >= Win32.IntegrityHigh
            ? "本进程完整性偏高，中等完整性窗口可能点不准。"
            : null;
        return Json(new
        {
            ok = true,
            path = Environment.ProcessPath,
            uiAccess = Win32.SelfHasUiAccess,
            integrity,
            integrityWarning = warning,
        });
    });

    public static string ListWindows() => Sta.Call(() =>
    {
        var windows = new List<object>();
        foreach (var hwnd in Win32.TopLevelWindows())
        {
            if (windows.Count >= 80) break;
            var title = Win32.WindowText(hwnd);
            if (title.Length == 0) continue;
            var pid = Win32.WindowPid(hwnd);
            Win32.TryGetRect(hwnd, out var bounds);
            windows.Add(new
            {
                hwnd = FormatHwnd(hwnd),
                title = Trim(title, 200),
                className = Win32.ClassName(hwnd),
                pid,
                integrity = Win32.IntegrityName(Win32.ProcessIntegrity(pid)),
                bounds = bounds.IsEmpty ? (BoundsRect?)null : bounds,
            });
        }
        return Json(new { ok = true, windows });
    });

    public static string Inspect(string hwnd, string title) => Sta.Call(() =>
    {
        if (!ResolveWindow(hwnd, title, out var top, out var error))
            return Json(new { ok = false, reason = error });
        var host = Win32.FindRenderWidget(top);
        var chromiumTop = Win32.IsChromiumTop(top, host);
        var nodes = new List<Node>();
        var seen = new HashSet<string>();
        var topEl = FromHwnd(top);
        var topError = _lastUiaError;
        string? hostError = null;
        if (topEl != null) Walk(topEl, top, host, chromiumTop, fromHost: false, 0, nodes, seen);
        if (host != IntPtr.Zero)
        {
            var hostEl = FromHwnd(host);
            hostError = _lastUiaError;
            if (hostEl != null) Walk(hostEl, top, host, chromiumTop, fromHost: true, 0, nodes, seen);
        }
        string? uiaError = nodes.Count == 0 ? topError ?? hostError ?? "没有读到控件。" : null;
        var generation = _cache.Generation + 1;
        var items = new Dictionary<string, CachedElement>(StringComparer.Ordinal);
        var elements = new List<object>(nodes.Count);
        for (var i = 0; i < nodes.Count; i++)
        {
            var node = nodes[i];
            var refId = generation + ":" + i;
            node.Cached.Ref = refId;
            items[refId] = node.Cached;
            elements.Add(new
            {
                @ref = refId,
                name = node.Name,
                controlType = node.ControlType,
                className = node.ClassName,
                bounds = node.Cached.HasBounds ? node.Cached.Bounds : (BoundsRect?)null,
                patterns = node.Patterns,
                chromiumEdit = node.Cached.IsChromiumEdit,
            });
        }
        _cache = new Cache { Generation = generation, Items = items };
        return Json(new
        {
            ok = true,
            hwnd = FormatHwnd(top),
            title = Win32.WindowText(top),
            chromiumHostFound = host != IntPtr.Zero,
            uiaError,
            elements,
        });
    });

    public static string Invoke(string element) => Act(element, DesktopAction.Invoke, null, null, 1);
    public static string Type(string element, string text) => Act(element, DesktopAction.Type, text ?? "", null, 1);
    public static string Key(string element, string key, int times) => Act(element, DesktopAction.Key, null, key ?? "", times);
    public static string Click(string element) => Act(element, DesktopAction.Click, null, null, 1);
    public static string Scroll(string element, string direction, int notches) => Act(element, DesktopAction.Scroll, null, direction, notches);

    public static string ClickScreen(int x, int y, string hwnd) => Sta.Call(() =>
    {
        var top = IntPtr.Zero;
        if (!string.IsNullOrWhiteSpace(hwnd))
        {
            if (!TryParseHwnd(hwnd, out top))
                return Json(Fail("hwnd 无法解析。"));
        }
        else top = Win32.RootFromPoint(x, y);
        if (top == IntPtr.Zero) return Json(Fail("这个坐标上没有窗口。"));
        var pid = Win32.WindowPid(top);
        var decision = Router.Decide(new RouteInput
        {
            Action = DesktopAction.ClickScreen,
            TargetHigherIntegrity = Win32.IsHigherThanSelf(pid),
            SelfHasUiAccess = Win32.SelfHasUiAccess,
            HasBounds = true,
        });
        if (decision.Channel == RouteChannel.Deny)
            return Json(Fail(decision.Reason ?? Router.DenyHigherIntegrity, decision.Via));
        if (!Win32.ConfirmForeground(top))
            return Json(Fail(ForegroundBlocked, "sendinput"));
        ActionOverlay.ShowClick(x, y);
        Win32.Click(x, y);
        return Json(new { ok = true, confirmed = true, via = "sendinput", hwnd = FormatHwnd(top), x, y });
    });

    public static string ScrollScreen(int x, int y, string direction, int notches, string hwnd) => Sta.Call(() =>
    {
        if (!TryScrollDelta(direction, notches, out var delta, out var horizontal, out var why))
            return Json(Fail(why));
        var top = IntPtr.Zero;
        if (!string.IsNullOrWhiteSpace(hwnd))
        {
            if (!TryParseHwnd(hwnd, out top))
                return Json(Fail("hwnd 无法解析。"));
        }
        else top = Win32.RootFromPoint(x, y);
        if (top == IntPtr.Zero) return Json(Fail("这个坐标上没有窗口。"));
        var pid = Win32.WindowPid(top);
        var decision = Router.Decide(new RouteInput
        {
            Action = DesktopAction.ScrollScreen,
            TargetHigherIntegrity = Win32.IsHigherThanSelf(pid),
            SelfHasUiAccess = Win32.SelfHasUiAccess,
            HasBounds = true,
        });
        if (decision.Channel == RouteChannel.Deny)
            return Json(Fail(decision.Reason ?? Router.DenyHigherIntegrity, decision.Via));
        var host = Win32.FindRenderWidget(top);
        if (host != IntPtr.Zero)
        {
            var posted = Win32.PostWheel(host, x, y, delta, horizontal);
            if (posted) ActionOverlay.ShowScroll(x, y, delta, horizontal);
            return Json(new
            {
                ok = posted,
                confirmed = posted,
                via = "chromium",
                hwnd = FormatHwnd(top),
                x,
                y,
                reason = posted ? null : "滚轮消息没有送进内容子窗口。",
            });
        }
        if (!Win32.ConfirmForeground(top))
            return Json(Fail(ForegroundBlocked, "sendinput"));
        ActionOverlay.ShowScroll(x, y, delta, horizontal);
        Win32.Wheel(x, y, delta, horizontal);
        return Json(new { ok = true, confirmed = true, via = "sendinput", hwnd = FormatHwnd(top), x, y });
    });

    public static Shot? Capture(string hwnd) => Sta.Call<Shot?>(() =>
    {
        if (!string.IsNullOrWhiteSpace(hwnd))
        {
            if (!TryParseHwnd(hwnd, out var top)) return null;
            if (!Win32.TryGetRect(top, out var rect)) return null;
            var png = Win32.CaptureWindow(top);
            if (png == null) return null;
            return new Shot(png, rect.Width, rect.Height, $"窗口 {FormatHwnd(top)}，{rect.Width}×{rect.Height} 物理像素");
        }
        var screen = Win32.CaptureScreen();
        if (screen == null) return null;
        return new Shot(screen, 0, 0, "虚拟屏幕物理像素。自绘窗口没有控件树时，用 click_screen 点这里的坐标。");
    });

    static string Act(string element, DesktopAction action, string? text, string? key, int times) => Sta.Call(() =>
    {
        if (!_cache.Items.TryGetValue(element ?? "", out var item))
            return Json(Fail(Stale));
        if (action == DesktopAction.Scroll && !TryScrollDelta(key, times, out _, out _, out var why))
            return Json(Fail(why));
        var decision = Router.Decide(new RouteInput
        {
            Action = action,
            HasInvoke = item.HasInvoke,
            HasToggle = item.HasToggle,
            HasSelection = item.HasSelection,
            HasValue = item.HasValue,
            HasScroll = item.HasScroll,
            IsChromiumEdit = item.IsChromiumEdit,
            ChromiumHostFound = item.ChromiumHostFound,
            HasBounds = item.HasBounds,
            TargetHigherIntegrity = Win32.IsHigherThanSelf(item.Pid),
            SelfHasUiAccess = Win32.SelfHasUiAccess,
        });
        if (decision.Channel == RouteChannel.Deny)
            return Json(Fail(decision.Reason ?? Router.DenyNoWay, decision.Via));

        var el = Relocate(item);
        if (el == null) return Json(Fail(Stale, decision.Via));
        var before = ReadState(el);
        var outcome = decision.Channel switch
        {
            RouteChannel.Pattern => ApplyPattern(el, item, decision.Via, text, key, times),
            RouteChannel.Chromium => ApplyChromium(el, item, action, text, key, times),
            RouteChannel.SendInput or RouteChannel.SendInputFallback => ApplySendInput(el, item, action, decision.Via, text, key, times),
            _ => new Outcome(false, decision.Reason ?? Router.DenyNoWay),
        };
        var afterEl = Relocate(item) ?? el;
        var after = ReadState(afterEl);
    var confirmed = outcome.Confirmed;
    if (decision.Via == "toggle")
        confirmed = outcome.Ok && before.Toggle != null && after.Toggle != null && before.Toggle != after.Toggle;
    else if (action == DesktopAction.Type)
        confirmed = outcome.Ok && ContainsText(after.Value, text);
    else if (decision.Via == "selection")
        confirmed = outcome.Ok && after.Selected == true;
    else if (decision.Via == "invoke")
        confirmed = outcome.Ok;
        return Json(new
        {
            ok = outcome.Ok && confirmed,
            confirmed,
            via = decision.Via,
            reason = confirmed ? outcome.Reason : outcome.Reason ?? "操作后控件状态没有按预期变化。",
            before,
            after,
        });
    });

    static Outcome ApplyPattern(AutomationElement el, CachedElement item, string via, string? text, string? direction, int times)
    {
        try
        {
            if (via == "value")
            {
                el.Patterns.Value.Pattern.SetValue(text ?? "");
                Thread.Sleep(80);
                var again = Relocate(item);
                if (again != null && !ContainsText(TryValue(again), text))
                {
                    again.Patterns.Value.Pattern.SetValue(text ?? "");
                    Thread.Sleep(80);
                }
                return new Outcome(true, null);
            }
            if (via == "toggle")
            {
                el.Patterns.Toggle.Pattern.Toggle();
                return new Outcome(true, null);
            }
            if (via == "selection")
            {
                el.Patterns.SelectionItem.Pattern.Select();
                return new Outcome(true, null);
            }
            if (via == "scroll")
            {
                if (TryPoint(item, out var sx, out var sy) && TryScrollDelta(direction, times, out var scrollDelta, out var scrollHorizontal, out _))
                    ActionOverlay.ShowScroll(sx, sy, scrollDelta, scrollHorizontal);
                return ApplyScroll(el, direction, times);
            }
            el.Patterns.Invoke.Pattern.Invoke();
            return new Outcome(true, null);
        }
        catch (Exception ex)
        {
            return new Outcome(false, ex.Message);
        }
    }

    static Outcome ApplyScroll(AutomationElement el, string? direction, int times)
    {
        if (!TryScrollDelta(direction, times, out var delta, out var horizontal, out var why))
            return new Outcome(false, why);
        try
        {
            var pattern = el.Patterns.Scroll.Pattern;
            var beforeV = pattern.VerticalScrollPercent;
            var beforeH = pattern.HorizontalScrollPercent;
            var vertical = horizontal ? ScrollAmount.NoAmount : delta > 0 ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
            var across = horizontal ? delta > 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement : ScrollAmount.NoAmount;
            var notches = Math.Clamp(Math.Abs(delta) / 120, 1, 20);
            for (var i = 0; i < notches; i++)
                pattern.Scroll(across, vertical);
            Thread.Sleep(80);
            var afterV = pattern.VerticalScrollPercent;
            var afterH = pattern.HorizontalScrollPercent;
            var before = horizontal ? beforeH : beforeV;
            var after = horizontal ? afterH : afterV;
            if (before < 0 || after < 0)
                return new Outcome(false, "控件没有报告滚动位置。");
            var moved = ScrollMoved(before, after);
            return new Outcome(moved, moved ? null : "滚动位置没有变化。");
        }
        catch (Exception ex)
        {
            return new Outcome(false, ex.Message);
        }
    }

    static bool ScrollMoved(double before, double after) =>
        before >= 0 && after >= 0 && Math.Abs(after - before) > 0.01;

    static bool TryScrollDelta(string? direction, int notches, out int delta, out bool horizontal, out string error)
    {
        notches = Math.Clamp(notches, 1, 20);
        horizontal = false;
        var step = 120 * notches;
        switch ((direction ?? "").Trim().ToLowerInvariant())
        {
            case "up":
                delta = step;
                error = "";
                return true;
            case "down":
                delta = -step;
                error = "";
                return true;
            case "left":
                delta = -step;
                horizontal = true;
                error = "";
                return true;
            case "right":
                delta = step;
                horizontal = true;
                error = "";
                return true;
            default:
                delta = 0;
                error = "方向用 up、down、left、right。";
                return false;
        }
    }

    static bool TryPoint(CachedElement item, out int x, out int y)
    {
        if (item.HasBounds)
        {
            x = item.Bounds.CenterX;
            y = item.Bounds.CenterY;
            return true;
        }
        var hwnd = item.ChromiumHost != IntPtr.Zero ? item.ChromiumHost : item.Top;
        if (Win32.TryGetRect(hwnd, out var rect))
        {
            x = rect.CenterX;
            y = rect.CenterY;
            return true;
        }
        x = 0;
        y = 0;
        return false;
    }

    static Outcome ApplyChromium(AutomationElement el, CachedElement item, DesktopAction action, string? text, string? key, int times)
    {
        var host = item.ChromiumHost;
        if (host == IntPtr.Zero) return new Outcome(false, "没有 Chromium 内容子窗口。");
        if (action == DesktopAction.Scroll)
        {
            if (!TryScrollDelta(key, times, out var delta, out var horizontal, out var why))
                return new Outcome(false, why);
            if (!TryPoint(item, out var x, out var y))
                return new Outcome(false, Router.DenyNoWay);
            var posted = Win32.PostWheel(host, x, y, delta, horizontal);
            if (posted) ActionOverlay.ShowScroll(x, y, delta, horizontal);
            return new Outcome(posted, posted ? null : "滚轮消息没有送进内容子窗口。");
        }
        try { el.Focus(); } catch { /* 有的输入框不支持 SetFocus */ }
        Thread.Sleep(60);
        if (action == DesktopAction.Key)
        {
            if (!Win32.TryVirtualKey(key ?? "", out var vk))
                return new Outcome(false, "不认识的按键。可用 enter、tab、backspace、delete、escape、方向键、space。");
            if (TryPoint(item, out var keyX, out var keyY))
                ActionOverlay.ShowKey(keyX, keyY, key ?? "", times);
            Win32.PostKey(host, vk, times);
            return new Outcome(true, null);
        }
        if (TryPoint(item, out var typeX, out var typeY))
            ActionOverlay.ShowType(typeX, typeY, text ?? "");
        if (!PostAndSee(el, item, host, text ?? ""))
        {
            try { el.Focus(); } catch { }
            Thread.Sleep(60);
            PostAndSee(el, item, host, text ?? "");
        }
        return new Outcome(true, null);
    }

    static bool PostAndSee(AutomationElement el, CachedElement item, IntPtr host, string text)
    {
        Win32.PostChars(host, text);
        Thread.Sleep(280);
        var again = Relocate(item) ?? el;
        return ContainsText(TryValue(again), text);
    }

    static Outcome ApplySendInput(AutomationElement el, CachedElement item, DesktopAction action, string via, string? text, string? key, int times)
    {
        if (!item.HasBounds && action != DesktopAction.Key)
            return new Outcome(false, Router.DenyNoWay);
        if (!Win32.ConfirmForeground(item.Top))
            return new Outcome(false, ForegroundBlocked);
        if (action == DesktopAction.Key)
        {
            if (!Win32.TryVirtualKey(key ?? "", out var vk))
                return new Outcome(false, "不认识的按键。可用 enter、tab、backspace、delete、escape、方向键、space。");
            if (TryPoint(item, out var keyX, out var keyY))
                ActionOverlay.ShowKey(keyX, keyY, key ?? "", times);
            Win32.KeyPress(vk, times);
            return new Outcome(true, null);
        }
        if (action == DesktopAction.Click)
        {
            ActionOverlay.ShowClick(item.Bounds.CenterX, item.Bounds.CenterY);
            Win32.Click(item.Bounds.CenterX, item.Bounds.CenterY);
            return new Outcome(true, null);
        }
        if (action == DesktopAction.Scroll)
        {
            if (!TryScrollDelta(key, times, out var delta, out var horizontal, out var why))
                return new Outcome(false, why);
            ActionOverlay.ShowScroll(item.Bounds.CenterX, item.Bounds.CenterY, delta, horizontal);
            Win32.Wheel(item.Bounds.CenterX, item.Bounds.CenterY, delta, horizontal);
            return new Outcome(true, null);
        }
        var typed = TypeAt(item, text ?? "");
        if (!typed)
        {
            try { el.Focus(); } catch { }
            typed = TypeAt(item, text ?? "");
        }
        return new Outcome(typed, typed ? null : "已尝试输入，但读回的内容里没有这段文字。");
    }

    static bool TypeAt(CachedElement item, string text)
    {
        if (!Win32.ConfirmForeground(item.Top)) return false;
        ActionOverlay.ShowClick(item.Bounds.CenterX, item.Bounds.CenterY);
        Win32.Click(item.Bounds.CenterX, item.Bounds.CenterY);
        Thread.Sleep(80);
        ActionOverlay.ShowType(item.Bounds.CenterX, item.Bounds.CenterY, text);
        Win32.TypeUnicode(text);
        Thread.Sleep(280);
        var again = Relocate(item);
        if (again == null) return false;
        return ContainsText(TryValue(again), text);
    }

    static void Walk(AutomationElement el, IntPtr top, IntPtr host, bool chromiumTop, bool fromHost, int depth, List<Node> nodes, HashSet<string> seen)
    {
        if (nodes.Count >= MaxNodes || depth > MaxDepth) return;
        int[] runtimeId;
        try { runtimeId = el.Properties.RuntimeId.ValueOrDefault ?? []; }
        catch { runtimeId = []; }
        var key = string.Join(",", runtimeId);
        if (key.Length > 0 && !seen.Add(key)) return;

        ControlType controlType = ControlType.Custom;
        try { controlType = el.Properties.ControlType.ValueOrDefault; } catch { }
        var isEdit = controlType is ControlType.Edit or ControlType.Document;
        var chromiumEdit = isEdit && (fromHost || chromiumTop);
        var hasBounds = TryBounds(el, out var bounds);
        var cached = new CachedElement
        {
            RuntimeId = runtimeId,
            Top = top,
            ChromiumHost = host,
            IsChromiumEdit = chromiumEdit,
            ChromiumHostFound = host != IntPtr.Zero,
            HasInvoke = Supports(() => el.Patterns.Invoke.IsSupported),
            HasToggle = Supports(() => el.Patterns.Toggle.IsSupported),
            HasSelection = Supports(() => el.Patterns.SelectionItem.IsSupported),
            HasValue = Supports(() => el.Patterns.Value.IsSupported),
            HasScroll = Supports(() => el.Patterns.Scroll.IsSupported),
            HasBounds = hasBounds,
            Bounds = bounds,
            Pid = Win32.WindowPid(top),
        };
        string name;
        string className;
        try { name = Trim(el.Properties.Name.ValueOrDefault ?? "", 200); } catch { name = ""; }
        try { className = el.Properties.ClassName.ValueOrDefault ?? ""; } catch { className = ""; }
        var patterns = new List<string>();
        if (cached.HasInvoke) patterns.Add("invoke");
        if (cached.HasToggle) patterns.Add("toggle");
        if (cached.HasSelection) patterns.Add("selection");
        if (cached.HasValue) patterns.Add("value");
        if (cached.HasScroll) patterns.Add("scroll");
        nodes.Add(new Node(cached, name, controlType.ToString(), className, patterns));

        if (depth == MaxDepth) return;
        foreach (var child in Children(el))
            Walk(child, top, host, chromiumTop, fromHost, depth + 1, nodes, seen);
    }

    static AutomationElement[] Children(AutomationElement el)
    {
        try { return el.FindAllChildren(); }
        catch { return []; }
    }

    static AutomationElement? Relocate(CachedElement item)
    {
        var roots = new List<AutomationElement>();
        var top = FromHwnd(item.Top);
        if (top != null) roots.Add(top);
        if (item.ChromiumHost != IntPtr.Zero)
        {
            var host = FromHwnd(item.ChromiumHost);
            if (host != null) roots.Add(host);
        }
        foreach (var root in roots)
        {
            var hit = FindId(root, item.RuntimeId, 0);
            if (hit != null) return hit;
        }
        return null;
    }

    static AutomationElement? FindId(AutomationElement el, int[] runtimeId, int depth)
    {
        if (depth > MaxDepth) return null;
        try
        {
            var id = el.Properties.RuntimeId.ValueOrDefault;
            if (id != null && id.SequenceEqual(runtimeId)) return el;
        }
        catch { }
        foreach (var child in Children(el))
        {
            var hit = FindId(child, runtimeId, depth + 1);
            if (hit != null) return hit;
        }
        return null;
    }

    static ElementState ReadState(AutomationElement el)
    {
        string? toggle = null;
        bool? selected = null;
        try
        {
            if (el.Patterns.Toggle.IsSupported)
                toggle = el.Patterns.Toggle.Pattern.ToggleState.ToString();
        }
        catch { }
        try
        {
            if (el.Patterns.SelectionItem.IsSupported)
                selected = el.Patterns.SelectionItem.Pattern.IsSelected;
        }
        catch { }
        string? name = null;
        try { name = el.Properties.Name.ValueOrDefault; } catch { }
        return new ElementState(TryValue(el), toggle, selected, name);
    }

    static string? TryValue(AutomationElement el)
    {
        try
        {
            if (!el.Patterns.Value.IsSupported) return null;
            return Normalize(el.Patterns.Value.Pattern.Value);
        }
        catch { return null; }
    }

    static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        foreach (var ch in value)
        {
            if (ch is not '\r' and not '\n') return value;
        }
        return "";
    }

    static bool ContainsText(string? value, string? text)
    {
        if (string.IsNullOrEmpty(text)) return value != null;
        return value != null && value.Contains(text, StringComparison.Ordinal);
    }

    static bool Supports(Func<bool> probe)
    {
        try { return probe(); }
        catch { return false; }
    }

    static bool TryBounds(AutomationElement el, out BoundsRect rect)
    {
        rect = default;
        try
        {
            var r = el.Properties.BoundingRectangle.ValueOrDefault;
            if (r.Width <= 0 || r.Height <= 0) return false;
            rect = new BoundsRect(r.X, r.Y, r.Width, r.Height);
            return true;
        }
        catch { return false; }
    }

    static string? _lastUiaError;

    static AutomationElement? FromHwnd(IntPtr hwnd)
    {
        _lastUiaError = null;
        try
        {
            var el = Automation.FromHandle(hwnd);
            if (el == null) _lastUiaError = "FromHandle returned null";
            return el;
        }
        catch (Exception ex)
        {
            _lastUiaError = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }

    static bool ResolveWindow(string hwnd, string title, out IntPtr top, out string error)
    {
        top = IntPtr.Zero;
        error = "";
        if (TryParseHwnd(hwnd, out top)) return true;
        var needle = (title ?? "").Trim();
        if (needle.Length == 0)
        {
            error = "要提供 hwnd 或标题子串。";
            return false;
        }
        foreach (var hwndCandidate in Win32.TopLevelWindows())
        {
            var text = Win32.WindowText(hwndCandidate);
            if (text.Contains(needle, StringComparison.OrdinalIgnoreCase))
            {
                top = hwndCandidate;
                return true;
            }
        }
        error = $"没有标题含「{needle}」的窗口。";
        return false;
    }

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

    static string Trim(string value, int max) => value.Length <= max ? value : value[..max];

    static string Json(object value) => JsonSerializer.Serialize(value, JsonOpts);

    static object Fail(string reason, string via = "deny") => new { ok = false, confirmed = false, via, reason };

    sealed class Cache
    {
        public long Generation { get; init; }
        public Dictionary<string, CachedElement> Items { get; init; } = new(StringComparer.Ordinal);
    }

    sealed class CachedElement
    {
        public string Ref = "";
        public int[] RuntimeId = [];
        public IntPtr Top;
        public IntPtr ChromiumHost;
        public bool IsChromiumEdit;
        public bool ChromiumHostFound;
        public bool HasInvoke;
        public bool HasToggle;
        public bool HasSelection;
        public bool HasValue;
        public bool HasScroll;
        public bool HasBounds;
        public BoundsRect Bounds;
        public int Pid;
    }

    sealed record Node(CachedElement Cached, string Name, string ControlType, string ClassName, List<string> Patterns);

    sealed record ElementState(string? Value, string? Toggle, bool? Selected, string? Name);

    readonly record struct Outcome(bool Ok, string? Reason)
    {
        public bool Confirmed => Ok;
    }
}

sealed record Shot(byte[] Png, int Width, int Height, string Text);

static class Sta
{
    static readonly BlockingCollection<Action> Queue = new();

    static Sta()
    {
        var thread = new Thread(Loop) { IsBackground = true, Name = "desktop-uia" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    static void Loop()
    {
        foreach (var work in Queue.GetConsumingEnumerable())
        {
            try { work(); }
            catch { /* 异常留在 Task 里 */ }
        }
    }

    public static T Call<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Queue.Add(() =>
        {
            try { done.SetResult(work()); }
            catch (Exception ex) { done.SetException(ex); }
        });
        return done.Task.GetAwaiter().GetResult();
    }
}
