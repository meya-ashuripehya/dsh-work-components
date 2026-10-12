namespace DSHDesktopBroker.Tests;

using B = ElementLocator.Box;
using C = ElementLocator.Candidate;

public class ElementLocatorTests
{
    static readonly B Window = new(1072, 326, 416, 781);

    [Fact]
    public void Pick_ReturnsClippedCenters_InReadingOrder()
    {
        var r = ElementLocator.Pick(new[]
        {
            new C("商家", "Text", new B(1265, 417, 31, 16), "uia", false),
            new C("外卖", "Text", new B(1086, 415, 38, 20), "uia", false),
            new C("搜索商品", "Text", new B(1141, 363, 60, 21), "uia", false),
        }, Window, null, null, 10);
        Assert.Equal(new[] { "搜索商品", "外卖", "商家" }, r.Items.Select(i => i.Name));
        Assert.Equal((1105, 425), (r.Items[1].X, r.Items[1].Y));
    }

    [Fact]
    public void Pick_DropsOutsideOrMostlyHidden_AndNamedContainers()
    {
        var r = ElementLocator.Pick(new[]
        {
            new C("轮播外", "Text", new B(1669, -79, 87, 22), "uia", false),          // 窗口外
            new C("半露", "Text", new B(1042, 400, 40, 20), "uia", false),             // 25% 可见
            new C("可竖向滚动", "Group", new B(1100, 400, 288, 38), "uia", false),     // 容器标签
            new C("", "Text", new B(1100, 500, 30, 20), "uia", false),                 // 无名、不可交互
            new C("", "Button", new B(1100, 600, 30, 20), "uia", true),                // 无名但可交互：保留
        }, Window, null, null, 10);
        Assert.Single(r.Items);
        Assert.Equal("Button", r.Items[0].Role);
        Assert.StartsWith("按钮", r.Items[0].Name);
        Assert.Equal(ElementLocator.Mid, r.Items[0].Confidence);
    }

    [Fact]
    public void Pick_DropsOcrOverlappingUia_KeepsOcrOnlyIcons()
    {
        var r = ElementLocator.Pick(new[]
        {
            new C("抹茶布蕾蛋糕珍珠", "Text", new B(1330, 513, 125, 19), "uia", false),
            new C("外卖抹茶布蕾蛋糕珍珠", "Text", new B(1304, 515, 150, 15), "ocr", false),
            new C("+", "Text", new B(1453, 603, 22, 22), "ocr", false),
        }, Window, null, null, 10);
        Assert.Equal(new[] { "抹茶布蕾蛋糕珍珠", "+" }, r.Items.Select(i => i.Name));
        Assert.Equal("ocr", r.Items[1].Source);
    }

    [Fact]
    public void Pick_MergesSameNameNearby_FiltersQueryRegionAndLimit()
    {
        var items = Enumerable.Range(0, 30)
            .Select(i => new C($"商品{i}", "Text", new B(1100, 400 + i * 20, 60, 16), "uia", false))
            .Append(new C("商品0", "Text", new B(1102, 401, 60, 16), "uia", false))
            .ToList();
        var all = ElementLocator.Pick(items, Window, null, null, 5);
        Assert.Equal(30, all.Total);
        Assert.Equal(5, all.NextOffset);
        Assert.Equal(5, all.Items.Count);
        var last = ElementLocator.Pick(items, Window, null, null, 5, offset: 25);
        Assert.Null(last.NextOffset);
        Assert.Equal("商品29", last.Items[^1].Name);

        var q = ElementLocator.Pick(items, Window, null, "商品1", 50);
        Assert.Equal(11, q.Total); // 商品1, 商品10..19

        var reg = ElementLocator.Pick(items, Window, new B(1072, 400, 416, 40), null, 50);
        Assert.Equal(new[] { "商品0", "商品1" }, reg.Items.Select(i => i.Name));
    }

    [Theory]
    [InlineData("10,20,30,40", true)]
    [InlineData("10, 20, 30, 40", true)]
    [InlineData("10,20,0,40", false)]
    [InlineData("a,b,c,d", false)]
    [InlineData("", false)]
    public void TryParseRegion(string text, bool ok) => Assert.Equal(ok, ElementLocator.TryParseRegion(text, out _));

    [Fact]
    public void JoinOcrWords_NoSpaceBetweenCjk()
    {
        Assert.Equal("外卖抹茶 ¥ 18", ElementLocator.JoinOcrWords(new[] { "外", "卖", "抹", "茶", "¥", "18" }));
        Assert.Equal("Hello world", ElementLocator.JoinOcrWords(new[] { "Hello", "world" }));
    }

