namespace DSHDesktopBroker;

/// <summary>
/// 光标移动路径。静止时箭头朝向左上约 30°（相对竖直方向偏左），
/// 移动中箭头顺着速度方向，临近落点时收回这个朝向。
/// </summary>
static class CursorMotion
{
    internal const float RestDx = -0.5f;
    internal const float RestDy = -0.8660254f;

    internal readonly struct Plan
    {
        public float X0 { get; init; }
        public float Y0 { get; init; }
        public float X1 { get; init; }
        public float Y1 { get; init; }
        public float X2 { get; init; }
        public float Y2 { get; init; }
        public float X3 { get; init; }
        public float Y3 { get; init; }
        public int DurationMs { get; init; }
        public bool Moves { get; init; }
    }

    /// <summary>从离落点最近的屏幕边外侧入场。depart 是进入屏幕的方向。</summary>
    internal static (float x, float y, float departX, float departY) OffscreenStart(
        float x, float y, float left, float top, float right, float bottom)
    {
        var margin = 64f;
        var toLeft = x - left;
        var toRight = right - x;
        var toTop = y - top;
        var toBottom = bottom - y;
        var nearest = toLeft;
        var edge = 0;
        if (toRight < nearest) { nearest = toRight; edge = 1; }
        if (toTop < nearest) { nearest = toTop; edge = 2; }
        if (toBottom < nearest) edge = 3;
        return edge switch
        {
            0 => (left - margin, y, 1f, 0f),
            1 => (right + margin, y, -1f, 0f),
            2 => (x, top - margin, 0f, 1f),
            _ => (x, bottom + margin, 0f, -1f),
        };
    }

    internal static Plan Build(float fromX, float fromY, float toX, float toY, float departX, float departY)
    {
        var dx = toX - fromX;
        var dy = toY - fromY;
        var dist = MathF.Sqrt(dx * dx + dy * dy);
        if (dist < 8f)
        {
            return new Plan { X0 = toX, Y0 = toY, X3 = toX, Y3 = toY, Moves = false };
        }

        var approach = Math.Clamp(dist * 0.34f, 42f, 88f);
        var x2 = toX - RestDx * approach;
        var y2 = toY - RestDy * approach;
        float inx;
        float iny;
        if (departX != 0f || departY != 0f)
        {
            inx = departX;
            iny = departY;
        }
        else
        {
            var vx = x2 - fromX;
            var vy = y2 - fromY;
            var vl = MathF.Sqrt(vx * vx + vy * vy);
            if (vl < 1f) { vx = dx; vy = dy; vl = Math.Max(dist, 1f); }
            inx = vx / vl;
            iny = vy / vl;
        }
        var handle = Math.Clamp(dist * 0.36f, 28f, 150f);
        var x1 = fromX + inx * handle;
        var y1 = fromY + iny * handle;

        var inv = 1f / dist;
        var aligned = dx * inv * RestDx + dy * inv * RestDy;
        if (aligned > 0.96f)
        {
            x1 = fromX + dx * 0.34f;
            y1 = fromY + dy * 0.34f;
            x2 = fromX + dx * 0.68f;
            y2 = fromY + dy * 0.68f;
        }

        var ms = (int)Math.Clamp(220f + dist * 0.62f, 260f, 860f);
        return new Plan
        {
            X0 = fromX,
            Y0 = fromY,
            X1 = x1,
            Y1 = y1,
            X2 = x2,
            Y2 = y2,
            X3 = toX,
            Y3 = toY,
            DurationMs = ms,
            Moves = true,
        };
    }

    internal static void Sample(in Plan plan, float u, out float x, out float y, out float heading)
    {
        var t = Math.Clamp(u, 0f, 1f);
        t = t * t * (3f - 2f * t);
        Cubic(plan, t, out x, out y, out var tx, out var ty);
        var len = MathF.Sqrt(tx * tx + ty * ty);
        heading = len < 0.001f ? MathF.Atan2(RestDy, RestDx) : MathF.Atan2(ty, tx);
        if (u >= 1f)
        {
            x = plan.X3;
            y = plan.Y3;
        }
    }

    static void Cubic(in Plan plan, float t, out float x, out float y, out float tx, out float ty)
    {
        var u = 1f - t;
        var uu = u * u;
        var tt = t * t;
        x = uu * u * plan.X0 + 3f * uu * t * plan.X1 + 3f * u * tt * plan.X2 + tt * t * plan.X3;
        y = uu * u * plan.Y0 + 3f * uu * t * plan.Y1 + 3f * u * tt * plan.Y2 + tt * t * plan.Y3;
        tx = 3f * uu * (plan.X1 - plan.X0) + 6f * u * t * (plan.X2 - plan.X1) + 3f * tt * (plan.X3 - plan.X2);
        ty = 3f * uu * (plan.Y1 - plan.Y0) + 6f * u * t * (plan.Y2 - plan.Y1) + 3f * tt * (plan.Y3 - plan.Y2);
    }
}
