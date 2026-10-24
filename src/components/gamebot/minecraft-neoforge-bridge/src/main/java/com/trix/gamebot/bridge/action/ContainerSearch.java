package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.config.BridgeConfig;
import com.trix.gamebot.bridge.observation.WorldQueries;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.capabilities.Capabilities;
import net.neoforged.neoforge.items.IItemHandler;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/** 按物品 ID 查找附近容器。只返回命中的容器，不把容器内容放进普通快照。 */
public final class ContainerSearch {
    private static final int MAX_MATCHES = 16;
    private static final int MAX_SLOTS = 8;
    private static final Direction[] SIDES = {
            null, Direction.UP, Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST
    };

    private ContainerSearch() {
    }

    public static void start(Minecraft minecraft, JsonObject params, Consumer<ActionOutcome> done) {
        if (minecraft.player == null || minecraft.level == null) {
            done.accept(ActionOutcome.failure("client_not_ready", "client is not in a world"));
            return;
        }
        String itemId = params.get("item_id").getAsString();
        int radius = params.has("radius") ? params.get("radius").getAsInt() : defaultRadius();
        IntegratedServer integrated = minecraft.getSingleplayerServer();
        if (integrated == null) {
            done.accept(search(minecraft.level, minecraft.player.position(), itemId, radius, "client"));
            return;
        }
        UUID playerId = minecraft.player.getUUID();
        try {
            integrated.execute(() -> {
                ActionOutcome outcome;
                try {
                    ServerPlayer player = integrated.getPlayerList().getPlayer(playerId);
                    if (player == null) {
                        outcome = ActionOutcome.failure("client_not_ready", "server player is not available");
                    } else {
                        outcome = search(player.serverLevel(), player.position(), itemId, radius, "server");
                    }
                } catch (RuntimeException ignored) {
                    outcome = ActionOutcome.failure("internal_error", "container search failed");
                }
                ActionOutcome result = outcome;
                minecraft.execute(() -> done.accept(result));
            });
        } catch (RuntimeException ignored) {
            done.accept(ActionOutcome.failure("client_not_ready", "server player is not available"));
        }
    }

    static ActionOutcome search(Level level, Vec3 playerPos, String itemId, int radius, String source) {
        BlockPos origin = BlockPos.containing(playerPos);
        int minChunkX = (origin.getX() - radius) >> 4;
        int maxChunkX = (origin.getX() + radius) >> 4;
        int minChunkZ = (origin.getZ() - radius) >> 4;
        int maxChunkZ = (origin.getZ() + radius) >> 4;
        int limit = radius * radius;
        Set<IItemHandler> seen = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        List<Match> matches = new ArrayList<>();
        for (int chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
            for (int chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                BlockPos probe = new BlockPos(chunkX << 4, origin.getY(), chunkZ << 4);
                if (!WorldQueries.chunkLoaded(level, probe)) {
                    continue;
                }
                var chunk = level.getChunk(chunkX, chunkZ, ChunkStatus.FULL, false);
                if (!(chunk instanceof LevelChunk levelChunk)) {
                    continue;
                }
                for (BlockEntity entity : levelChunk.getBlockEntities().values()) {
                    BlockPos pos = entity.getBlockPos();
                    if (origin.distSqr(pos) > limit) {
                        continue;
                    }
                    IItemHandler handler = bestHandler(level, entity, itemId, seen);
                    if (handler == null) {
                        continue;
                    }
                    matches.add(match(playerPos, entity, handler, itemId));
                }
            }
        }
        matches.sort(Comparator
                .comparingDouble((Match match) -> match.distance)
                .thenComparingInt(match -> match.pos.getY())
                .thenComparingInt(match -> match.pos.getX())
                .thenComparingInt(match -> match.pos.getZ()));
        boolean truncated = matches.size() > MAX_MATCHES;
        if (truncated) {
            matches = new ArrayList<>(matches.subList(0, MAX_MATCHES));
        }
        JsonObject evidence = new JsonObject();
        evidence.addProperty("item_id", itemId);
        evidence.addProperty("radius", radius);
        evidence.addProperty("source", source);
        evidence.addProperty("truncated", truncated);
        JsonArray array = new JsonArray();
        for (Match match : matches) {
            array.add(match.toJson());
        }
        evidence.add("matches", array);
        String sent = matches.isEmpty()
                ? "no nearby container holds " + itemId
                : "found " + matches.size() + " containers holding " + itemId;
        return ActionOutcome.done(true, matches.isEmpty() ? "observed" : "confirmed", null, null, sent, evidence);
    }

