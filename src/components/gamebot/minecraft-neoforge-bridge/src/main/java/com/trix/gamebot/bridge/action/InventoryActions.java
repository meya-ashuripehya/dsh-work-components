package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.observation.ClientSnapshotService;
import net.minecraft.client.Minecraft;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

/** 快捷栏选择和丢弃。背包其余槽位返回 unsupported，不搬运。 */
public final class InventoryActions {
    private InventoryActions() {
    }

    public static ActionOutcome select(Minecraft minecraft, JsonObject params) {
        Player player = minecraft.player;
        if (player == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        if (InteractionActions.blocksWorld(minecraft)) {
            return ActionOutcome.failure("action_rejected", "a screen is open");
        }
        JsonObject before = evidence(player);
        int slot;
        try {
            slot = resolveHotbarSlot(player, params);
        } catch (ActionRejection rejection) {
            return rejection.outcome;
        }
        selectSlot(player, slot);
        JsonObject after = evidence(player);
        String itemId = ClientSnapshotService.itemId(player.getInventory().getItem(slot));
        return ActionOutcome.done(true, "confirmed", null, null, "selected " + (itemId == null ? "empty" : itemId), merge(before, after));
    }

    public static ActionOutcome drop(Minecraft minecraft, JsonObject params) {
        Player player = minecraft.player;
        if (player == null) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        if (InteractionActions.blocksWorld(minecraft)) {
            return ActionOutcome.failure("action_rejected", "a screen is open");
        }
        if (!(player instanceof net.minecraft.client.player.LocalPlayer local)) {
            return ActionOutcome.failure("client_not_ready", "client is not in a world");
        }
        int count = params.get("count").getAsInt();
        int slot;
        try {
            slot = resolveHotbarSlot(player, params);
        } catch (ActionRejection rejection) {
            return rejection.outcome;
        }
        ItemStack stack = player.getInventory().getItem(slot);
        if (stack.isEmpty()) {
            return ActionOutcome.failure("item_not_found", "hotbar slot is empty");
        }
        if (count > stack.getCount()) {
            return ActionOutcome.failure("invalid_params", "count exceeds the current stack");
        }
        JsonObject before = evidence(player);
        selectSlot(player, slot);
        if (count == stack.getCount()) {
            local.drop(true);
        } else {
            for (int i = 0; i < count; i++) {
                local.drop(false);
            }
        }
        JsonObject after = evidence(player);
        String effect = countsChanged(before, after) ? "confirmed" : "unverified";
        return ActionOutcome.done(true, effect, null, null, "dropped " + count, merge(before, after));
    }

    public static int resolveHotbarSlot(Player player, JsonObject params) throws ActionRejection {
        boolean hasSlot = params.has("slot");
        boolean hasItem = params.has("item_id");
        String itemId = hasItem ? params.get("item_id").getAsString() : null;
        if (hasSlot) {
            int slot = params.get("slot").getAsInt();
            ItemStack stack = player.getInventory().getItem(slot);
            if (hasItem && (stack.isEmpty() || !itemId.equals(ClientSnapshotService.itemId(stack)))) {
                throw new ActionRejection(ActionOutcome.failure("invalid_params", "item_id and slot do not match"));
            }
            return slot;
        }
        Inventory inventory = player.getInventory();
        for (int slot = 0; slot <= 8; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && itemId.equals(ClientSnapshotService.itemId(stack))) {
                return slot;
            }
        }
        for (int slot = 9; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && itemId.equals(ClientSnapshotService.itemId(stack))) {
                throw new ActionRejection(ActionOutcome.failure("unsupported", "item is outside the hotbar"));
            }
        }
        throw new ActionRejection(ActionOutcome.failure("item_not_found", "item is not in the hotbar"));
    }

    public static void selectSlot(Player player, int slot) {
        player.getInventory().selected = slot;
        if (player instanceof net.minecraft.client.player.LocalPlayer local && local.connection != null) {
            local.connection.send(new ServerboundSetCarriedItemPacket(slot));
        }
    }

    public static JsonObject evidence(Player player) {
        JsonObject out = new JsonObject();
        out.add("inventory", ClientSnapshotService.counts(player));
        out.add("main_hand", itemElement(player.getMainHandItem()));
        out.addProperty("food", player.getFoodData().getFoodLevel());
        out.addProperty("selected_slot", player.getInventory().selected);
        out.addProperty("using", player.isUsingItem());
        return out;
    }

    public static JsonObject merge(JsonObject before, JsonObject after) {
        JsonObject out = new JsonObject();
        out.add("inventory_before", before.get("inventory"));
        out.add("inventory_after", after.get("inventory"));
        out.add("main_hand_before", before.get("main_hand"));
        out.add("main_hand_after", after.get("main_hand"));
        out.addProperty("food_before", before.get("food").getAsInt());
        out.addProperty("food_after", after.get("food").getAsInt());
        out.addProperty("selected_slot_before", before.get("selected_slot").getAsInt());
        out.addProperty("selected_slot_after", after.get("selected_slot").getAsInt());
        return out;
    }

    public static boolean countsChanged(JsonObject before, JsonObject after) {
        return !before.get("inventory").equals(after.get("inventory"))
                || before.get("food").getAsInt() != after.get("food").getAsInt()
                || before.get("selected_slot").getAsInt() != after.get("selected_slot").getAsInt()
                || !before.get("main_hand").equals(after.get("main_hand"));
    }

    private static com.google.gson.JsonElement itemElement(ItemStack stack) {
        if (stack.isEmpty()) {
            return com.google.gson.JsonNull.INSTANCE;
        }
        JsonObject view = new JsonObject();
        view.addProperty("item_id", ClientSnapshotService.itemId(stack));
        view.addProperty("count", stack.getCount());
        return view;
    }

    public static final class ActionRejection extends Exception {
        public final ActionOutcome outcome;

        public ActionRejection(ActionOutcome outcome) {
            this.outcome = outcome;
        }
    }
}
