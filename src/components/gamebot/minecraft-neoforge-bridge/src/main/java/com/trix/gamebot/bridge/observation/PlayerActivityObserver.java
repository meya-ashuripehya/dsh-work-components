package com.trix.gamebot.bridge.observation;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.protocol.ActivityAssociator;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 记录其他玩家挥手和方块变化。关联结果带 inferred=true，不声称精确右键。
 */
public final class PlayerActivityObserver {
    private static final double SWING_RANGE = 16.0;
    private final Map<BlockPos, String> blocks = new HashMap<>();
    private final Map<UUID, Boolean> swinging = new HashMap<>();
    private final List<ActivityAssociator.Swing> recentSwings = new ArrayList<>();
    private BlockPos baselineOrigin = BlockPos.ZERO;
    private int baselineRadius = 8;
    private boolean baselineReady;

    public void reset() {
        blocks.clear();
        swinging.clear();
        recentSwings.clear();
        baselineReady = false;
    }

    public List<JsonObject> pollSwings(Minecraft minecraft) {
        List<JsonObject> events = new ArrayList<>();
        Player self = minecraft.player;
        if (self == null || self.level() == null) {
            return events;
        }
        long now = System.currentTimeMillis();
        for (Player other : self.level().players()) {
            if (other == self || other.getUUID().equals(self.getUUID())) {
                continue;
            }
            if (self.distanceTo(other) > SWING_RANGE) {
                continue;
            }
            boolean active = other.swinging;
            boolean was = swinging.getOrDefault(other.getUUID(), false);
            swinging.put(other.getUUID(), active);
            if (!active || was) {
                continue;
            }
            Vec3 look = other.getLookAngle();
            ActivityAssociator.Swing swing = new ActivityAssociator.Swing(
                    other.getGameProfile().getName(),
                    other.getUUID().toString(),
                    now,
                    other.getX(),
                    other.getEyeY(),
                    other.getZ(),
                    look.x,
                    look.y,
                    look.z
            );
            recentSwings.add(swing);
            events.add(swingEvent(swing));
        }
        recentSwings.removeIf(swing -> now - swing.timeMs() > 2000L);
        return events;
    }

    public List<JsonObject> pollBlockChanges(Minecraft minecraft, int radius) {
        List<JsonObject> events = new ArrayList<>();
        Player self = minecraft.player;
        if (self == null) {
            return events;
        }
        Map<BlockPos, String> next = scan(self, radius);
        BlockPos origin = self.blockPosition();
        long now = System.currentTimeMillis();
        List<ActivityAssociator.Change> changes = new ArrayList<>();
        if (baselineReady) {
            for (Map.Entry<BlockPos, String> entry : next.entrySet()) {
                if (!inside(baselineOrigin, baselineRadius, entry.getKey())) {
                    continue;
                }
                String previous = blocks.get(entry.getKey());
                if (previous != null && previous.equals(entry.getValue())) {
                    continue;
                }
                ActivityAssociator.Change change = changeOf(now, entry.getKey(), entry.getValue());
                changes.add(change);
                events.add(changeEvent(change, previous));
            }
            for (Map.Entry<BlockPos, String> entry : blocks.entrySet()) {
                if (!inside(origin, radius, entry.getKey()) || next.containsKey(entry.getKey())) {
                    continue;
                }
                ActivityAssociator.Change change = changeOf(now, entry.getKey(), "minecraft:air");
                changes.add(change);
                events.add(changeEvent(change, entry.getValue()));
            }
        }
        blocks.clear();
        blocks.putAll(next);
        baselineOrigin = origin;
        baselineRadius = Math.max(1, Math.min(16, radius));
        baselineReady = true;
        for (ActivityAssociator.Inference inference : ActivityAssociator.associate(recentSwings, changes)) {
            events.add(inferenceEvent(inference));
        }
        return events;
    }

    private static boolean inside(BlockPos origin, int radius, BlockPos pos) {
        return Math.abs(pos.getX() - origin.getX()) <= radius
                && Math.abs(pos.getY() - origin.getY()) <= radius
                && Math.abs(pos.getZ() - origin.getZ()) <= radius;
    }

    private static Map<BlockPos, String> scan(Player player, int radius) {
        int clamped = Math.max(1, Math.min(16, radius));
        BlockPos origin = player.blockPosition();
        Map<BlockPos, String> found = new HashMap<>();
        for (int dx = -clamped; dx <= clamped; dx++) {
            for (int dy = -clamped; dy <= clamped; dy++) {
                for (int dz = -clamped; dz <= clamped; dz++) {
                    BlockPos pos = origin.offset(dx, dy, dz);
                    if (!WorldQueries.chunkLoaded(player.level(), pos)) {
                        continue;
                    }
                    BlockState state = player.level().getBlockState(pos);
                    if (state.isAir()) {
                        continue;
                    }
                    found.put(pos.immutable(), BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                }
            }
        }
        return found;
    }

    private static ActivityAssociator.Change changeOf(long timeMs, BlockPos pos, String blockId) {
        return new ActivityAssociator.Change(timeMs, blockId, pos.getX(), pos.getY(), pos.getZ());
    }

    private static JsonObject swingEvent(ActivityAssociator.Swing swing) {
        JsonObject data = base(swing.player(), swing.uuid(), "player_swing", false, 1.0);
        data.add("evidence", array("player_swing"));
        JsonObject look = new JsonObject();
        look.addProperty("x", swing.lookX());
        look.addProperty("y", swing.lookY());
        look.addProperty("z", swing.lookZ());
        data.add("look", look);
        data.addProperty("time_ms", swing.timeMs());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", swing.x());
        pos.addProperty("y", swing.y());
        pos.addProperty("z", swing.z());
        data.add("pos", pos);
        data.add("block_id", JsonNull.INSTANCE);
        return data;
    }

    private static JsonObject changeEvent(ActivityAssociator.Change change, String previous) {
        JsonObject data = base(null, null, "block_changed", false, 1.0);
        data.add("evidence", array("block_changed"));
        data.addProperty("block_id", change.blockId());
        data.addProperty("previous_block_id", previous == null ? "minecraft:air" : previous);
        data.add("pos", pos(change.x(), change.y(), change.z()));
        data.addProperty("time_ms", change.timeMs());
        return data;
    }

    private static JsonObject inferenceEvent(ActivityAssociator.Inference inference) {
        JsonObject data = base(inference.player(), inference.uuid(), "possible_block_interaction", true, inference.confidence());
        JsonArray evidence = new JsonArray();
        for (String item : inference.evidence()) {
            evidence.add(item);
        }
        data.add("evidence", evidence);
        data.addProperty("block_id", inference.blockId());
        data.add("pos", pos(inference.x(), inference.y(), inference.z()));
        return data;
    }

    private static JsonObject base(String player, String uuid, String kind, boolean inferred, double confidence) {
        JsonObject data = new JsonObject();
        data.addProperty("kind", kind);
        if (player == null) {
            data.add("player", JsonNull.INSTANCE);
        } else {
            data.addProperty("player", player);
        }
        if (uuid == null) {
            data.add("player_uuid", JsonNull.INSTANCE);
        } else {
            data.addProperty("player_uuid", uuid);
        }
        data.addProperty("inferred", inferred);
        data.addProperty("confidence", confidence);
        return data;
    }

    private static JsonArray array(String value) {
        JsonArray array = new JsonArray();
        array.add(value);
        return array;
    }

    private static JsonObject pos(int x, int y, int z) {
        JsonObject pos = new JsonObject();
        pos.addProperty("x", x);
        pos.addProperty("y", y);
        pos.addProperty("z", z);
        return pos;
    }
}
