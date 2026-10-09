namespace DSHDesktopBroker;

/// <summary>
/// 通道选择。不碰窗口，方便单测。
/// </summary>
public static class Router
{
    public const string DenyHigherIntegrity =
        "目标窗口权限更高，当前进程没有 UIAccess，不能操作这个窗口。";

    public const string DenyNoWay = "没有可用的操作方式。请重新 inspect。";

    public static RouteDecision Decide(RouteInput input)
    {
        if (input.TargetHigherIntegrity && !input.SelfHasUiAccess)
            return new RouteDecision(RouteChannel.Deny, "deny", DenyHigherIntegrity);

        switch (input.Action)
        {
            case DesktopAction.ClickScreen:
                return new RouteDecision(RouteChannel.SendInput, "sendinput", null);

            case DesktopAction.Type when input.IsChromiumEdit && input.ChromiumHostFound:
                return new RouteDecision(RouteChannel.Chromium, "chromium", null);
            case DesktopAction.Type when input.IsChromiumEdit && !input.ChromiumHostFound:
                return new RouteDecision(RouteChannel.SendInputFallback, "sendinput-fallback", null);
            case DesktopAction.Type when input.HasValue:
                return new RouteDecision(RouteChannel.Pattern, "value", null);
            case DesktopAction.Type when input.HasBounds:
                return new RouteDecision(RouteChannel.SendInput, "sendinput", null);

            case DesktopAction.Key when input.IsChromiumEdit && input.ChromiumHostFound:
                return new RouteDecision(RouteChannel.Chromium, "chromium", null);
            case DesktopAction.Key when input.IsChromiumEdit && !input.ChromiumHostFound:
                return new RouteDecision(RouteChannel.SendInputFallback, "sendinput-fallback", null);
            case DesktopAction.Key:
                return new RouteDecision(RouteChannel.SendInput, "sendinput", null);

            case DesktopAction.Invoke when input.HasInvoke:
                return new RouteDecision(RouteChannel.Pattern, "invoke", null);
            case DesktopAction.Invoke when input.HasToggle:
                return new RouteDecision(RouteChannel.Pattern, "toggle", null);
            case DesktopAction.Invoke when input.HasSelection:
                return new RouteDecision(RouteChannel.Pattern, "selection", null);

            case DesktopAction.Click when input.HasInvoke:
                return new RouteDecision(RouteChannel.Pattern, "invoke", null);
            case DesktopAction.Click when input.HasToggle:
                return new RouteDecision(RouteChannel.Pattern, "toggle", null);
            case DesktopAction.Click when input.HasSelection:
                return new RouteDecision(RouteChannel.Pattern, "selection", null);
            case DesktopAction.Click when input.HasBounds:
                return new RouteDecision(RouteChannel.SendInput, "sendinput", null);
        }

        return new RouteDecision(RouteChannel.Deny, "deny", DenyNoWay);
    }
}

public enum DesktopAction
{
    Invoke,
    Type,
    Key,
    Click,
    ClickScreen,
}

public enum RouteChannel
{
    Deny,
    Pattern,
    Chromium,
    SendInput,
    SendInputFallback,
}

public sealed record RouteInput
{
    public DesktopAction Action { get; init; }
    public bool HasInvoke { get; init; }
    public bool HasToggle { get; init; }
    public bool HasSelection { get; init; }
    public bool HasValue { get; init; }
    public bool IsChromiumEdit { get; init; }
    public bool ChromiumHostFound { get; init; }
    public bool HasBounds { get; init; }
    public bool TargetHigherIntegrity { get; init; }
    public bool SelfHasUiAccess { get; init; }
}

public sealed record RouteDecision(RouteChannel Channel, string Via, string? Reason);
