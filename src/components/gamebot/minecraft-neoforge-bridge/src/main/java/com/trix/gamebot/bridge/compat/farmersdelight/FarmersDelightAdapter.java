package com.trix.gamebot.bridge.compat.farmersdelight;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.action.ActionOutcome;
import com.trix.gamebot.bridge.compat.api.AgentActionContext;
import com.trix.gamebot.bridge.compat.api.AgentInteractionAdapter;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import net.minecraft.world.level.block.state.properties.Property;

import java.util.Collections;

/**
 * 农夫乐事的派和盛宴。
 * 食用规则参考车万女仆 MIT 代码 FarmersDelightEdible
 * （Copyright 2019-2025 tartaric_acid，TouhouLittleMaid，MIT License）。
 * 本实现只读取方块 ID 与 bites/servings 属性，不引用 EntityMaid，也不加载农夫乐事的类。
 */
public final class FarmersDelightAdapter implements AgentInteractionAdapter {
    @Override
    public String id() {
        return "farmersdelight";
    }

    @Override
    public String requiredMod() {
        return "farmersdelight";
    }

    @Override
    public int priority() {
        return 100;
    }

    @Override
    public boolean supports(AgentActionContext context) {
        if (!"use_item_on_block".equals(context.action) && !"interact".equals(context.action)) {
            return false;
        }
        BlockState state = context.state();
        String blockId = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        if (!blockId.startsWith("farmersdelight:")) {
            return false;
        }
        return integerProperty(state, "bites") != null || integerProperty(state, "servings") != null;
    }

    @Override
    public ActionOutcome execute(AgentActionContext context) {
        BlockState before = context.state();
        IntegerProperty bites = integerProperty(before, "bites");
        IntegerProperty servings = integerProperty(before, "servings");
        JsonObject evidence = new JsonObject();
        evidence.addProperty("adapter", id());
        evidence.addProperty("block_id", context.blockId());
        JsonObject pos = new JsonObject();
        pos.addProperty("x", context.pos.getX());
        pos.addProperty("y", context.pos.getY());
        pos.addProperty("z", context.pos.getZ());
        evidence.add("pos", pos);
        if (bites != null) {
            int value = before.getValue(bites);
            int max = Collections.max(bites.getPossibleValues());
            evidence.addProperty("property", "bites");
            evidence.addProperty("before", value);
            ServingMath.Change change = ServingMath.pie(value, max);
            apply(context, before, bites, change, evidence);
            return ActionOutcome.done(true, "confirmed", null, null, "ate farmersdelight pie", evidence);
        }
        if (servings != null) {
            int value = before.getValue(servings);
            int min = Collections.min(servings.getPossibleValues());
            evidence.addProperty("property", "servings");
            evidence.addProperty("before", value);
            ServingMath.Change change = ServingMath.feast(value, min);
            apply(context, before, servings, change, evidence);
            return ActionOutcome.done(true, "confirmed", null, null, "ate farmersdelight feast", evidence);
        }
        return ActionOutcome.unsupportedAdapter(context.action, context.blockId(), "block has no bites or servings property");
    }

    private static void apply(AgentActionContext context, BlockState before, IntegerProperty property, ServingMath.Change change, JsonObject evidence) {
        context.agent.swing(net.minecraft.world.InteractionHand.MAIN_HAND);
        context.agent.heal(1.0F);
        if (change.destroy()) {
            context.level.destroyBlock(context.pos, false, context.agent, 512);
            evidence.addProperty("destroyed", true);
            evidence.addProperty("after", change.next());
            return;
        }
        context.level.setBlock(context.pos, before.setValue(property, change.next()), 3);
        evidence.addProperty("destroyed", false);
        evidence.addProperty("after", change.next());
    }

    private static IntegerProperty integerProperty(BlockState state, String name) {
        Property<?> property = state.getBlock().getStateDefinition().getProperty(name);
        if (property instanceof IntegerProperty integerProperty) {
            return integerProperty;
        }
        return null;
    }
}
