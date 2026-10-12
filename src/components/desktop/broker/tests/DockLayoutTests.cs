namespace DSHDesktopBroker.Tests;

public class DockLayoutTests
{
    [Fact]
    public void Compute_DocksDshAtMinVisibleWidthOnRight()
    {
        // Ash measured: work 1920x1080, DSH min outer 536, insets L7 R7 T0 B7 → visible 522
        var input = new DockLayout.LayoutInput(
            Work: new DockLayout.Rect(0, 0, 1920, 1080),
            DshMinOuter: new DockLayout.Size(536, 608),
            DshInsets: new DockLayout.FrameInsets(7, 0, 7, 7),
            TargetMinOuter: new DockLayout.Size(673, 151),
            TargetInsets: new DockLayout.FrameInsets(7, 0, 7, 7));

        var result = DockLayout.Compute(input);

        Assert.Equal(522, result.DockVisibleWidth);
        Assert.Equal(1920 - 522, result.TargetVisibleWidth);
        Assert.False(result.TargetMinExceeded);

        // Visible frames flush at 1398
        var dshFrameLeft = result.DshOuter.Left + 7;
        var dshFrameRight = result.DshOuter.Right - 7;
        Assert.Equal(1398, dshFrameLeft);
        Assert.Equal(1920, dshFrameRight);

        var targetFrameRight = result.TargetOuter.Right - 7;
        Assert.Equal(1398, targetFrameRight);
        Assert.Equal(0 - 7, result.TargetOuter.Left); // work.left - inset.left
    }

    [Fact]
    public void Compute_ReportsWhenTargetMinExceedsAvailable()
    {
        var input = new DockLayout.LayoutInput(
            Work: new DockLayout.Rect(0, 0, 1000, 800),
            DshMinOuter: new DockLayout.Size(400, 400),
            DshInsets: new DockLayout.FrameInsets(0, 0, 0, 0),
            TargetMinOuter: new DockLayout.Size(700, 200),
            TargetInsets: new DockLayout.FrameInsets(0, 0, 0, 0));

        var result = DockLayout.Compute(input);
        Assert.Equal(400, result.DockVisibleWidth);
        Assert.Equal(600, result.TargetVisibleWidth);
        Assert.True(result.TargetMinExceeded);
    }

    static DockLayout.SizingInput S(bool resizable = true, string proc = "chrome", string cls = "Chrome_WidgetWin_1", int maxW = 0, int avail = 2038) =>
        new(resizable, proc, cls, maxW, avail);

    [Fact]
    public void Sizing_NormalResizableWindowFills()
    {
        Assert.Equal(DockLayout.SizeMode.Fill, DockLayout.DecideSizing(S()));
        // Weixin main window on Ash: maxTrack 2576 > available
        Assert.Equal(DockLayout.SizeMode.Fill, DockLayout.DecideSizing(S(proc: "Weixin", cls: "Qt51514QWindowIcon", maxW: 2576)));
    }

    [Fact]
    public void Sizing_WeChatMiniProgramKeepsSize()
    {
        // Ash evidence: WeChatAppEx, Chrome_WidgetWin_0, style 0x16CF0000 (resizable), maxTrack 845x1525
        Assert.Equal(DockLayout.SizeMode.KeepSize, DockLayout.DecideSizing(S(proc: "WeChatAppEx", cls: "Chrome_WidgetWin_0", maxW: 845)));
        Assert.Equal(DockLayout.SizeMode.KeepSize, DockLayout.DecideSizing(S(proc: "wechatappex", maxW: 0, avail: 600)));
    }

    [Fact]
    public void Sizing_NonResizableOrSmallMaxTrackKeepsSize()
    {
        Assert.Equal(DockLayout.SizeMode.KeepSize, DockLayout.DecideSizing(S(resizable: false)));
        Assert.Equal(DockLayout.SizeMode.KeepSize, DockLayout.DecideSizing(S(maxW: 900, avail: 2038)));
    }

    [Fact]
    public void PlaceKeepSize_FlushAgainstDockAndClampsVertically()
    {
        var ins = new DockLayout.FrameInsets(7, 0, 7, 7);
        var work = new DockLayout.Rect(0, 0, 2560, 1440);
        // 604-wide visible window, top hanging below work bottom
        var cur = new DockLayout.Rect(100, 1000, 100 + 618, 1000 + 907);
        var r = DockLayout.PlaceKeepSize(cur, ins, work, dockFrameLeft: 2038);
        Assert.Equal(2038, r.Right - 7);          // visible right edge flush with DSH
        Assert.Equal(618, r.Width);               // size kept
        Assert.Equal(907, r.Height);
        Assert.Equal(1440 - 900, r.Top);          // clamped so visible bottom = work bottom
    }

    [Fact]
    public void PlaceKeepSize_TooWideFallsBackToWorkLeft()
    {
        var ins = new DockLayout.FrameInsets(0, 0, 0, 0);
        var work = new DockLayout.Rect(0, 0, 1000, 800);
        var r = DockLayout.PlaceKeepSize(new DockLayout.Rect(50, 50, 850, 450), ins, work, dockFrameLeft: 600);
        Assert.Equal(0, r.Left);
        Assert.Equal(800, r.Width);
        Assert.Equal(50, r.Top);
    }

    [Fact]
    public void FrameInsets_FromOuterAndFrame()
    {
        var outer = new DockLayout.Rect(1391, 0, 1927, 1087);
        var frame = new DockLayout.Rect(1398, 0, 1920, 1080);
        var insets = DockLayout.FrameInsets.FromOuterAndFrame(outer, frame);
        Assert.Equal(7, insets.Left);
        Assert.Equal(0, insets.Top);
        Assert.Equal(7, insets.Right);
        Assert.Equal(7, insets.Bottom);
    }

    [Fact]
    public void FrameToOuter_RoundTrips()
    {
        var frame = new DockLayout.Rect(100, 20, 500, 700);
        var insets = new DockLayout.FrameInsets(7, 0, 7, 7);
        var outer = DockLayout.FrameToOuter(frame, insets);
        Assert.Equal(93, outer.Left);
        Assert.Equal(20, outer.Top);
        Assert.Equal(507, outer.Right);
        Assert.Equal(707, outer.Bottom);
    }
}
