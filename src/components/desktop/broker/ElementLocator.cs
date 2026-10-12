using System.Globalization;
using System.Text.RegularExpressions;

namespace DSHDesktopBroker;

/// <summary>
/// 「主要元素 + 屏幕中心坐标」：收集 UIA / OCR / 视觉候选，裁到窗口可见区，补标签、去重、过滤、排序并分页。
/// 纯逻辑部分可单测；坐标为 Per-Monitor V2 物理像素，与 click_screen 一致。
/// </summary>
static class ElementLocator
{
    public const int DefaultLimit = 80;
    public const int MaxLimit = 200;
    const int NameMax = 80;

    public const string High = "high";
    public const string Mid = "mid";
    public const string Low = "low";

    internal readonly record struct Box(int X, int Y, int W, int H)
    {
        public int Right => X + W;
        public int Bottom => Y + H;
        public int Cx => X + W / 2;
        public int Cy => Y + H / 2;
        public bool IsEmpty => W <= 0 || H <= 0;
        public long Area => (long)Math.Max(0, W) * Math.Max(0, H);
        public bool Contains(int x, int y) => x >= X && x < Right && y >= Y && y < Bottom;
        public Box Inflate(int d) => new(X - d, Y - d, W + 2 * d, H + 2 * d);

        public Box Intersect(Box o)
        {
            var l = Math.Max(X, o.X);
            var t = Math.Max(Y, o.Y);
            var r = Math.Min(Right, o.Right);
            var b = Math.Min(Bottom, o.Bottom);
            return r > l && b > t ? new Box(l, t, r - l, b - t) : default;
        }
    }

    /// <param name="Hint">UIA 类名提示（已清洗）或 OCR 原文等附注。</param>
    internal sealed record Candidate(string Name, string Role, Box Bounds, string Source, bool Interactive,
        string? Hint = null, string? Confidence = null);

    internal sealed record Picked(string Name, string Role, int X, int Y, Box Bounds, string Source, string Confidence, string? Note)
    {
        public bool Occluded { get; set; }
    }

    internal sealed record PickResult(List<Picked> Items, int Total, int Offset, int? NextOffset);

