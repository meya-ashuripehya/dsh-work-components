package com.trix.gamebot.bridge.observation;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** 以服务端 NPC 为中心的快照。普通快照不读取容器内容。 */
public final class ServerSnapshotService {
    public static final int MAX_BLOCKS = 512;
    public static final int MAX_PLAYERS = 32;
    public static final double PLAYER_RANGE = 64.0;

    private ServerSnapshotService() {
    }

    public static JsonObject player(AgentEntity agent) {
        JsonObject out = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", agent.getX());
        position.addProperty("y", agent.getY());
        position.addProperty("z", agent.getZ());
        out.add("position", position);
        out.addProperty("yaw", agent.getYRot());
        out.addProperty("pitch", agent.getXRot());
        out.addProperty("health", agent.getHealth());
        out.add("food", JsonNull.INSTANCE);
        out.addProperty("dimension", agent.level().dimension().location().toString());
        out.addProperty("game_mode", "npc");
        out.addProperty("sneaking", agent.isShiftKeyDown());
        out.addProperty("sprinting", agent.isSprinting());
        out.addProperty("selected_slot", agent.selectedSlot());
        out.add("main_hand", itemOrNull(agent.selectedStack()));
        out.add("off_hand", itemOrNull(agent.handStack("off_hand")));
        return out;
    }

