package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.observation.ClientSnapshotService;
import com.trix.gamebot.bridge.observation.WorldQueries;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/** 看向、左右键和使用物品。每个动作都带回执行前后的证据。 */
public final class InteractionActions {
    private InteractionActions() {
    }

    public static ActionOutcome lookAt(Minecraft minecraft, JsonObject params) {
        Player player = minecraft.player;
        if (player == null || minecraft.level == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        float beforeYaw = player.getYRot();
        float beforePitch = player.getXRot();
        aim(player, params.get("x").getAsDouble(), params.get("y").getAsDouble(), params.get("z").getAsDouble());
        boolean moved = Math.abs(beforeYaw - player.getYRot()) > 0.01f || Math.abs(beforePitch - player.getXRot()) > 0.01f;
        JsonObject evidence = new JsonObject();
        evidence.addProperty("yaw_before", beforeYaw);
        evidence.addProperty("pitch_before", beforePitch);
        evidence.addProperty("yaw_after", player.getYRot());
        evidence.addProperty("pitch_after", player.getXRot());
        return ActionOutcome.done(true, moved ? "confirmed" : "observed", null, null, "looked", evidence);
    }

    public static ActionOutcome useOnBlock(Minecraft minecraft, JsonObject params) {
        ActionOutcome ready = prepareWorld(minecraft);
        if (ready != null) {
            return ready;
        }
        Player player = minecraft.player;
        BlockPos pos = blockPos(params.getAsJsonObject("pos"));
        if (!WorldQueries.chunkLoaded(player.level(), pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        JsonObject offset = params.getAsJsonObject("hit_offset");
        Vec3 hit = new Vec3(
                pos.getX() + offset.get("x").getAsDouble(),
                pos.getY() + offset.get("y").getAsDouble(),
                pos.getZ() + offset.get("z").getAsDouble()
        );
        double maxDistance = params.get("max_distance").getAsDouble();
        if (player.getEyePosition().distanceTo(hit) > maxDistance) {
            return ActionOutcome.failure("out_of_reach", "target is farther than max_distance");
        }
        if (!canSee(player, pos, hit)) {
            return ActionOutcome.failure("line_of_sight_blocked", "line of sight is blocked");
        }
        Direction face = Direction.byName(params.get("face").getAsString());
        if (face == null) {
            return ActionOutcome.failure("invalid_params", "face is invalid");
        }
        InteractionHand hand = hand(params.get("hand").getAsString());
        if (params.has("item_id") && "main_hand".equals(params.get("hand").getAsString())) {
            try {
                int slot = InventoryActions.resolveHotbarSlot(player, params);
                InventoryActions.selectSlot(player, slot);
            } catch (InventoryActions.ActionRejection rejection) {
                return rejection.outcome;
            }
        } else if (params.has("item_id") && !params.get("item_id").getAsString().equals(ClientSnapshotService.itemId(player.getOffhandItem()))) {
            return ActionOutcome.failure("item_not_found", "off hand does not contain the requested item");
        }
        aim(player, hit.x, hit.y, hit.z);
        JsonObject before = InventoryActions.evidence(player);
        JsonObject blockBefore = blockEvidence(player, pos);
        boolean previousShift = player.isShiftKeyDown();
        if (params.get("sneaking").getAsBoolean()) {
            player.setShiftKeyDown(true);
        }
        InteractionResult result;
        try {
            result = minecraft.gameMode.useItemOn((LocalPlayer) player, hand, new BlockHitResult(hit, face, pos, false));
        } finally {
            if (params.get("sneaking").getAsBoolean()) {
                player.setShiftKeyDown(previousShift);
            }
        }
        JsonObject after = InventoryActions.evidence(player);
        JsonObject blockAfter = blockEvidence(player, pos);
        JsonObject evidence = InventoryActions.merge(before, after);
        evidence.add("block_before", blockBefore);
        evidence.add("block_after", blockAfter);
        boolean changed = InventoryActions.countsChanged(before, after) || !blockBefore.equals(blockAfter);
        String effect = changed ? "confirmed" : (consumed(result) ? "observed" : "unverified");
        String blockId = blockBefore.get("block_id").getAsString();
        return ActionOutcome.done(true, effect, null, null, "used " + blockId, evidence);
    }

    public static ActionOutcome attack(Minecraft minecraft, JsonObject params) {
        ActionOutcome ready = prepareWorld(minecraft);
        if (ready != null) {
            return ready;
        }
        Player player = minecraft.player;
        BlockPos pos = blockPos(params.getAsJsonObject("pos"));
        if (!WorldQueries.chunkLoaded(player.level(), pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        JsonObject offset = params.getAsJsonObject("hit_offset");
        Vec3 hit = new Vec3(
                pos.getX() + offset.get("x").getAsDouble(),
                pos.getY() + offset.get("y").getAsDouble(),
                pos.getZ() + offset.get("z").getAsDouble()
        );
        if (player.getEyePosition().distanceTo(hit) > params.get("max_distance").getAsDouble()) {
            return ActionOutcome.failure("out_of_reach", "target is farther than max_distance");
        }
        if (!canSee(player, pos, hit)) {
            return ActionOutcome.failure("line_of_sight_blocked", "line of sight is blocked");
        }
        Direction face = Direction.byName(params.get("face").getAsString());
        InteractionHand hand = hand(params.get("hand").getAsString());
        aim(player, hit.x, hit.y, hit.z);
        JsonObject blockBefore = blockEvidence(player, pos);
        boolean started = minecraft.gameMode.startDestroyBlock(pos, face);
        minecraft.gameMode.stopDestroyBlock();
        player.swing(hand);
        JsonObject blockAfter = blockEvidence(player, pos);
        JsonObject evidence = new JsonObject();
        evidence.add("block_before", blockBefore);
        evidence.add("block_after", blockAfter);
        boolean changed = !blockBefore.equals(blockAfter);
        String effect = changed ? "confirmed" : (started ? "observed" : "unverified");
        return ActionOutcome.done(true, effect, null, null, "attacked " + blockBefore.get("block_id").getAsString(), evidence);
    }

    public static ActionOutcome useItem(Minecraft minecraft, JsonObject params) {
        if (minecraft.player == null || minecraft.gameMode == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        if (blocksWorld(minecraft)) {
            return ActionOutcome.failure("action_rejected", "a screen is open");
        }
        Player player = minecraft.player;
        InteractionHand hand = hand(params.get("hand").getAsString());
        if (params.has("item_id") && "main_hand".equals(params.get("hand").getAsString())) {
            try {
                InventoryActions.selectSlot(player, InventoryActions.resolveHotbarSlot(player, params));
            } catch (InventoryActions.ActionRejection rejection) {
                return rejection.outcome;
            }
        } else if (params.has("item_id") && !params.get("item_id").getAsString().equals(ClientSnapshotService.itemId(player.getOffhandItem()))) {
            return ActionOutcome.failure("item_not_found", "off hand does not contain the requested item");
        }
        JsonObject before = InventoryActions.evidence(player);
        InteractionResult result = minecraft.gameMode.useItem(player, hand);
        if ("until_finished".equals(params.get("mode").getAsString()) && player.isUsingItem()) {
            JsonObject evidence = InventoryActions.merge(before, before);
            evidence.addProperty("mode", "until_finished");
            return ActionOutcome.pending("using", evidence);
        }
        JsonObject after = InventoryActions.evidence(player);
        boolean changed = InventoryActions.countsChanged(before, after);
        String effect = changed ? "confirmed" : (consumed(result) ? "observed" : "unverified");
        return ActionOutcome.done(true, effect, null, null, "used item", InventoryActions.merge(before, after));
    }

    public static ActionOutcome finishUse(Minecraft minecraft, JsonObject beforeEvidence) {
        Player player = minecraft.player;
        if (player == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        JsonObject after = InventoryActions.evidence(player);
        JsonObject before = new JsonObject();
        before.add("inventory", beforeEvidence.get("inventory_before"));
        before.add("main_hand", beforeEvidence.get("main_hand_before"));
        before.addProperty("food", beforeEvidence.get("food_before").getAsInt());
        before.addProperty("selected_slot", beforeEvidence.get("selected_slot_before").getAsInt());
        boolean changed = InventoryActions.countsChanged(before, after);
        return ActionOutcome.done(true, changed ? "confirmed" : "observed", null, null, "used item", InventoryActions.merge(before, after));
    }

    public static void releaseUse(Minecraft minecraft) {
        if (minecraft.player != null && minecraft.gameMode != null && minecraft.player.isUsingItem()) {
            minecraft.gameMode.releaseUsingItem(minecraft.player);
        }
    }

    private static ActionOutcome prepareWorld(Minecraft minecraft) {
        if (minecraft.player == null || minecraft.level == null || minecraft.gameMode == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        if (blocksWorld(minecraft)) {
            return ActionOutcome.failure("action_rejected", "a screen is open");
        }
        return null;
    }

    public static boolean blocksWorld(Minecraft minecraft) {
        return minecraft.screen != null && !(minecraft.screen instanceof ChatScreen);
    }

    private static void aim(Player player, double x, double y, double z) {
        Vec3 eye = player.getEyePosition();
        double dx = x - eye.x;
        double dy = y - eye.y;
        double dz = z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
        float pitch = (float) Math.toDegrees(-Math.atan2(dy, horizontal));
        player.setYRot(yaw);
        player.setXRot(Math.max(-90.0f, Math.min(90.0f, pitch)));
        player.setYHeadRot(yaw);
    }

    private static boolean canSee(Player player, BlockPos pos, Vec3 hit) {
        BlockHitResult clip = player.level().clip(new ClipContext(
                player.getEyePosition(),
                hit,
                ClipContext.Block.COLLIDER,
                ClipContext.Fluid.NONE,
                player
        ));
        if (clip.getType() == HitResult.Type.MISS) {
            return player.level().getBlockState(pos).getCollisionShape(player.level(), pos).isEmpty();
        }
        return clip.getBlockPos().equals(pos);
    }

    private static BlockPos blockPos(JsonObject pos) {
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    private static InteractionHand hand(String name) {
        return "off_hand".equals(name) ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
    }

    private static boolean consumed(InteractionResult result) {
        return result != null && result.consumesAction();
    }

    private static JsonObject blockEvidence(Player player, BlockPos pos) {
        var state = player.level().getBlockState(pos);
        JsonObject out = new JsonObject();
        out.addProperty("block_id", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        JsonObject position = new JsonObject();
        position.addProperty("x", pos.getX());
        position.addProperty("y", pos.getY());
        position.addProperty("z", pos.getZ());
        out.add("pos", position);
        JsonObject properties = new JsonObject();
        for (var property : state.getProperties()) {
            properties.addProperty(property.getName(), stateName(property, state));
        }
        out.add("state", properties);
        return out;
    }

    private static <T extends Comparable<T>> String stateName(net.minecraft.world.level.block.state.properties.Property<T> property, net.minecraft.world.level.block.state.BlockState state) {
        return property.getName(state.getValue(property));
    }
}