    [Fact]
    public void Pick_UnnamedInteractive_GetsSynthesizedLabelWithNearestText()
    {
        var r = ElementLocator.Pick(new[]
        {
            new C("", "Group", new B(1789, 189, 23, 23), "uia", true, Hint: "add-cart-icon"),
            new C("红豆夹心糯糯珠抹茶", "Text", new B(1700, 150, 120, 20), "uia", false),
            new C("", "Image", new B(1636, 803, 44, 45), "uia", false, Hint: "cartImg"),
            new C("运费", "Text", new B(1692, 816, 30, 15), "uia", false),
            new C("", "Image", new B(1720, 213, 123, 122), "uia", false, Hint: "image"), // 大图：丢弃
        }, new B(1600, 71, 450, 900), null, null, 20);
        Assert.Contains(r.Items, i => i.Name == "图标按钮 add-cart-icon（近：红豆夹心糯糯珠抹茶）" && i.Confidence == ElementLocator.Mid);
        Assert.Contains(r.Items, i => i.Name == "图标 cartImg（近：运费）" && i.Confidence == ElementLocator.Low);
        Assert.Equal(4, r.Total);
        Assert.Single(ElementLocator.Pick(r.Items.Select(i => new C(i.Name, i.Role, i.Bounds, i.Source, true)), new B(1600, 71, 450, 900), null, "add-cart", 5).Items);
    }

    [Fact]
    public void Pick_OcrLoneGlyph_BecomesLowConfidencePlus_UnlessVisualCoversIt()
    {
        var glyph = new C("0", "Text", new B(1453, 603, 22, 22), "ocr", false);
        var alone = ElementLocator.Pick(new[] { glyph }, Window, null, null, 10);
        Assert.Equal("+", alone.Items[0].Name);
        Assert.Equal(ElementLocator.Low, alone.Items[0].Confidence);
        Assert.Contains("0", alone.Items[0].Note);

        var withVisual = ElementLocator.Pick(new[]
        {
            glyph,
            new C("红色圆形按钮", "Icon", new B(1452, 602, 24, 24), "visual", true, Confidence: ElementLocator.Low),
            new C("0", "Text", new B(1100, 500, 16, 16), "ocr", false), // 没配上色块的孤立字形：丢弃
        }, Window, null, null, 10);
        var only = Assert.Single(withVisual.Items);
        Assert.Equal("visual", only.Source);
        Assert.Equal(ElementLocator.Mid, only.Confidence);
        Assert.StartsWith("+ 按钮", only.Name);
    }

    [Fact]
    public void Pick_MergesPriceFragmentsOnSameLine()
    {
        var r = ElementLocator.Pick(new[]
        {
            new C("16", "Text", new B(1309, 593, 20, 19), "uia", false),
            new C("¥", "Text", new B(1301, 598, 9, 14), "uia", false),
            new C("单件预估", "Text", new B(1330, 618, 49, 15), "uia", false),
        }, Window, null, null, 10);
        Assert.Equal(new[] { "¥16", "单件预估" }, r.Items.Select(i => i.Name));
    }

    [Theory]
    [InlineData("css-175oi2r r-6koalj product-card-base__add-cart-icon", "add-cart-icon")]
    [InlineData("cartImg_JcsEs", "cartImg")]
    [InlineData("upArrow_3ImOB wrapper--upArrow_3ImOB", "upArrow")]
    [InlineData("css-175oi2r r-6koalj", null)]
    [InlineData("", null)]
    public void ClassHint_PicksMeaningfulToken(string cls, string? expected) => Assert.Equal(expected, ElementLocator.ClassHint(cls));

    [Fact]
    public void FindRoundAccentButtons_FindsRedCircleWithWhitePlus_IgnoresTextAndBars()
    {
        const int w = 120, h = 60, stride = w * 4;
        var px = new byte[stride * h];
        void Set(int x, int y, byte r, byte g, byte b) { var i = y * stride + x * 4; px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255; }
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) Set(x, y, 255, 255, 255);
        // 红色实心圆（直径 24），中间白色“+”
        for (var y = 0; y < 24; y++) for (var x = 0; x < 24; x++)
        {
            var dx = x - 11.5; var dy = y - 11.5;
            if (dx * dx + dy * dy > 144) continue;
            var plus = (Math.Abs(dx) < 2 && Math.Abs(dy) < 7) || (Math.Abs(dy) < 2 && Math.Abs(dx) < 7);
            if (!plus) Set(10 + x, 10 + y, 250, 70, 60);
        }
        // 红色细竖条（选中指示）：长宽比不符
        for (var y = 5; y < 45; y++) for (var x = 60; x < 64; x++) Set(x, y, 230, 30, 30);
        // 红色小字块（10px）：太小
        for (var y = 30; y < 40; y++) for (var x = 80; x < 90; x++) Set(x, y, 230, 30, 30);
        var found = ElementLocator.FindRoundAccentButtons(px, w, h, stride);
        var b = Assert.Single(found);
        Assert.InRange(b.X, 9, 11);
        Assert.InRange(b.W, 22, 25);
    }
}
