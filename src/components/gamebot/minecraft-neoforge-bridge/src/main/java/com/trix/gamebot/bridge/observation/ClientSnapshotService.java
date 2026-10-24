package com.trix.gamebot.bridge.observation;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/** 玩家、背包、附近方块和可见玩家。只在客户端主线程调用。 */
public final class ClientSnapshotService {
    public static final int MAX_BLOCKS = 512;
    public static final int MAX_PLAYERS = 32;
    public static final double PLAYER_RANGE = 64.0;

    private ClientSnapshotService() {
    }

    public static JsonObject player(Minecraft minecraft) {
        Player player = minecraft.player;
        JsonObject out = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", player.getX());
        position.addProperty("y", player.getY());
        position.addProperty("z", player.getZ());
        out.add("position", position);
        out.addProperty("yaw", player.getYRot());
        out.addProperty("pitch", player.getXRot());
        out.addProperty("health", player.getHealth());
        out.addProperty("food", player.getFoodData().getFoodLevel());
        out.addProperty("dimension", player.level().dimension().location().toString());
        String mode = "survival";
        if (minecraft.gameMode != null && minecraft.gameMode.getPlayerMode() != null) {
            mode = minecraft.gameMode.getPlayerMode().getSerializedName();
        }
        out.addProperty("game_mode", mode);
        out.addProperty("sneaking", player.isShiftKeyDown());
        out.addProperty("sprinting", player.isSprinting());
        out.addProperty("selected_slot", player.getInventory().selected);
        out.add("main_hand", itemOrNull(player.getMainHandItem()));
        out.add("off_hand", itemOrNull(player.getOffhandItem()));
        return out;
    }

    public static JsonObject inventory(Player player) {
        Inventory inventory = player.getInventory();
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
            String itemId = view.get("item_id").getAsString();
            int next = (counts.has(itemId) ? counts.get(itemId).getAsInt() : 0) + stack.getCount();
            counts.addProperty(itemId, next);
        }
        JsonObject out = new JsonObject();
        out.add("slots", slots);
        out.add("counts", counts);
        return out;
    }

    public static JsonArray nearbyBlocks(Minecraft minecraft, int radius) {
        Player player = minecraft.player;
        int clamped = Math.max(1, Math.min(16, radius));
        BlockPos origin = player.blockPosition();
        List<BlockSample> found = new ArrayList<>();
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
                    double distance = player.position().distanceTo(Vec3.atCenterOf(pos));
                    found.add(new BlockSample(pos, state, distance));
                }
            }
        }
        found.sort(Comparator
                .comparingDouble((BlockSample sample) -> sample.distance)
                .thenComparingInt(sample -> sample.pos.getY())
                .thenComparingInt(sample -> sample.pos.getX())
                .thenComparingInt(sample -> sample.pos.getZ()));
        if (found.size() > MAX_BLOCKS) {
            found = found.subList(0, MAX_BLOCKS);
        }
        JsonArray array = new JsonArray();
        for (BlockSample sample : found) {
            array.add(blockView(player, sample));
        }
        return array;
    }

    public static JsonArray nearbyPlayers(Minecraft minecraft) {
        Player self = minecraft.player;
        List<Player> others = new ArrayList<>();
        for (Player other : self.level().players()) {
            if (other == self || other.getUUID().equals(self.getUUID())) {
                continue;
            }
            if (self.distanceTo(other) > PLAYER_RANGE) {
                continue;
            }
            others.add(other);
        }
        others.sort(Comparator.comparingDouble(self::distanceTo));
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
            view.addProperty("distance", self.distanceTo(other));
            view.addProperty("pose", other.getPose().name().toLowerCase(Locale.ROOT));
            view.add("main_hand", itemOrNull(other.getMainHandItem()));
            array.add(view);
        }
        return array;
    }

    public static JsonObject screen(Minecraft minecraft) {
        JsonObject out = new JsonObject();
        var screen = minecraft.screen;
        if (screen == null) {
            out.add("id", JsonNull.INSTANCE);
            out.addProperty("open", false);
            return out;
        }
        String id = null;
        if (screen instanceof InventoryScreen) {
            id = "minecraft:inventory";
        } else if (screen instanceof ChatScreen) {
            id = "minecraft:chat";
        }
        if (id == null) {
            out.add("id", JsonNull.INSTANCE);
        } else {
            out.addProperty("id", id);
        }
        out.addProperty("open", true);
        return out;
    }

    public static JsonObject counts(Player player) {
        return inventory(player).getAsJsonObject("counts");
    }

    public static String itemId(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return null;
        }
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static com.google.gson.JsonElement itemOrNull(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return JsonNull.INSTANCE;
        }
        return itemView(stack);
    }

    private static JsonObject itemView(ItemStack stack) {
        JsonObject view = new JsonObject();
        view.addProperty("item_id", itemId(stack));
        view.addProperty("count", stack.getCount());
        view.addProperty("display_name", stack.getHoverName().getString());
        view.addProperty("damage", stack.getDamageValue());
        view.addProperty("max_damage", stack.getMaxDamage());
        return view;
    }

    private static JsonObject blockView(Player player, BlockSample sample) {
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
        BlockEntity entity = player.level().getBlockEntity(sample.pos);
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
        view.addProperty("distance", sample.distance);
        return view;
    }

    private static <T extends Comparable<T>> String propertyName(Property<T> property, BlockState state) {
        return property.getName(state.getValue(property));
    }

    private record BlockSample(BlockPos pos, BlockState state, double distance) {
    }
}
