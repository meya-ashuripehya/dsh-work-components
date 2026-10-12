using System.Runtime.InteropServices.WindowsRuntime;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace DSHDesktopBroker;

static partial class DesktopSession
{
    const int MaxUiaScan = 6000;

    // 中文原样输出（不转 \uXXXX），省 token；空字段不输出。
    static readonly System.Text.Json.JsonSerializerOptions ElementsJsonOpts = new(System.Text.Json.JsonSerializerDefaults.Web)
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    static readonly HashSet<string> InteractiveRoles = new(StringComparer.Ordinal)
    {
        "Button", "Hyperlink", "MenuItem", "TabItem", "ListItem", "CheckBox", "RadioButton",
        "Edit", "ComboBox", "SplitButton", "TreeItem", "Slider", "Spinner",
    };

    /// <summary>主要元素及其屏幕中心坐标（物理像素）。source：auto（UIA + OCR + 视觉补漏）、uia、ocr。</summary>
    public static string Elements(string hwnd, string title, string query, string region, int limit, int offset, string source, bool detail) => Sta.Call(() =>
    {
        if (!ResolveWindow(hwnd, title, out var top, out var error))
            return Json(new { ok = false, reason = error });
        DockLayout.MaybeRetile(top);
        if (!Win32.TryGetExtendedFrame(top, out var frame))
            return Json(new { ok = false, reason = "无法读取窗口矩形。" });

        var visible = new ElementLocator.Box(frame.X, frame.Y, frame.Width, frame.Height)
            .Intersect(Win32.VirtualScreenBox());
        ElementLocator.Box? regionBox = ElementLocator.TryParseRegion(region, out var rb) ? rb : null;
        var mode = (source ?? "auto").Trim().ToLowerInvariant();
        if (mode is not ("auto" or "uia" or "ocr")) mode = "auto";

        var candidates = new List<ElementLocator.Candidate>();
        string? uiaError = null, ocrError = null;
        var sources = new List<string>();
        if (mode != "ocr")
        {
            var uia = CollectUia(top, out uiaError);
            if (uia.Count > 0) sources.Add("uia");
            candidates.AddRange(uia);
        }
        // auto 总是补 OCR 与视觉（合计约 0.3 秒）：小程序里的“+”按钮、图标、画布文字在 UIA 里常常没有节点。
        if (mode is "ocr" or "auto" && Win32.TryGetRect(top, out var outer) && Win32.CaptureWindow(top) is { } png)
        {
            var ocr = CollectOcr(png, outer.X, outer.Y, outer.Width, out ocrError);
            if (ocr.Count > 0) sources.Add("ocr");
            candidates.AddRange(ocr);
            if (mode == "auto")
            {
                var vis = CollectVisual(png, outer.X, outer.Y);
                if (vis.Count > 0) sources.Add("visual");
                candidates.AddRange(vis);
            }
        }
        else if (mode is "ocr" or "auto") ocrError = "截图失败。";

        var picked = ElementLocator.Pick(candidates, visible, regionBox, query, limit, offset);
        var self = (uint)Environment.ProcessId;
        foreach (var p in picked.Items)
        {
            var root = Win32.RootFromPoint(p.X, p.Y);
            p.Occluded = root != IntPtr.Zero && root != top && (uint)Win32.WindowPid(root) != self;
        }
        var occluded = picked.Items.Count(p => p.Occluded);

        var hints = new List<string> { "x,y 为屏幕物理像素中心，直接 click_screen(x, y, hwnd)。" };
        if (picked.NextOffset is { } nx)
            hints.Add($"还有 {picked.Total - nx} 项未返回：用 offset={nx} 取下一页，或用 region / query 缩小范围。");
        hints.Add("conf：high=UIA 原文；mid=OCR 文字或合成标签；low=推测（OCR 孤立字形、视觉色块），点击后应截图确认。");
        if (occluded > 0)
            hints.Add($"{occluded} 项中心被其他窗口遮住（occluded）：先 focus 该窗口或开启右侧停靠再点。");

        object Row(ElementLocator.Picked p) => detail
            ? new { name = p.Name, x = p.X, y = p.Y, role = p.Role, src = p.Source, conf = p.Confidence,
                    bounds = new[] { p.Bounds.X, p.Bounds.Y, p.Bounds.W, p.Bounds.H }, note = p.Note,
                    occluded = p.Occluded ? true : (bool?)null }
            // 紧凑行："x,y 名称 [src/conf] [遮挡]"，src/conf 为 uia/high 时省略。
            : $"{p.X},{p.Y} {p.Name}"
              + (p.Source == "uia" && p.Confidence == ElementLocator.High ? "" : $" [{p.Source}/{p.Confidence}]")
              + (p.Occluded ? " [遮挡]" : "");

        return System.Text.Json.JsonSerializer.Serialize(new
        {
            ok = true,
            hwnd = FormatHwnd(top),
            title = Trim(Win32.WindowText(top), 200),
            window = new[] { frame.X, frame.Y, frame.Width, frame.Height },
            source = sources.Count == 0 ? "none" : string.Join("+", sources),
            total = picked.Total,
            offset = picked.Offset,
            returned = picked.Items.Count,
            nextOffset = picked.NextOffset,
            occluded = occluded > 0 ? occluded : (int?)null,
            hint = string.Join(" ", hints),
            uiaError,
            ocrError,
            elements = picked.Items.Select(Row),
        }, ElementsJsonOpts);
    });

