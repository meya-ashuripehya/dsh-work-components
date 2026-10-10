namespace DSHDesktopBroker.Tests;

public class CursorMotionTests
{
    [Fact]
    public void EntersFromTheNearestScreenEdge()
    {
        var left = CursorMotion.OffscreenStart(12, 400, 0, 0, 1920, 1080);
        Assert.True(left.x < 0);
        Assert.Equal(1f, left.departX);

        var right = CursorMotion.OffscreenStart(1900, 400, 0, 0, 1920, 1080);
        Assert.True(right.x > 1920);
        Assert.Equal(-1f, right.departX);

        var top = CursorMotion.OffscreenStart(800, 8, 0, 0, 1920, 1080);
        Assert.True(top.y < 0);
        Assert.Equal(1f, top.departY);

        var bottom = CursorMotion.OffscreenStart(800, 1060, 0, 0, 1920, 1080);
        Assert.True(bottom.y > 1080);
        Assert.Equal(-1f, bottom.departY);
    }

    [Fact]
    public void ArrivalHeadsTowardTheUpperLeft()
    {
        var plan = CursorMotion.Build(40, 40, 700, 520, 0, 0);
        Assert.True(plan.Moves);
        CursorMotion.Sample(plan, 0f, out var x0, out var y0, out _);
        CursorMotion.Sample(plan, 1f, out var x1, out var y1, out var heading);
        Assert.Equal(40f, x0, 1);
        Assert.Equal(40f, y0, 1);
        Assert.Equal(700f, x1, 1);
        Assert.Equal(520f, y1, 1);
        var rest = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
        Assert.Equal(rest, heading, 0.12f);
        Assert.InRange(plan.DurationMs, 260, 860);
    }

    [Fact]
    public void AMoveAlreadyOnTheRestHeadingStaysStraight()
    {
        var rest = MathF.Atan2(CursorMotion.RestDy, CursorMotion.RestDx);
        var fromX = 400f - CursorMotion.RestDx * 240f;
        var fromY = 300f - CursorMotion.RestDy * 240f;
        var plan = CursorMotion.Build(fromX, fromY, 400, 300, 0, 0);
        CursorMotion.Sample(plan, 0.5f, out var x, out var y, out var heading);
        var midX = (fromX + 400f) / 2f;
        var midY = (fromY + 300f) / 2f;
        Assert.InRange(MathF.Abs(x - midX), 0, 8);
        Assert.InRange(MathF.Abs(y - midY), 0, 8);
        Assert.Equal(rest, heading, 0.2f);
    }
}