    /// <summary>
    /// 规则：
    /// 1. 裁到可见区（窗口 ∩ 可选 region），裁后面积不足原面积 40% 或小于 4×4 的丢弃。
    /// 2. 不可交互的容器（Pane/Group/Document/List…）丢弃；无名且不可交互的丢弃，例外是小图标图片（12–64px，有类名提示）。
    /// 3. 无名项合成标签：「角色词 + 类名提示 +（近：最近的文字）」。
    /// 4. OCR 的孤立单字形（小方框里的 0/O/十 等）改写为“+”，置信度 low，并附原文。
    /// 5. 视觉色块与其中的 OCR 孤立字形合并（置信度 mid）；落在已有 UIA 小元素里的色块丢弃。
    /// 6. 同名且中心 ≤ 8px 合并；与有名 UIA 文字重叠的 OCR 行丢弃。
    /// 7. query 不区分大小写匹配名称（含合成标签）；按行（中心 y 每 12px 一档）再按 x 排序；offset/limit 分页。
    /// </summary>
    internal static PickResult Pick(IEnumerable<Candidate> candidates, Box visible, Box? region, string? query, int limit, int offset = 0)
    {
        limit = Math.Clamp(limit <= 0 ? DefaultLimit : limit, 1, MaxLimit);
        offset = Math.Max(0, offset);
        var area = region is { } rg ? visible.Intersect(rg) : visible;
        var q = (query ?? "").Trim();

        var clipped = new List<(Candidate C, Box Clip)>();
        foreach (var c in candidates)
        {
            if (c.Bounds.IsEmpty || area.IsEmpty) continue;
            var clip = c.Bounds.Intersect(area);
            if (clip.W < 4 || clip.H < 4) continue;
            if (clip.Area * 10 < c.Bounds.Area * 4) continue;
            var name = Normalize(c.Name);
            if (IsContainerRole(c.Role) && !c.Interactive) continue;
            if (name.Length == 0 && !c.Interactive && !IsIconImage(c, clip)) continue;
            clipped.Add((c with { Name = name }, clip));
        }

        // 视觉色块 ↔ OCR 孤立字形合并。
        var glyphs = clipped.Where(t => t.C.Source == "ocr" && IsLoneGlyph(t.C.Name, t.Clip)).ToList();
        var consumed = new HashSet<int>();
        for (var i = 0; i < clipped.Count; i++)
        {
            var (c, clip) = clipped[i];
            if (c.Source != "visual") continue;
            var g = glyphs.FirstOrDefault(t => clip.Inflate(4).Contains(t.Clip.Cx, t.Clip.Cy));
            if (g.C != null)
            {
                consumed.Add(clipped.IndexOf(g));
                clipped[i] = (c with { Name = "+ 按钮（" + c.Name + "）", Confidence = Mid, Hint = $"OCR 原文“{g.C.Name}”" }, clip);
            }
        }

        // 有视觉色块时，“+”按钮已由视觉覆盖；没配上的 OCR 孤立字形多半是图片 / 小图标上的误识别，丢掉。
        var hasVisual = clipped.Any(t => t.C.Source == "visual");
        if (hasVisual)
            for (var i = 0; i < clipped.Count; i++)
                if (clipped[i].C.Source == "ocr" && IsLoneGlyph(clipped[i].C.Name, clipped[i].Clip)) consumed.Add(i);

        // UIA 同一行里紧挨着的短文字碎片（如价格 “¥” “16”）合并成一项。
        clipped = MergeFragments(clipped, consumed);
        consumed.Clear();

        var texts = clipped.Where(t => t.C.Name.Length > 0 && t.C.Source != "visual").ToList();
        var ranked = new List<Picked>();
        for (var i = 0; i < clipped.Count; i++)
        {
            if (consumed.Contains(i)) continue;
            var (c, clip) = clipped[i];
            var name = c.Name;
            var conf = c.Confidence ?? (c.Source == "uia" ? High : c.Source == "ocr" ? Mid : Low);
            string? note = c.Source == "visual" ? c.Hint : null;
            if (c.Source == "ocr" && IsLoneGlyph(name, clip) && name != "+")
            {
                note = $"OCR 原文“{name}”，可能是“+”按钮";
                name = "+";
                conf = Low;
            }
            if (name.Length == 0)
            {
                name = SynthesizeLabel(c, clip, texts);
                conf = c.Interactive ? Mid : Low;
            }
            ranked.Add(new Picked(name, c.Role, clip.Cx, clip.Cy, clip, c.Source, conf, note));
        }

        var kept = new List<Picked>();
        foreach (var p in ranked
                     .OrderBy(r => r.Source == "uia" ? 0 : r.Source == "ocr" ? 1 : 2)
                     .ThenBy(r => r.Confidence == High ? 0 : r.Confidence == Mid ? 1 : 2)
                     .ThenBy(r => r.Bounds.Area))
        {
            if (kept.Any(k => string.Equals(k.Name, p.Name, StringComparison.Ordinal)
                    && Math.Abs(k.X - p.X) <= 8 && Math.Abs(k.Y - p.Y) <= 8))
                continue;
            if (p.Source == "ocr" && p.Note == null && kept.Any(k => k.Source == "uia" && k.Confidence == High
                    && (k.Bounds.Contains(p.X, p.Y) || p.Bounds.Intersect(k.Bounds).Area * 2 >= p.Bounds.Area)))
                continue;
            if (p.Source == "visual" && kept.Any(k => k.Source == "uia" && k.Bounds.Contains(p.X, p.Y)
                    && k.Bounds.Area <= p.Bounds.Area * 4))
                continue;
            kept.Add(p);
        }

        var ordered = kept
            .Where(k => q.Length == 0 || k.Name.Contains(q, StringComparison.OrdinalIgnoreCase))
            .OrderBy(k => k.Y / 12).ThenBy(k => k.X).ToList();
        var total = ordered.Count;
        var page = ordered.Skip(offset).Take(limit).ToList();
        int? next = offset + page.Count < total ? offset + page.Count : null;
        return new PickResult(page, total, offset, next);
    }

