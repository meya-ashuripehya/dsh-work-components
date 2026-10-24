package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

public final class InteractionRay {
    private InteractionRay() {
    }

    public static boolean canSee(AgentEntity agent, BlockPos pos, Vec3 hit) {
        BlockHitResult clip = agent.level().clip(new ClipContext(
                agent.getEyePosition(),
                hit,
                ClipContext.Block.COLLIDER,
                ClipContext.Fluid.NONE,
                agent
        ));
        if (clip.getType() == HitResult.Type.MISS) {
            return agent.level().getBlockState(pos).getCollisionShape(agent.level(), pos).isEmpty();
        }
        return clip.getBlockPos().equals(pos);
    }
}
