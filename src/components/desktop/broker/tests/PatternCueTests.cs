namespace DSHDesktopBroker.Tests;

public class PatternCueTests
{
    [Theory]
    [InlineData("invoke")]
    [InlineData("toggle")]
    [InlineData("selection")]
    public void ClickLikePatternsPlayClickRing(string via)
    {
        Assert.Equal(OverlayKind.Click, DesktopSession.PatternCue(via));
    }

    [Fact]
    public void SetValuePlaysTypingCue()
    {
        Assert.Equal(OverlayKind.Type, DesktopSession.PatternCue("value"));
    }

    [Theory]
    [InlineData("scroll")]
    [InlineData("sendinput")]
    [InlineData("chromium")]
    [InlineData("deny")]
    [InlineData("")]
    [InlineData(null)]
    public void OtherViasGetNoPatternCue(string? via)
    {
        Assert.Null(DesktopSession.PatternCue(via));
    }

    [Fact]
    public void EveryClickOrTypePatternRouteHasACue()
    {
        var inputs = new[]
        {
            new RouteInput { Action = DesktopAction.Invoke, HasInvoke = true },
            new RouteInput { Action = DesktopAction.Invoke, HasToggle = true },
            new RouteInput { Action = DesktopAction.Invoke, HasSelection = true },
            new RouteInput { Action = DesktopAction.Click, HasInvoke = true },
            new RouteInput { Action = DesktopAction.Click, HasToggle = true },
            new RouteInput { Action = DesktopAction.Click, HasSelection = true },
            new RouteInput { Action = DesktopAction.Type, HasValue = true },
        };
        foreach (var input in inputs)
        {
            var decision = Router.Decide(input);
            Assert.Equal(RouteChannel.Pattern, decision.Channel);
            Assert.NotNull(DesktopSession.PatternCue(decision.Via));
        }
    }

}
