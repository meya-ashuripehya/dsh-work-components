package com.trix.gamebot.bridge.compat.api;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

public final class AgentActionContext {
    public final ServerLevel level;
    public final AgentEntity agent;
    public final String action;
    public final JsonObject params;
    public final BlockPos pos;

    public AgentActionContext(ServerLevel level, AgentEntity agent, String action, JsonObject params, BlockPos pos) {
        this.level = level;
        this.agent = agent;
        this.action = action;
        this.params = params;
        this.pos = pos;
    }

    public BlockState state() {
        return level.getBlockState(pos);
    }

    public BlockEntity blockEntity() {
        return level.getBlockEntity(pos);
    }

    public String blockId() {
        return BuiltInRegistries.BLOCK.getKey(state().getBlock()).toString();
    }

    public Direction face() {
        String name = params.has("face") ? params.get("face").getAsString() : "up";
        Direction face = Direction.byName(name);
        return face == null ? Direction.UP : face;
    }
}
