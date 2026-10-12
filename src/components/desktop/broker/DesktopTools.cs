using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace DSHDesktopBroker;

[McpServerToolType]
public static class DesktopTools
{
    [McpServerTool(Name = "status"), Description("报告经纪人路径、完整性级别，以及令牌上的 UIAccess 位。UIAccess 为 false 时不能操作权限更高的窗口。")]
    public static string Status() => DesktopSession.Status();

    [McpServerTool(Name = "list_windows"), Description("列出可见顶层窗口。hwnd 是十六进制字符串。bounds 与后续点击都使用物理像素。")]
    public static string ListWindows() => DesktopSession.ListWindows();

    [McpServerTool(Name = "reveal_window"), Description("显示被隐藏或最小化的窗口（恢复、移到屏幕内并切到前台），不会关闭或隐藏任何窗口。常用于微信小程序打开后窗口没出现：list_windows 的 hiddenMiniPrograms 会列出这类窗口。hwnd 和 title 都不给时，显示所有隐藏的小程序窗口。")]
    public static string RevealWindow(
        [Description("可选。窗口句柄，十进制或 0x 开头。")] string hwnd = "",
        [Description("可选。窗口标题子串，只匹配隐藏或最小化的窗口。")] string title = "") =>
        DesktopSession.RevealWindow(hwnd, title);

    [McpServerTool(Name = "inspect"), Description("读取一个窗口的 UI Automation 树，并给每个元素一个本次有效的 ref。Chromium 会同时挂到内容子窗口。ref 在下次 inspect 后失效。hwnd 与 title 至少给一个。")]
    public static string Inspect(
        [Description("顶层窗口句柄，十进制或 0x 开头。")] string hwnd = "",
        [Description("窗口标题子串。")] string title = "") => DesktopSession.Inspect(hwnd, title);

    [McpServerTool(Name = "invoke"), Description("对 inspect 给出的元素调用 Invoke、Toggle 或 Selection。成功与否看操作后的控件状态。")]
    public static string Invoke([Description("inspect 返回的 ref。")] string element) => DesktopSession.Invoke(element);

    [McpServerTool(Name = "type"), Description("向元素输入文字。普通输入框用 Value；Chromium 输入框向内容子窗口发送 WM_CHAR。找不到该子窗口时退回前台确认后的键入，via 为 sendinput-fallback。写完会读回。")]
    public static string Type(
        [Description("inspect 返回的 ref。")] string element,
        [Description("要写入的文字。")] string text) => DesktopSession.Type(element, text);

    [McpServerTool(Name = "key"), Description("向元素发送按键：enter、tab、backspace、delete、escape、left、up、right、down、space。")]
    public static string Key(
        [Description("inspect 返回的 ref。")] string element,
        [Description("按键名。")] string key,
        [Description("次数，1 到 20。")] int times = 1) => DesktopSession.Key(element, key, times);

    [McpServerTool(Name = "click"), Description("点击 inspect 给出的元素。有 Invoke、Toggle 或 Selection 时走控件操作，否则在前台确认后点击边界中心。前台确认失败不会发鼠标。")]
    public static string Click([Description("inspect 返回的 ref。")] string element) => DesktopSession.Click(element);

    [McpServerTool(Name = "scroll"), Description("滚动 inspect 给出的元素。有 Scroll 模式时走控件并核对滚动位置。Chromium 内容子窗口发送 WM_MOUSEWHEEL。否则在前台确认后，于边界中心发送滚轮，确认失败不滚动。direction 为 up、down、left、right。up 看到更上面的内容。notches 为 1 到 20，一格 120。")]
    public static string Scroll(
        [Description("inspect 返回的 ref。小程序只有骨架时，用 Chrome Legacy Window 或 Pane 的 ref。")] string element,
        [Description("up、down、left、right。")] string direction,
        [Description("格数，1 到 20。")] int notches = 1) => DesktopSession.Scroll(element, direction, notches);

