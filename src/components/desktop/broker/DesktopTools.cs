using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace DSHDesktopBroker;

[McpServerToolType]
public static class DesktopTools
{
    [McpServerTool(Name = "status"), Description("Report the broker path, integrity level, and the UIAccess bit on its token. When UIAccess is false, windows running at a higher privilege level cannot be operated.")]
    public static string Status() => DesktopSession.Status();

    [McpServerTool(Name = "list_windows"), Description("List visible top-level windows. hwnd is a hex string. bounds and all later clicks use physical pixels.")]
    public static string ListWindows() => DesktopSession.ListWindows();

    [McpServerTool(Name = "reveal_window"), Description("Show a hidden or minimized window (restore it, move it on-screen, and bring it to the foreground). Never closes or hides any window. Typically used when a WeChat Mini Program was opened but its window did not appear; list_windows reports such windows in hiddenMiniPrograms. If neither hwnd nor title is given, all hidden Mini Program windows are shown.")]
    public static string RevealWindow(
        [Description("Optional. Window handle, decimal or 0x-prefixed hex.")] string hwnd = "",
        [Description("Optional. Window title substring; matches only hidden or minimized windows.")] string title = "") =>
        DesktopSession.RevealWindow(hwnd, title);

    [McpServerTool(Name = "inspect"), Description("Read a window's UI Automation tree and assign each element a ref valid for this snapshot. For Chromium windows, the content child window is attached as well. Refs become invalid after the next inspect. Inspect again after any action that changes the UI (menu, dialog, page change) and before reusing refs; if an action reports a stale ref, re-inspect instead of retrying it. Provide at least one of hwnd or title.")]
    public static string Inspect(
        [Description("Top-level window handle, decimal or 0x-prefixed hex.")] string hwnd = "",
        [Description("Window title substring.")] string title = "") => DesktopSession.Inspect(hwnd, title);

    [McpServerTool(Name = "invoke"), Description("Trigger Invoke, Toggle, or Selection on an element from inspect. No mouse input is sent and keyboard focus may not move, so do not rely on it to focus a text field. Judge success by the control's state afterwards.")]
    public static string Invoke([Description("Element ref returned by inspect.")] string element) => DesktopSession.Invoke(element);

    [McpServerTool(Name = "type"), Description("Type text into an element; the tool focuses the target itself. Elements with the Value pattern outside Chromium (via = value) have their whole value replaced by text. Chromium inputs (via = chromium) are focused and receive WM_CHAR sent to the content child window; otherwise (via = sendinput or sendinput-fallback) the tool confirms the window is in the foreground, clicks the element's center, and types keystrokes. On these non-value paths text is inserted at the caret and existing text is kept: to replace it, clear the field first (focus it, key ctrl+a, then key delete), then type. The value is read back after writing; check after.value, and if it is wrong, re-inspect or screenshot rather than repeating the call.")]
    public static string Type(
        [Description("Element ref returned by inspect.")] string element,
        [Description("Text to write.")] string text) => DesktopSession.Type(element, text);

    [McpServerTool(Name = "key"), Description("Send a key press or key combination. Single keys: enter, tab, backspace, delete, escape, left, up, right, down, space, home, end, pageup, pagedown, insert, f1-f12, a single letter or digit. Combinations join ctrl/alt/shift/win with + before one main key (e.g. ctrl+a, ctrl+shift+t, alt+f4). Keys go to the keyboard focus. For a Chromium input the tool focuses the element itself (single keys are posted to the content child window; combinations are sent with SendInput after confirming the window is in the foreground). For any other element the tool only brings its window to the foreground and sends SendInput to whatever control has focus there; it does not click or focus the element, so make sure the target field is focused first (e.g. click_screen at its center). Common keys: ctrl+a selects all, then delete clears; enter submits; tab moves focus; escape closes a menu. Verify the result afterwards.")]
    public static string Key(
        [Description("Element ref returned by inspect.")] string element,
        [Description("Key name or combination, e.g. enter, ctrl+a.")] string key,
        [Description("Repeat count, 1 to 20.")] int times = 1) => DesktopSession.Key(element, key, times);

    [McpServerTool(Name = "click"), Description("Click an element from inspect. Uses the control pattern if Invoke, Toggle, or Selection is available (no mouse input, so keyboard focus may not move); otherwise clicks the center of its bounds after confirming the window is in the foreground. If foreground confirmation fails, no mouse input is sent. If via is invoke, toggle, or selection and you need the caret in a text field, use click_screen at the field's center. Clicks that open menus, dialogs, or pages take a moment: screenshot or re-inspect before the next step.")]
    public static string Click([Description("Element ref returned by inspect.")] string element) => DesktopSession.Click(element);

    [McpServerTool(Name = "scroll"), Description("Scroll an element from inspect. Uses the Scroll pattern when available and fails if the scroll position did not change (e.g. already at the end). Otherwise the wheel lands at the center of the element: Chromium content child windows receive WM_MOUSEWHEEL; other windows get wheel input at that point after confirming the window is in the foreground (no scroll if confirmation fails), and the system cursor is put back afterwards. Apps scroll whatever is under that point, so target the scrollable content itself (list, document, page body), not a toolbar, header, or small child control. On the wheel paths ok means the wheel was sent, not that content moved. Scroll a few notches at a time and screenshot or re-inspect to check. direction: up, down, left, right (up reveals content above). notches: 1 to 20; one notch = 120 wheel units.")]
    public static string Scroll(
        [Description("Element ref returned by inspect. If a Mini Program shows only a skeleton tree, use the ref of the Chrome Legacy Window or Pane.")] string element,
        [Description("up, down, left, or right.")] string direction,
        [Description("Number of notches, 1 to 20.")] int notches = 1) => DesktopSession.Scroll(element, direction, notches);

