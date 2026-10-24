namespace DSHDesktopBroker.Tests;

public class KeyChordTests
{
    [Theory]
    [InlineData("enter", 0x0D)]
    [InlineData("A", 0x41)]
    [InlineData("z", 0x5A)]
    [InlineData("5", 0x35)]
    [InlineData("f5", 0x74)]
    [InlineData("F12", 0x7B)]
    [InlineData("pagedown", 0x22)]
    public void SingleKeys(string name, int vk)
    {
        Assert.True(KeyChord.TryParse(name, out var mods, out var got));
        Assert.Empty(mods);
        Assert.Equal((ushort)vk, got);
    }

    [Fact]
    public void CtrlA()
    {
        Assert.True(KeyChord.TryParse("ctrl+a", out var mods, out var vk));
        Assert.Equal(new ushort[] { KeyChord.VK_CONTROL }, mods);
        Assert.Equal((ushort)0x41, vk);
    }

    [Fact]
    public void CtrlShiftT_WithSpaces()
    {
        Assert.True(KeyChord.TryParse(" Ctrl + Shift + T ", out var mods, out var vk));
        Assert.Equal(new ushort[] { KeyChord.VK_CONTROL, KeyChord.VK_SHIFT }, mods);
        Assert.Equal((ushort)0x54, vk);
    }

    [Theory]
    [InlineData("")]
    [InlineData("foo")]
    [InlineData("a+ctrl+b")]
    [InlineData("f13")]
    public void Rejects(string name) => Assert.False(KeyChord.TryParse(name, out _, out _));
}