    [McpServerTool(Name = "scroll_screen"), Description("在虚拟屏幕的物理像素上滚动。目标有 Chromium 内容子窗口时把 WM_MOUSEWHEEL 发给该子窗口。否则先确认前台，再发送滚轮，确认失败不滚动。direction 为 up、down、left、right。")]
    public static string ScrollScreen(
        [Description("物理像素 x。")] int x,
        [Description("物理像素 y。")] int y,
        [Description("up、down、left、right。")] string direction,
        [Description("格数，1 到 20。")] int notches = 1,
        [Description("可选。目标顶层窗口句柄。留空则用该坐标上的窗口。")] string hwnd = "") => DesktopSession.ScrollScreen(x, y, direction, notches, hwnd);

    [McpServerTool(Name = "click_screen"), Description("点击虚拟屏幕上的物理像素。只在控件树为空（自绘窗口）时使用。会先把目标窗口拉到前台，确认失败则不点击。")]
    public static string ClickScreen(
        [Description("物理像素 x。")] int x,
        [Description("物理像素 y。")] int y,
        [Description("可选。要拉到前台的顶层窗口句柄。")] string hwnd = "") => DesktopSession.ClickScreen(x, y, hwnd);


    [McpServerTool(Name = "dock"), Description("右侧停靠：本窗口以最小宽度停靠于屏幕右侧，当前操作的窗口自动铺满左侧。mode 为 on、off 或 status。关闭后恢复各窗口原有位置。")]
    public static string Dock(
        [Description("on、off 或 status。")] string mode = "status",
        [Description("可选。要铺在左侧的目标窗口句柄。on 时若省略，则只进入停靠模式，等下次操作再铺。")] string hwnd = "") =>
        DesktopSession.Dock(mode, hwnd);

    [McpServerTool(Name = "elements"), Description("列出窗口里主要的可见元素及其屏幕中心坐标（物理像素，与 click_screen 同一套坐标），按从上到下、从左到右排序。来源 src：uia（UI Automation，含 Chromium / 微信小程序当前页；无名但可点击的节点给合成标签，如“图标按钮 add-cart-icon（近：…）”）、ocr（Windows OCR 补 UIA 没有的文字）、visual（视觉检测的红/橙色圆形按钮，常见“+”加购）。conf：high / mid / low，low 为推测，点后应截图确认。默认紧凑行“x,y 名称 [src/conf] [遮挡]”；detail=true 返回对象（含 bounds、note）。结果分页：nextOffset 不为空时用 offset 取下一页，或用 region / query 缩小。[遮挡] 表示中心被其他窗口盖住，需先把窗口调到前面。拿到 x、y 后直接 click_screen(x, y, hwnd)。hwnd 与 title 至少给一个。")]
    public static string Elements(
        [Description("顶层窗口句柄，十进制或 0x 开头。")] string hwnd = "",
        [Description("窗口标题子串。")] string title = "",
        [Description("可选。只返回名称（含合成标签）包含该文字的元素，不区分大小写，如 “去结算”、“+”、“add-cart”。")] string query = "",
        [Description("可选。只看该屏幕区域，格式 x,y,w,h（物理像素）。")] string region = "",
        [Description("每页条数，默认 80，上限 200。")] int limit = 80,
        [Description("分页起点，取上次结果的 nextOffset。")] int offset = 0,
        [Description("auto（默认，UIA + OCR + 视觉）、uia 或 ocr。")] string source = "auto",
        [Description("true 时每项返回对象（name、x、y、role、src、conf、bounds、note、occluded）；默认紧凑行。")] bool detail = false) =>
        DesktopSession.Elements(hwnd, title, query, region, limit, offset, source, detail);

    [McpServerTool(Name = "screenshot"), Description("截取窗口或整个虚拟屏幕，返回 PNG。像素与 click_screen、元素 bounds 是同一套物理坐标。")]
    public static CallToolResult Screenshot([Description("可选。窗口句柄。留空则截虚拟屏幕。")] string hwnd = "")
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