    [McpServerTool(Name = "scroll_screen"), Description("Scroll at a physical-pixel point on the virtual screen. The wheel lands at (x, y) and apps scroll whatever is under it, so pick a point inside the scrollable content (from elements or a fresh screenshot), not on a header, toolbar, or empty margin. If the target has a Chromium content child window, WM_MOUSEWHEEL is sent to it. Otherwise the window is confirmed to be in the foreground before sending wheel input; no scroll if confirmation fails. ok means the wheel was sent, not that content moved: scroll a few notches at a time and screenshot to check. direction: up, down, left, right.")]
    public static string ScrollScreen(
        [Description("x in physical pixels.")] int x,
        [Description("y in physical pixels.")] int y,
        [Description("up, down, left, or right.")] string direction,
        [Description("Number of notches, 1 to 20.")] int notches = 1,
        [Description("Optional. Target top-level window handle. If empty, the window at that point is used.")] string hwnd = "") => DesktopSession.ScrollScreen(x, y, direction, notches, hwnd);

    [McpServerTool(Name = "click_screen"), Description("Click a physical-pixel point on the virtual screen. Prefer element actions (click, type) when inspect finds the target; use this when the control tree is empty or lacks it (custom-drawn windows), with coordinates from elements or a fresh screenshot. Brings the target window to the foreground first; does not click if confirmation fails. A real click also moves keyboard focus, so it can focus an input before key. ok means the click was sent; screenshot to confirm the effect.")]
    public static string ClickScreen(
        [Description("x in physical pixels.")] int x,
        [Description("y in physical pixels.")] int y,
        [Description("Optional. Handle of the top-level window to bring to the foreground.")] string hwnd = "") => DesktopSession.ClickScreen(x, y, hwnd);


    [McpServerTool(Name = "dock"), Description("Right-side docking: this app's window docks at minimum width on the right edge of the screen, and the window being operated automatically fills the left side. mode: on, off, or status. Turning it off restores all windows to their original positions.")]
    public static string Dock(
        [Description("on, off, or status.")] string mode = "status",
        [Description("Optional. Handle of the target window to fill the left side. If omitted with on, only docking mode is entered; the left side is filled on the next operation.")] string hwnd = "") =>
        DesktopSession.Dock(mode, hwnd);

    [McpServerTool(Name = "elements"), Description("List the main visible elements in a window with their on-screen center coordinates (physical pixels, same coordinate space as click_screen), sorted top-to-bottom, left-to-right. Sources (src): uia (UI Automation, including the current page of Chromium / WeChat Mini Programs; unnamed but clickable nodes get a synthesized label such as “图标按钮 add-cart-icon（近：…）” [icon button, near: …]), ocr (Windows OCR, adds text UIA lacks), visual (visually detected red/orange round buttons, commonly a “+” add-to-cart). conf: high / mid / low; low is a guess, so take a screenshot after clicking to confirm. Default output is compact lines “x,y name [src/conf] [遮挡]”; detail=true returns objects (with bounds and note). Results are paged: when nextOffset is non-empty, pass it as offset for the next page, or narrow with region / query. [遮挡] (occluded) means the center is covered by another window; bring the window to the front first. With x and y in hand, call click_screen(x, y, hwnd) directly. Provide at least one of hwnd or title.")]
    public static string Elements(
        [Description("Top-level window handle, decimal or 0x-prefixed hex.")] string hwnd = "",
        [Description("Window title substring.")] string title = "",
        [Description("Optional. Return only elements whose name (including synthesized labels) contains this text, case-insensitive, e.g. “去结算” (checkout), “+”, “add-cart”.")] string query = "",
        [Description("Optional. Restrict to this screen region, formatted x,y,w,h (physical pixels).")] string region = "",
        [Description("Items per page, default 80, max 200.")] int limit = 80,
        [Description("Paging start; use nextOffset from the previous result.")] int offset = 0,
        [Description("auto (default: UIA + OCR + visual), uia, or ocr.")] string source = "auto",
        [Description("If true, each item is an object (name, x, y, role, src, conf, bounds, note, occluded); default is compact lines.")] bool detail = false) =>
        DesktopSession.Elements(hwnd, title, query, region, limit, offset, source, detail);

    [McpServerTool(Name = "screenshot"), Description("Capture a window or the entire virtual screen as a PNG. Pixels share the same physical coordinate space as click_screen and element bounds. Operating loop: look first (screenshot, inspect, or elements), act once, then look again to verify. Prefer ref-based actions over raw coordinates. Before key input make sure focus is in the target field; before scrolling make sure the target point is over the scrollable content. After clicks that open menus, dialogs, or pages, look again before the next step since the UI may still be loading. If an action fails or changes nothing, re-inspect instead of repeating it.")]
    public static CallToolResult Screenshot([Description("Optional. Window handle. If empty, the whole virtual screen is captured.")] string hwnd = "")
    {
        var shot = DesktopSession.Capture(hwnd);
        if (shot == null)
        {
            return new CallToolResult
            {
                IsError = true,
                Content = [new TextContentBlock { Type = "text", Text = "截图失败" }],
            };
        }
        return new CallToolResult
        {
            Content =
            [
                new TextContentBlock { Type = "text", Text = shot.Text },
                new ImageContentBlock { Data = Convert.ToBase64String(shot.Png), MimeType = "image/png" },
            ],
        };
    }
}
