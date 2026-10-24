package com.trix.gamebot.bridge.compat.vanilla;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.action.ActionOutcome;
import com.trix.gamebot.bridge.compat.api.AgentActionContext;
import com.trix.gamebot.bridge.compat.api.AgentInteractionAdapter;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.Direction;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.capabilities.Capabilities;
import net.neoforged.neoforge.items.IItemHandler;
import net.neoforged.neoforge.items.ItemHandlerHelper;

/** 原版物品能力：把 NPC 手上的物品放入暴露了 IItemHandler 的容器。 */
public final class VanillaAdapter implements AgentInteractionAdapter {
    @Override
    public String id() {
        return "vanilla";
    }

    @Override
    public int priority() {
        return 0;
    }

    @Override
    public boolean supports(AgentActionContext context) {
        if (!"use_item_on_block".equals(context.action) && !"interact".equals(context.action)) {
            return false;
        }
        return handler(context) != null;
    }

    @Override
    public ActionOutcome execute(AgentActionContext context) {
        IItemHandler handler = handler(context);
        if (handler == null) {
            return ActionOutcome.unsupportedAdapter(context.action, context.blockId(), "no item handler for this block");
        }
        AgentEntity agent = context.agent;
        ItemStack selected = agent.getMainHandItem();
        if (selected.isEmpty()) {
            return ActionOutcome.unsupportedAdapter(context.action, context.blockId(), "container insert needs an item in the selected hotbar slot");
        }
        ItemStack one = selected.copyWithCount(1);
        ItemStack remain = ItemHandlerHelper.insertItem(handler, one, false);
        JsonObject evidence = new JsonObject();
        evidence.addProperty("adapter", id());
        evidence.addProperty("block_id", context.blockId());
        evidence.addProperty("item_id", AgentEntity.itemId(selected));
        JsonObject pos = new JsonObject();
        pos.addProperty("x", context.pos.getX());
        pos.addProperty("y", context.pos.getY());
        pos.addProperty("z", context.pos.getZ());
        evidence.add("pos", pos);
        if (!remain.isEmpty()) {
            return ActionOutcome.failure("action_rejected", "container did not accept the item", evidence);
        }
        selected.shrink(1);
        evidence.addProperty("inserted", 1);
        return ActionOutcome.done(true, "confirmed", null, null, "inserted item", evidence);
    }

    private static IItemHandler handler(AgentActionContext context) {
        BlockState state = context.state();
        BlockEntity entity = context.blockEntity();
        Direction face = context.face();
        IItemHandler sided = context.level.getCapability(Capabilities.ItemHandler.BLOCK, context.pos, state, entity, face);
        if (sided != null) {
            return sided;
        }
        return context.level.getCapability(Capabilities.ItemHandler.BLOCK, context.pos, state, entity, null);
    }
}