    static List<(Candidate C, Box Clip)> MergeFragments(List<(Candidate C, Box Clip)> items, HashSet<int> drop)
    {
        var keep = new List<(Candidate C, Box Clip)>();
        var frags = new List<(Candidate C, Box Clip)>();
        for (var i = 0; i < items.Count; i++)
        {
            if (drop.Contains(i)) continue;
            var it = items[i];
            if (it.C.Source == "uia" && it.C.Role == "Text" && !it.C.Interactive && IsPriceFragment(it.C.Name)) frags.Add(it);
            else keep.Add(it);
        }
        frags.Sort((a, b) => a.Clip.Cy / 6 != b.Clip.Cy / 6 ? a.Clip.Cy.CompareTo(b.Clip.Cy) : a.Clip.X.CompareTo(b.Clip.X));
        var used = new bool[frags.Count];
        for (var i = 0; i < frags.Count; i++)
        {
            if (used[i]) continue;
            var (c, box) = frags[i];
            var name = c.Name;
            var merged = true;
            while (merged)
            {
                merged = false;
                for (var j = 0; j < frags.Count; j++)
                {
                    if (used[j] || j == i) continue;
                    var o = frags[j].Clip;
                    var vOverlap = Math.Min(box.Bottom, o.Bottom) - Math.Max(box.Y, o.Y);
                    var right = o.X - box.Right;   // o 在右边
                    var left = box.X - o.Right;    // o 在左边
                    var after = right is >= -2 and <= 6;
                    var before = left is >= -2 and <= 6;
                    if (vOverlap * 2 < Math.Min(box.H, o.H) || !(after || before) || name.Length + frags[j].C.Name.Length > 16) continue;
                    name = after ? name + frags[j].C.Name : frags[j].C.Name + name;
                    var l = Math.Min(box.X, o.X); var tp = Math.Min(box.Y, o.Y);
                    box = new Box(l, tp, Math.Max(box.Right, o.Right) - l, Math.Max(box.Bottom, o.Bottom) - tp);
                    used[j] = true;
                    merged = true;
                }
            }
            used[i] = true;
            keep.Add((c with { Name = name, Bounds = box }, box));
        }
        return keep;
    }

    /// <summary>价格类碎片：只含货币符号、数字、小数点、“+”“万”等。</summary>
    internal static bool IsPriceFragment(string s) =>
        s.Length is > 0 and <= 8 && Regex.IsMatch(s, "^[¥￥$€0-9.,+万起约]+$");

    internal static bool IsContainerRole(string role) => role is "Pane" or "Group" or "Document" or "List" or "Custom" or "Window" or "Unknown";

    static bool IsIconImage(Candidate c, Box clip) =>
        c.Source == "uia" && c.Role == "Image" && !string.IsNullOrEmpty(c.Hint)
        && clip.W is >= 12 and <= 64 && clip.H is >= 12 and <= 64;

    static readonly HashSet<string> GlyphMisreads = new(StringComparer.Ordinal)
    {
        "0", "O", "o", "〇", "○", "十", "+", "＋", "④", "⊕", "田", "㊉", "e", "@",
    };

    /// <summary>小方框（10–48px、近似正方形）里只有一个疑似“+”的字符。</summary>
    internal static bool IsLoneGlyph(string name, Box box) =>
        GlyphMisreads.Contains(name.Trim()) && box.W is >= 10 and <= 48 && box.H is >= 10 and <= 48
        && box.W * 10 >= box.H * 7 && box.H * 10 >= box.W * 7;

    internal static string SynthesizeLabel(Candidate c, Box clip, IReadOnlyList<(Candidate C, Box Clip)> texts)
    {
        var small = clip.W <= 64 && clip.H <= 64;
        var word = c.Role switch
        {
            "Image" => small ? "图标" : "图片",
            "Button" => "按钮",
            "Hyperlink" => "链接",
            "Edit" => "输入框",
            "CheckBox" => "复选框",
            "MenuItem" => "菜单项",
            "TabItem" => "标签页",
            "ListItem" => "列表项",
            _ => small ? "图标按钮" : "可点击区域",
        };
        var label = word;
        if (!string.IsNullOrEmpty(c.Hint)) label += " " + c.Hint;
        // 最近的文字：先找框内，再找 150px 内最近的。
        string? near = null;
        var best = long.MaxValue;
        foreach (var (t, tb) in texts)
        {
            if (ReferenceEquals(t, c)) continue;
            long d;
            if (!small && clip.Contains(tb.Cx, tb.Cy)) d = 0;
            else
            {
                long dx = tb.Cx - clip.Cx, dy = tb.Cy - clip.Cy;
                d = dx * dx + dy * dy;
                if (d > 150L * 150) continue;
                d += 1;
            }
            if (t.Source != "uia") d += 60L * 60; // 优先用 UIA 原文作近邻，OCR 容易有错字
            if (d < best) { best = d; near = t.Name; }
        }
        if (near != null) label += "（近：" + (near.Length > 20 ? near[..20] + "…" : near) + "）";
        return label;
    }

