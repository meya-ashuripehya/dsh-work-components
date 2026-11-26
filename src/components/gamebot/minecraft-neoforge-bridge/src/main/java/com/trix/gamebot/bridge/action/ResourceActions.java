package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.HitResult;
import net.neoforged.neoforge.common.util.FakePlayer;
import net.neoforged.neoforge.common.util.FakePlayerFactory;
import java.util.Comparator;

/** Use the vanilla/NeoForge survival inventory, loot, enchantment and durability path. */
public final class ResourceActions {
    private ResourceActions() {}

    public static int bestTool(SimpleContainer inventory, BlockState state) {
        int best = -1; float speed = -1;
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (state.requiresCorrectToolForDrops() && !stack.isCorrectToolForDrops(state)) continue;
            float candidate = stack.getDestroySpeed(state);
            if (candidate > speed || candidate == speed && stack.isEmpty()) { best = slot; speed = candidate; }
        }
        return best;
    }

    public static int dropSlot(SimpleContainer inventory, String itemId, int count) {
        for (int slot=0;slot<inventory.getContainerSize();slot++) {
            ItemStack stack=inventory.getItem(slot);
            if (itemId.equals(AgentEntity.itemId(stack)) && stack.getCount()>=count) return slot;
        }
        return -1;
    }

    public static FakePlayer player(AgentEntity agent) {
        var level = (ServerLevel) agent.level();
        var fake = FakePlayerFactory.get(level, new GameProfile(agent.getUUID(), "Minaret_" + agent.getUUID().toString().substring(0, 8)));
        fake.gameMode.changeGameModeForPlayer(GameType.SURVIVAL);
        fake.getInventory().clearContent();
        for (int slot = 0; slot < AgentEntity.SLOT_COUNT; slot++) fake.getInventory().setItem(slot, agent.inventory().getItem(slot).copy());
        fake.getInventory().selected = agent.selectedSlot();
        fake.setItemSlot(EquipmentSlot.MAINHAND, (agent.handLocked() ? agent.getMainHandItem() : agent.selectedStack()).copy());
        fake.setItemSlot(EquipmentSlot.OFFHAND, agent.handStack("off_hand").copy());
        fake.setPos(agent.getX(), agent.getY(), agent.getZ());
        fake.setYRot(agent.getYRot()); fake.setXRot(agent.getXRot()); fake.setOnGround(agent.onGround());
        return fake;
    }

    public static void commitInventory(AgentEntity agent, FakePlayer fake) {
        for (int slot = 0; slot < AgentEntity.SLOT_COUNT; slot++) agent.inventory().setItem(slot, fake.getInventory().getItem(slot).copy());
        agent.storeOffhand(fake.getOffhandItem());
        if (agent.handLocked()) agent.setItemSlot(EquipmentSlot.MAINHAND, fake.getMainHandItem().copy());
        else agent.refreshHands();
    }

    public static boolean visible(AgentEntity agent, ItemEntity item) {
        return agent.level().clip(new ClipContext(agent.getEyePosition(), item.position().add(0, 0.1, 0), ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, agent)).getType() == HitResult.Type.MISS;
    }

    /** Never takes items through walls, remotely, during hand transactions, or while disconnected. */
    public static void pickupNearby(AgentEntity agent) {
        if (agent.handLocked() || !(agent.level() instanceof ServerLevel level) || agent.tickCount % 5 != 0) return;
        var nearby = level.getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(1.5, 0.5, 1.5), e -> e.isAlive() && !e.hasPickUpDelay());
        for (var item : nearby.stream().sorted(Comparator.comparingDouble(agent::distanceToSqr)).limit(16).toList()) {
            if (agent.defersPickup(item.getUUID()) || !visible(agent, item)) continue;
            takeOne(agent, item, player(agent));
        }
    }

    static void takeOne(AgentEntity agent, ItemEntity item, FakePlayer fake) {
            ItemStack original = item.getItem().copy();
            int before = count(agent.inventory(), original) + (ItemStack.isSameItemSameComponents(agent.handStack("off_hand"), original) ? agent.handStack("off_hand").getCount() : 0);
            // playerTouch enforces ownership, pickup delay, stack components, capacity and mod pickup events.
            try { item.playerTouch(fake); }
            catch (RuntimeException failure) { agent.recordPickupError(); }
            finally { commitInventory(agent, fake); }
            int after = count(agent.inventory(), original) + (ItemStack.isSameItemSameComponents(agent.handStack("off_hand"), original) ? agent.handStack("off_hand").getCount() : 0);
            int taken = Math.min(original.getCount(), Math.max(0, after - before));
            if (taken > 0) { agent.take(item, taken); agent.recordPickup(AgentEntity.itemId(original), taken); }
    }

    static int count(SimpleContainer inventory, ItemStack item) {
        int count = 0;
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && ItemStack.isSameItemSameComponents(stack, item)) count += stack.getCount();
        }
        return count;
    }

    public static JsonArray nearbyItems(AgentEntity agent, int radius) {
        JsonArray out = new JsonArray();
        for (var item : agent.level().getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(radius), e -> e.isAlive() && !e.getItem().isEmpty())
                .stream().filter(e -> visible(agent, e)).sorted(Comparator.comparingDouble(agent::distanceToSqr)).limit(24).toList()) {
            JsonObject row = new JsonObject(); row.addProperty("uuid", item.getUUID().toString());
            row.addProperty("item_id", AgentEntity.itemId(item.getItem())); row.addProperty("count", item.getItem().getCount());
            row.add("position", NavigationTasks.point(item.position())); row.addProperty("distance", agent.distanceTo(item));
            row.addProperty("pickup_delay", item.hasPickUpDelay()); row.addProperty("observed_at", agent.level().getGameTime());
            row.addProperty("own_pickup_deferred", agent.defersPickup(item.getUUID()));
            out.add(row);
        }
        return out;
    }
}