    public static JsonObject inventory(AgentEntity agent) {
        SimpleContainer inventory = agent.inventory();
        JsonArray slots = new JsonArray();
        JsonObject counts = new JsonObject();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty()) {
                continue;
            }
            JsonObject view = itemView(stack);
            view.addProperty("slot", slot);
            slots.add(view);
            addCount(counts, view.get("item_id").getAsString(), stack.getCount());
        }
        ItemStack offhand = agent.handStack("off_hand");
        if (!offhand.isEmpty()) {
            JsonObject view = itemView(offhand);
            view.addProperty("slot", 40);
            slots.add(view);
            addCount(counts, view.get("item_id").getAsString(), offhand.getCount());
        }
        JsonObject out = new JsonObject();
        out.add("slots", slots);
        out.add("counts", counts);
        return out;
    }

    public static JsonObject counts(AgentEntity agent) {
        return inventory(agent).getAsJsonObject("counts");
    }

    public static final class NearbyScan {
        public final JsonArray blocks;
        public final boolean truncated;

        public NearbyScan(JsonArray blocks, boolean truncated) {
            this.blocks = blocks;
            this.truncated = truncated;
        }
    }

    public static JsonArray nearbyBlocks(AgentEntity agent, int radius) {
        return scanNearby(agent, radius).blocks;
    }

    /** Non-air blocks only, nearest MAX_BLOCKS. truncated means farther blocks were dropped. Absence is not air. */
    public static NearbyScan scanNearby(AgentEntity agent, int radius) {
        int clamped = Math.max(1, Math.min(16, radius));
        BlockPos origin = agent.blockPosition();
        List<BlockSample> found = new ArrayList<>();
        Level level = agent.level();
        for (int dx = -clamped; dx <= clamped; dx++) {
            for (int dy = -clamped; dy <= clamped; dy++) {
                for (int dz = -clamped; dz <= clamped; dz++) {
                    BlockPos pos = origin.offset(dx, dy, dz);
                    if (!WorldQueries.chunkLoaded(level, pos)) {
                        continue;
                    }
                    BlockState state = level.getBlockState(pos);
                    if (state.isAir()) {
                        continue;
                    }
                    double distance = agent.position().distanceTo(Vec3.atCenterOf(pos));
                    found.add(new BlockSample(pos, state, distance));
                }
            }
        }
        found.sort(Comparator
                .comparingDouble((BlockSample sample) -> sample.distance)
                .thenComparingInt(sample -> sample.pos.getY())
                .thenComparingInt(sample -> sample.pos.getX())
                .thenComparingInt(sample -> sample.pos.getZ()));
        boolean truncated = found.size() > MAX_BLOCKS;
        if (truncated) {
            found = found.subList(0, MAX_BLOCKS);
        }
        JsonArray array = new JsonArray();
        for (BlockSample sample : found) {
            array.add(blockView(level, agent.position(), sample));
        }
        return new NearbyScan(array, truncated);
    }

    public static JsonArray nearbyPlayers(AgentEntity agent) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return new JsonArray();
        }
        List<ServerPlayer> others = new ArrayList<>();
        for (ServerPlayer other : level.players()) {
            if (agent.distanceTo(other) > PLAYER_RANGE) {
                continue;
            }
            others.add(other);
        }
        others.sort(Comparator.comparingDouble(agent::distanceTo));
        if (others.size() > MAX_PLAYERS) {
            others = others.subList(0, MAX_PLAYERS);
        }
        JsonArray array = new JsonArray();
        for (Player other : others) {
            JsonObject view = new JsonObject();
            view.addProperty("uuid", other.getUUID().toString());
            view.addProperty("name", other.getGameProfile().getName());
            JsonObject position = new JsonObject();
            position.addProperty("x", other.getX());
            position.addProperty("y", other.getY());
            position.addProperty("z", other.getZ());
            view.add("position", position);
            view.addProperty("distance", agent.distanceTo(other));
            view.addProperty("pose", other.getPose().name().toLowerCase(Locale.ROOT));
            view.add("main_hand", itemOrNull(other.getMainHandItem()));
            array.add(view);
        }
        return array;
    }

    public static JsonObject closedScreen() {
        JsonObject screen = new JsonObject();
        screen.add("id", JsonNull.INSTANCE);
        screen.addProperty("open", false);
        return screen;
    }

    public static JsonObject evidence(AgentEntity agent) {
        JsonObject out = new JsonObject();
        out.add("inventory", counts(agent));
        out.add("main_hand", itemOrNull(agent.selectedStack()));
        out.addProperty("selected_slot", agent.selectedSlot());
        out.addProperty("health", agent.getHealth());
        out.addProperty("using", agent.isUsingItem());
        return out;
    }

    public static JsonObject merge(JsonObject before, JsonObject after) {
        JsonObject out = new JsonObject();
        out.add("inventory_before", before.get("inventory"));
        out.add("inventory_after", after.get("inventory"));
        out.add("main_hand_before", before.get("main_hand"));
        out.add("main_hand_after", after.get("main_hand"));
        out.add("selected_slot_before", before.get("selected_slot"));
        out.add("selected_slot_after", after.get("selected_slot"));
        return out;
    }

    public static boolean countsChanged(JsonObject before, JsonObject after) {
        return !String.valueOf(before.get("inventory")).equals(String.valueOf(after.get("inventory")))
                || !String.valueOf(before.get("main_hand")).equals(String.valueOf(after.get("main_hand")));
    }

    public static JsonElement itemOrNull(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return JsonNull.INSTANCE;
        }
        return itemView(stack);
    }

    public static JsonObject itemView(ItemStack stack) {
        JsonObject view = new JsonObject();
        view.addProperty("item_id", AgentEntity.itemId(stack));
        view.addProperty("count", stack.getCount());
        view.addProperty("display_name", stack.getHoverName().getString());
        view.addProperty("damage", stack.getDamageValue());
        view.addProperty("max_damage", stack.getMaxDamage());
        return view;
    }

    private static void addCount(JsonObject counts, String itemId, int count) {
        int next = (counts.has(itemId) ? counts.get(itemId).getAsInt() : 0) + count;
        counts.addProperty(itemId, next);
    }

    private static JsonObject blockView(Level level, Vec3 origin, BlockSample sample) {
        JsonObject view = new JsonObject();
        view.addProperty("block_id", BuiltInRegistries.BLOCK.getKey(sample.state.getBlock()).toString());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", sample.pos.getX());
        pos.addProperty("y", sample.pos.getY());
        pos.addProperty("z", sample.pos.getZ());
        view.add("pos", pos);
        JsonObject state = new JsonObject();
        for (Property<?> property : sample.state.getProperties()) {
            state.addProperty(property.getName(), propertyName(property, sample.state));
        }
        view.add("state", state);
        BlockEntity entity = level.getBlockEntity(sample.pos);
        if (entity == null) {
            view.add("block_entity_type", JsonNull.INSTANCE);
        } else {
            var key = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(entity.getType());
            if (key == null) {
                view.add("block_entity_type", JsonNull.INSTANCE);
            } else {
                view.addProperty("block_entity_type", key.toString());
            }
        }
        view.addProperty("distance", origin.distanceTo(Vec3.atCenterOf(sample.pos)));
        return view;
    }

    private static <T extends Comparable<T>> String propertyName(Property<T> property, BlockState state) {
        return property.getName(state.getValue(property));
    }

    private record BlockSample(BlockPos pos, BlockState state, double distance) {
    }
}
