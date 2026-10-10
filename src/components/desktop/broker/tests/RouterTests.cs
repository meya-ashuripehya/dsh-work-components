namespace DSHDesktopBroker.Tests;

public class RouterTests
{
    static RouteInput Input(DesktopAction action, Action<RouteBuilder>? configure = null)
    {
        var builder = new RouteBuilder { Action = action };
        configure?.Invoke(builder);
        return builder.Build();
    }

    [Fact]
    public void HigherIntegrityWithoutUiAccessIsDenied()
    {
        foreach (var action in new[] { DesktopAction.Click, DesktopAction.Type, DesktopAction.Key, DesktopAction.Invoke, DesktopAction.ClickScreen, DesktopAction.Scroll, DesktopAction.ScrollScreen })
        {
            var decision = Router.Decide(Input(action, b =>
            {
                b.TargetHigherIntegrity = true;
                b.HasInvoke = true;
                b.HasValue = true;
                b.HasBounds = true;
                b.HasScroll = true;
                b.IsChromiumEdit = true;
                b.ChromiumHostFound = true;
            }));
            Assert.Equal(RouteChannel.Deny, decision.Channel);
            Assert.Equal("deny", decision.Via);
            Assert.Contains("UIAccess", decision.Reason, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void HigherIntegrityWithUiAccessIsNotDenied()
    {
        var decision = Router.Decide(Input(DesktopAction.Click, b =>
        {
            b.TargetHigherIntegrity = true;
            b.SelfHasUiAccess = true;
            b.HasInvoke = true;
        }));
        Assert.Equal(RouteChannel.Pattern, decision.Channel);
        Assert.Equal("invoke", decision.Via);
    }

    [Fact]
    public void ChromiumTypeUsesWmCharWhenHostExists()
    {
        var decision = Router.Decide(Input(DesktopAction.Type, b =>
        {
            b.IsChromiumEdit = true;
            b.ChromiumHostFound = true;
            b.HasValue = true;
        }));
        Assert.Equal(RouteChannel.Chromium, decision.Channel);
        Assert.Equal("chromium", decision.Via);
    }

    [Fact]
    public void ChromiumTypeFallsBackWhenClassIsMissing()
    {
        var decision = Router.Decide(Input(DesktopAction.Type, b =>
        {
            b.IsChromiumEdit = true;
            b.ChromiumHostFound = false;
            b.HasValue = true;
            b.HasBounds = true;
        }));
        Assert.Equal(RouteChannel.SendInputFallback, decision.Channel);
        Assert.Equal("sendinput-fallback", decision.Via);
    }

    [Fact]
    public void ChromiumKeyFallsBackWhenClassIsMissing()
    {
        var decision = Router.Decide(Input(DesktopAction.Key, b =>
        {
            b.IsChromiumEdit = true;
            b.ChromiumHostFound = false;
            b.HasBounds = true;
        }));
        Assert.Equal(RouteChannel.SendInputFallback, decision.Channel);
        Assert.Equal("sendinput-fallback", decision.Via);
    }

    [Fact]
    public void PlainEditUsesValuePattern()
    {
        var decision = Router.Decide(Input(DesktopAction.Type, b => b.HasValue = true));
        Assert.Equal(RouteChannel.Pattern, decision.Channel);
        Assert.Equal("value", decision.Via);
    }

    [Fact]
    public void ClickPrefersInvokeThenToggleThenSelectionThenBounds()
    {
        Assert.Equal("invoke", Router.Decide(Input(DesktopAction.Click, b =>
        {
            b.HasInvoke = true;
            b.HasToggle = true;
            b.HasBounds = true;
        })).Via);
        Assert.Equal("toggle", Router.Decide(Input(DesktopAction.Click, b =>
        {
            b.HasToggle = true;
            b.HasSelection = true;
            b.HasBounds = true;
        })).Via);
        Assert.Equal("selection", Router.Decide(Input(DesktopAction.Click, b =>
        {
            b.HasSelection = true;
            b.HasBounds = true;
        })).Via);
        Assert.Equal("sendinput", Router.Decide(Input(DesktopAction.Click, b => b.HasBounds = true)).Via);
    }

    [Fact]
    public void ClickScreenUsesSendInput()
    {
        var decision = Router.Decide(Input(DesktopAction.ClickScreen));
        Assert.Equal(RouteChannel.SendInput, decision.Channel);
        Assert.Equal("sendinput", decision.Via);
    }

    [Fact]
    public void ScrollPrefersPatternThenChromiumThenBounds()
    {
        Assert.Equal("scroll", Router.Decide(Input(DesktopAction.Scroll, b =>
        {
            b.HasScroll = true;
            b.ChromiumHostFound = true;
            b.HasBounds = true;
        })).Via);
        Assert.Equal("chromium", Router.Decide(Input(DesktopAction.Scroll, b =>
        {
            b.ChromiumHostFound = true;
            b.HasBounds = true;
        })).Via);
        Assert.Equal("sendinput", Router.Decide(Input(DesktopAction.Scroll, b => b.HasBounds = true)).Via);
    }

    [Fact]
    public void ScrollWithoutPatternHostOrBoundsIsDenied()
    {
        var decision = Router.Decide(Input(DesktopAction.Scroll));
        Assert.Equal(RouteChannel.Deny, decision.Channel);
        Assert.Equal(Router.DenyNoWay, decision.Reason);
    }

    [Fact]
    public void ScrollScreenUsesSendInput()
    {
        var decision = Router.Decide(Input(DesktopAction.ScrollScreen));
        Assert.Equal(RouteChannel.SendInput, decision.Channel);
        Assert.Equal("sendinput", decision.Via);
    }

    [Fact]
    public void ClickWithoutPatternOrBoundsIsDenied()
    {
        var decision = Router.Decide(Input(DesktopAction.Click));
        Assert.Equal(RouteChannel.Deny, decision.Channel);
        Assert.Equal(Router.DenyNoWay, decision.Reason);
    }

    sealed class RouteBuilder
    {
        public DesktopAction Action { get; set; }
        public bool HasInvoke { get; set; }
        public bool HasToggle { get; set; }
        public bool HasSelection { get; set; }
        public bool HasValue { get; set; }
        public bool IsChromiumEdit { get; set; }
        public bool ChromiumHostFound { get; set; }
        public bool HasBounds { get; set; }
        public bool HasScroll { get; set; }
        public bool TargetHigherIntegrity { get; set; }
        public bool SelfHasUiAccess { get; set; }

        public RouteInput Build() => new()
        {
            Action = Action,
            HasInvoke = HasInvoke,
            HasToggle = HasToggle,
            HasSelection = HasSelection,
            HasValue = HasValue,
            IsChromiumEdit = IsChromiumEdit,
            ChromiumHostFound = ChromiumHostFound,
            HasBounds = HasBounds,
            HasScroll = HasScroll,
            TargetHigherIntegrity = TargetHigherIntegrity,
            SelfHasUiAccess = SelfHasUiAccess,
        };
    }
}
