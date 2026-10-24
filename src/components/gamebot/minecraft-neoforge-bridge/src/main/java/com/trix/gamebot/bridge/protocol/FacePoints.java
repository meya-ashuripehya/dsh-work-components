package com.trix.gamebot.bridge.protocol;

/**
 * 方块面的局部中心。坐标分量都在 [0,1]。
 */
public final class FacePoints {
    private FacePoints() {
    }

    public static double[] center(String face) {
        return switch (face) {
            case "down" -> new double[]{0.5, 0.0, 0.5};
            case "up" -> new double[]{0.5, 1.0, 0.5};
            case "north" -> new double[]{0.5, 0.5, 0.0};
            case "south" -> new double[]{0.5, 0.5, 1.0};
            case "west" -> new double[]{0.0, 0.5, 0.5};
            case "east" -> new double[]{1.0, 0.5, 0.5};
            default -> null;
        };
    }
}
