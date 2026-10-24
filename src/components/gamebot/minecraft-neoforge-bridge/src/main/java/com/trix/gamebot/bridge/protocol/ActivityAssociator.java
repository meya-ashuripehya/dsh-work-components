package com.trix.gamebot.bridge.protocol;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 与 Python activity.associate_block_changes 使用同一公式。
 * 目标点是方块中心 (x+0.5, y+0.5, z+0.5)。推断不是精确右键。
 */
public final class ActivityAssociator {
    public static final long WINDOW_MS = 500L;
    public static final double MAX_DISTANCE = 6.0;
    public static final double MIN_DOT = 0.5;

    public record Swing(
            String player,
            String uuid,
            long timeMs,
            double x,
            double y,
            double z,
            double lookX,
            double lookY,
            double lookZ
    ) {
    }

    public record Change(long timeMs, String blockId, int x, int y, int z) {
    }

    public record Inference(
            String player,
            String uuid,
            String blockId,
            int x,
            int y,
            int z,
            double confidence,
            List<String> evidence
    ) {
    }

    private ActivityAssociator() {
    }

    public static double roundHalfUp(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.floor(value * factor + 0.5d) / factor;
    }

    public static List<Inference> associate(List<Swing> swings, List<Change> changes) {
        List<Change> ordered = new ArrayList<>(changes);
        ordered.sort(Comparator.comparingLong(Change::timeMs));
        List<Inference> results = new ArrayList<>();
        for (Change change : ordered) {
            Inference best = null;
            double bestConfidence = -1.0;
            double cx = change.x + 0.5;
            double cy = change.y + 0.5;
            double cz = change.z + 0.5;
            for (Swing swing : swings) {
                long dt = change.timeMs - swing.timeMs;
                if (dt < 0 || dt > WINDOW_MS) {
                    continue;
                }
                double dx = cx - swing.x;
                double dy = cy - swing.y;
                double dz = cz - swing.z;
                double[] vector = unit(dx, dy, dz);
                double[] look = unit(swing.lookX, swing.lookY, swing.lookZ);
                if (vector == null || look == null) {
                    continue;
                }
                double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (distance > MAX_DISTANCE) {
                    continue;
                }
                double dot = look[0] * vector[0] + look[1] * vector[1] + look[2] * vector[2];
                if (dot < MIN_DOT) {
                    continue;
                }
                double confidence = roundHalfUp(dot * (1.0 - dt / (double) WINDOW_MS) * (1.0 - distance / MAX_DISTANCE), 3);
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    best = new Inference(
                            swing.player,
                            swing.uuid,
                            change.blockId,
                            change.x,
                            change.y,
                            change.z,
                            confidence,
                            List.of("player_swing", "block_changed", "facing", "time_window", "distance")
                    );
                }
            }
            if (best != null) {
                results.add(best);
            }
        }
        return results;
    }

    private static double[] unit(double x, double y, double z) {
        double length = Math.sqrt(x * x + y * y + z * z);
        if (length < 1e-8) {
            return null;
        }
        return new double[]{x / length, y / length, z / length};
    }
}
