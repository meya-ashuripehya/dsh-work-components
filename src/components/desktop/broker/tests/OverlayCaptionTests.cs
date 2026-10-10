namespace DSHDesktopBroker.Tests;

public class OverlayCaptionTests
{
    [Fact]
    public void ComboSplitsIntoKeycaps()
    {
        Assert.Equal(["Ctrl", "Enter"], OverlayCaption.KeyChips("ctrl+enter", 1));
    }

    [Fact]
    public void RepeatAddsTimesChip()
    {
        Assert.Equal(["Tab", "×3"], OverlayCaption.KeyChips("tab", 3));
    }

    [Fact]
    public void ArrowsUseSymbols()
    {
        Assert.Equal(["↑"], OverlayCaption.KeyChips("up", 1));
    }

    [Fact]
    public void TypeLineCollapsesNewlinesAndScrollsWhenLong()
    {
        Assert.Equal("你好", OverlayCaption.TypeLine("  你好\n"));
        Assert.False(OverlayCaption.TypeScrolls("你好"));
        var longLine = new string('字', 40);
        Assert.Equal(longLine, OverlayCaption.TypeLine(longLine));
        Assert.True(OverlayCaption.TypeScrolls(longLine));
        Assert.Equal(240, OverlayCaption.TypeLine(new string('字', 300)).Length);
    }
}