    private static IItemHandler bestHandler(Level level, BlockEntity entity, String itemId, Set<IItemHandler> seen) {
        BlockPos pos = entity.getBlockPos();
        BlockState state = entity.getBlockState();
        IItemHandler chosen = null;
        int chosenCount = 0;
        for (Direction side : SIDES) {
            IItemHandler handler = level.getCapability(Capabilities.ItemHandler.BLOCK, pos, state, entity, side);
            if (handler == null || !seen.add(handler)) {
                continue;
            }
            int count = countItem(handler, itemId);
            if (count > chosenCount) {
                chosen = handler;
                chosenCount = count;
            }
        }
        return chosenCount > 0 ? chosen : null;
    }

    private static int countItem(IItemHandler handler, String itemId) {
        int total = 0;
        for (int slot = 0; slot < handler.getSlots(); slot++) {
            var stack = handler.getStackInSlot(slot);
            if (!stack.isEmpty() && itemId.equals(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString())) {
                total += stack.getCount();
            }
        }
        return total;
    }

    private static Match match(Vec3 playerPos, BlockEntity entity, IItemHandler handler, String itemId) {
        BlockPos pos = entity.getBlockPos();
        BlockState state = entity.getBlockState();
        Match match = new Match();
        match.pos = pos;
        match.distance = Math.round(Vec3.atCenterOf(pos).distanceTo(playerPos) * 1000.0) / 1000.0;
        match.blockId = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        var entityKey = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(entity.getType());
        match.entityType = entityKey == null ? null : entityKey.toString();
        match.name = state.getBlock().getName().getString();
        match.count = 0;
        match.slots = new JsonArray();
        match.slotsTruncated = false;
        for (int slot = 0; slot < handler.getSlots(); slot++) {
            var stack = handler.getStackInSlot(slot);
            if (stack.isEmpty() || !itemId.equals(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString())) {
                continue;
            }
            match.count += stack.getCount();
            if (match.slots.size() < MAX_SLOTS) {
                JsonObject slotView = new JsonObject();
                slotView.addProperty("slot", slot);
                slotView.addProperty("count", stack.getCount());
                match.slots.add(slotView);
            } else {
                match.slotsTruncated = true;
            }
        }
        return match;
    }

    private static int defaultRadius() {
        try {
            return BridgeConfig.scanRadius();
        } catch (RuntimeException ignored) {
            return 8;
        }
    }

    private static final class Match {
        private BlockPos pos;
        private double distance;
        private String blockId;
        private String entityType;
        private String name;
        private int count;
        private JsonArray slots;
        private boolean slotsTruncated;

        private JsonObject toJson() {
            JsonObject out = new JsonObject();
            out.addProperty("block_id", blockId);
            if (entityType == null) {
                out.add("block_entity_type", com.google.gson.JsonNull.INSTANCE);
            } else {
                out.addProperty("block_entity_type", entityType);
            }
            out.addProperty("name", name);
            JsonObject position = new JsonObject();
            position.addProperty("x", pos.getX());
            position.addProperty("y", pos.getY());
            position.addProperty("z", pos.getZ());
            out.add("pos", position);
            out.addProperty("distance", distance);
            out.addProperty("count", count);
            out.add("slots", slots);
            out.addProperty("slots_truncated", slotsTruncated);
            return out;
        }
    }
}