    /// <summary>从 CSS 类名里挑出有意义的提示词，如 "css-175oi2r r-6koalj product-card-base__add-cart-icon" → "add-cart-icon"。</summary>
    internal static string? ClassHint(string? className)
    {
        if (string.IsNullOrWhiteSpace(className)) return null;
        string? best = null;
        foreach (var raw in className.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var t = raw;
            if (Regex.IsMatch(t, "^(css|r)-[0-9a-z]+$") || t.StartsWith("wrapper--", StringComparison.Ordinal)
                || t is "undefined" or "icon" or "img" or "image") continue;
            if (t.Contains("__", StringComparison.Ordinal)) t = t[(t.LastIndexOf("__", StringComparison.Ordinal) + 2)..];
            else if (t.Contains("--", StringComparison.Ordinal)) t = t[(t.LastIndexOf("--", StringComparison.Ordinal) + 2)..];
            t = Regex.Replace(t, "_[0-9A-Za-z]{5}$", ""); // CSS modules 哈希后缀
            if (t.Length < 3 || Regex.IsMatch(t, "^[0-9a-f]+$")) continue;
            best = t;
        }
        return best is { Length: > 30 } ? best[..30] : best;
    }

    internal static string Normalize(string? value)
    {
        var s = string.Join(" ", (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return s.Length <= NameMax ? s : s[..NameMax] + "…";
    }

    /// <summary>"x,y,w,h"（物理像素）。</summary>
    internal static bool TryParseRegion(string? text, out Box box)
    {
        box = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var parts = text.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length != 4) return false;
        var v = new int[4];
        for (var i = 0; i < 4; i++)
            if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out v[i])) return false;
        box = new Box(v[0], v[1], v[2], v[3]);
        return !box.IsEmpty;
    }

    /// <summary>OCR 单词合成行文字：CJK 之间不加空格。</summary>
    internal static string JoinOcrWords(IEnumerable<string> words)
    {
        var sb = new System.Text.StringBuilder();
        string? prev = null;
        foreach (var w in words)
        {
            if (w.Length == 0) continue;
            if (prev != null && !(IsCjk(prev[^1]) && IsCjk(w[0]))) sb.Append(' ');
            sb.Append(w);
            prev = w;
        }
        return sb.ToString();
    }

    static bool IsCjk(char c) =>
        (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3000 && c <= 0x303F)
        || (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0x3040 && c <= 0x30FF);

    /// <summary>
    /// 视觉兜底：在 BGRA 像素里找“红/橙色实心圆形、中心为白色”的小按钮（电商页常见的“+”加购按钮）。
    /// 条件：饱和红橙色像素的连通块，外框 18–56px、长宽比 0.75–1.33、填充率 0.45–0.92（圆形扣掉白色“+”），
    /// 外框中心像素接近白色。返回图像坐标的外框。
    /// </summary>
    internal static List<Box> FindRoundAccentButtons(byte[] bgra, int width, int height, int stride)
    {
        var result = new List<Box>();
        if (width <= 0 || height <= 0) return result;
        var mask = new bool[width * height];
        for (var y = 0; y < height; y++)
        {
            var row = y * stride;
            for (var x = 0; x < width; x++)
            {
                var i = row + x * 4;
                int b = bgra[i], g = bgra[i + 1], r = bgra[i + 2];
                mask[y * width + x] = IsAccent(r, g, b);
            }
        }
        var seen = new bool[width * height];
        var stack = new Stack<int>();
        for (var start = 0; start < mask.Length; start++)
        {
            if (!mask[start] || seen[start]) continue;
            int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1, count = 0;
            stack.Push(start);
            seen[start] = true;
            while (stack.Count > 0)
            {
                var p = stack.Pop();
                int px = p % width, py = p / width;
                count++;
                if (px < minX) minX = px; if (px > maxX) maxX = px;
                if (py < minY) minY = py; if (py > maxY) maxY = py;
                if (count > 4000) break;
                Visit(px - 1, py); Visit(px + 1, py); Visit(px, py - 1); Visit(px, py + 1);
            }
            stack.Clear();
            int w = maxX - minX + 1, h = maxY - minY + 1;
            if (w is < 18 or > 56 || h is < 18 or > 56) continue;
            if (w * 4 < h * 3 || h * 4 < w * 3) continue;
            var fill = count / (double)(w * h);
            if (fill is < 0.45 or > 0.92) continue;
            var ci = (minY + h / 2) * stride + (minX + w / 2) * 4;
            if (bgra[ci] < 200 || bgra[ci + 1] < 200 || bgra[ci + 2] < 200) continue;
            result.Add(new Box(minX, minY, w, h));

            void Visit(int x, int y)
            {
                if (x < 0 || y < 0 || x >= width || y >= height) return;
                var k = y * width + x;
                if (seen[k] || !mask[k]) return;
                seen[k] = true;
                stack.Push(k);
            }
        }
        return result;
    }

    static bool IsAccent(int r, int g, int b) => r >= 200 && g <= 140 && b <= 140 && r - g >= 90 && r - b >= 90;
}