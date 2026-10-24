package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Immutable exclusion zones for navigation. Empty when omitted. */
public final class MovementExclusions {
    public static final MovementExclusions NONE = new MovementExclusions(List.of(), 0);

    private final List<AABB> boxes;
    private final int version;

    private MovementExclusions(List<AABB> boxes, int version) {
        this.boxes = boxes;
        this.version = version;
    }

    public int version() {
        return version;
    }

    public boolean isEmpty() {
        return boxes.isEmpty();
    }

    public boolean contains(Vec3 point) {
        for (AABB box : boxes) {
            if (box.contains(point)) {
                return true;
            }
        }
        return false;
    }

    public boolean segmentCrosses(Vec3 from, Vec3 to) {
        if (boxes.isEmpty()) {
            return false;
        }
        int steps = Math.max(1, (int) Math.ceil(from.distanceTo(to) * 4.0));
        for (int i = 0; i <= steps; i++) {
            double t = i / (double) steps;
            Vec3 sample = from.lerp(to, t);
            if (contains(sample)) {
                return true;
            }
        }
        return false;
    }

    public static MovementExclusions parse(JsonObject params) {
        if (params == null || !params.has("exclusions") || !params.get("exclusions").isJsonArray()) {
            return NONE;
        }
        JsonArray array = params.getAsJsonArray("exclusions");
        List<AABB> boxes = new ArrayList<>();
        int version = 0;
        for (JsonElement element : array) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject box = element.getAsJsonObject();
            if (box.has("version")) {
                version = Math.max(version, box.get("version").getAsInt());
            }
            double x1 = box.get("x1").getAsDouble();
            double y1 = box.get("y1").getAsDouble();
            double z1 = box.get("z1").getAsDouble();
            double x2 = box.get("x2").getAsDouble();
            double y2 = box.get("y2").getAsDouble();
            double z2 = box.get("z2").getAsDouble();
            boxes.add(new AABB(x1, y1, z1, x2, y2, z2));
        }
        return boxes.isEmpty() ? NONE : new MovementExclusions(Collections.unmodifiableList(boxes), version);
    }

    public void writeEvidence(JsonObject evidence) {
        evidence.addProperty("exclusions_applied", !boxes.isEmpty());
        evidence.addProperty("exclusions_version", version);
        if (boxes.isEmpty()) {
            evidence.addProperty("exclusions_note", "no external exclusion zones were supplied");
        } else {
            evidence.addProperty("exclusion_box_count", boxes.size());
        }
    }
}