    static List<ElementLocator.Candidate> CollectVisual(byte[] png, int originX, int originY)
    {
        var list = new List<ElementLocator.Candidate>();
        try
        {
            using var bmp = new System.Drawing.Bitmap(new MemoryStream(png));
            var rect = new System.Drawing.Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            byte[] bytes;
            try
            {
                bytes = new byte[data.Stride * data.Height];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            }
            finally { bmp.UnlockBits(data); }
            foreach (var b in ElementLocator.FindRoundAccentButtons(bytes, bmp.Width, bmp.Height, data.Stride))
                list.Add(new ElementLocator.Candidate("红色圆形按钮", "Icon",
                    new ElementLocator.Box(originX + b.X, originY + b.Y, b.W, b.H), "visual", true,
                    Hint: "视觉检测：红/橙色实心圆、中心白色", Confidence: ElementLocator.Low));
        }
        catch { }
        return list;
    }

    static List<ElementLocator.Candidate> CollectUia(IntPtr top, out string? error)
    {
        error = null;
        var list = new List<ElementLocator.Candidate>();
        var root = FromHwnd(top);
        if (root == null) { error = _lastUiaError ?? "没有读到控件。"; return list; }
        try
        {
            var lib = Automation.PropertyLibrary.Element;
            var pat = Automation.PatternLibrary;
            var cache = new CacheRequest { TreeScope = TreeScope.Subtree, AutomationElementMode = AutomationElementMode.None };
            cache.Add(lib.Name);
            cache.Add(lib.ControlType);
            cache.Add(lib.BoundingRectangle);
            cache.Add(lib.IsOffscreen);
            cache.Add(lib.ClassName);
            cache.Add(lib.AutomationId);
            cache.Add(pat.InvokePattern.AvailabilityProperty);
            cache.Add(pat.TogglePattern.AvailabilityProperty);
            cache.Add(pat.SelectionItemPattern.AvailabilityProperty);
            using (cache.Activate())
            {
                var croot = root.FindFirst(TreeScope.Element, FlaUI.Core.Conditions.TrueCondition.Default);
                if (croot == null) { error = "没有读到控件。"; return list; }
                var scanned = 0;
                WalkClipped(croot, null, 0, list, ref scanned);
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
        return list;
    }

    /// <summary>
    /// 带祖先裁剪的遍历：网页里轮播 / 滚动容器外的子元素仍有坐标，按祖先边界取交集裁掉，避免返回被遮住的项。
    /// </summary>
    static void WalkClipped(AutomationElement el, ElementLocator.Box? clip, int depth, List<ElementLocator.Candidate> list, ref int scanned)
    {
        if (depth > 60 || scanned++ >= MaxUiaScan) return;
        // 微信小程序的拖拽提示层（“松开使用 … 打开”）平时不可见，但 UIA 不标 offscreen。
        try { if (el.Properties.AutomationId.ValueOrDefault is "drag_wrapper" or "coverview_root") return; } catch { }
        ElementLocator.Box? childClip = clip;
        try
        {
            var r = el.Properties.BoundingRectangle.ValueOrDefault;
            var box = new ElementLocator.Box(r.X, r.Y, r.Width, r.Height);
            var offscreen = el.Properties.IsOffscreen.ValueOrDefault;
            if (!box.IsEmpty)
            {
                var visible = clip is { } c ? box.Intersect(c) : box;
                // 与祖先可见区无交集：要么被裁掉，要么是过期 / 虚假边界（如 Chromium 的中间 D3D 层）；
                // 都不报告，也不用它收窄子树裁剪区，继续往下找。
                if (!visible.IsEmpty) childClip = visible;
                if (!offscreen && !visible.IsEmpty)
                {
                    var role = el.Properties.ControlType.ValueOrDefault.ToString();
                    var name = el.Properties.Name.ValueOrDefault ?? "";
                    string? cls = null;
                    try { cls = el.Properties.ClassName.ValueOrDefault; } catch { }
                    var interactive = InteractiveRoles.Contains(role)
                        || Supports(() => el.Patterns.Invoke.IsSupported)
                        || Supports(() => el.Patterns.Toggle.IsSupported)
                        || Supports(() => el.Patterns.SelectionItem.IsSupported);
                    // 原始边界交给 Pick；它会再按可见区裁剪并丢弃大部分被遮的项。
                    var reported = visible.Area * 10 >= box.Area * 4 ? visible : default;
                    if (!reported.IsEmpty)
                        list.Add(new ElementLocator.Candidate(name, role, reported, "uia", interactive, ElementLocator.ClassHint(cls)));
                }
            }
        }
        catch { }
        AutomationElement[] kids;
        try { kids = el.CachedChildren; } catch { kids = []; }
        // 微信小程序的页面栈：多个 page_wrapper 叠在一起，DOM 中靠后的在最上层，只看最后一个。
        var lastPage = -1;
        for (var i = 0; i < kids.Length; i++)
            if (IsMiniProgramPage(kids[i])) lastPage = i;
        for (var i = 0; i < kids.Length; i++)
        {
            if (lastPage >= 0 && i != lastPage && IsMiniProgramPage(kids[i])) continue;
            WalkClipped(kids[i], childClip, depth + 1, list, ref scanned);
        }
    }

    static bool IsMiniProgramPage(AutomationElement el)
    {
        try { return (el.Properties.ClassName.ValueOrDefault ?? "").Split(' ').Contains("page_wrapper"); }
        catch { return false; }
    }

    static List<ElementLocator.Candidate> CollectOcr(byte[] png, int originX, int originY, int width, out string? error)
    {
        error = null;
        var list = new List<ElementLocator.Candidate>();
        try
        {
            // 小字放大两倍再识别，坐标再除回去。
            var scale = width < 1600 ? 2 : 1;
            byte[] input = png;
            if (scale > 1)
            {
                using var src = new System.Drawing.Bitmap(new MemoryStream(png));
                using var big = new System.Drawing.Bitmap(src.Width * scale, src.Height * scale);
                using (var g = System.Drawing.Graphics.FromImage(big))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(src, 0, 0, big.Width, big.Height);
                }
                using var ms = new MemoryStream();
                big.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                input = ms.ToArray();
            }
            var lines = Task.Run(() => RecognizeAsync(input)).GetAwaiter().GetResult();
            if (lines == null) { error = "系统没有可用的 OCR 语言。"; return list; }
            foreach (var (text, l, t, w, h) in lines)
            {
                list.Add(new ElementLocator.Candidate(text, "Text",
                    new ElementLocator.Box(originX + l / scale, originY + t / scale, Math.Max(1, w / scale), Math.Max(1, h / scale)),
                    "ocr", false));
            }
        }
        catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
        return list;
    }

    static async Task<List<(string Text, int L, int T, int W, int H)>?> RecognizeAsync(byte[] png)
    {
        var engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("zh-Hans-CN"))
            ?? OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) return null;
        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(png.AsBuffer());
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var result = await engine.RecognizeAsync(bitmap);
        var lines = new List<(string, int, int, int, int)>();
        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0) continue;
            double l = double.MaxValue, t = double.MaxValue, r = double.MinValue, b = double.MinValue;
            foreach (var w in line.Words)
            {
                l = Math.Min(l, w.BoundingRect.X); t = Math.Min(t, w.BoundingRect.Y);
                r = Math.Max(r, w.BoundingRect.X + w.BoundingRect.Width); b = Math.Max(b, w.BoundingRect.Y + w.BoundingRect.Height);
            }
            var text = ElementLocator.JoinOcrWords(line.Words.Select(w => w.Text));
            lines.Add((text, (int)l, (int)t, (int)(r - l), (int)(b - t)));
        }
        return lines;
    }
}