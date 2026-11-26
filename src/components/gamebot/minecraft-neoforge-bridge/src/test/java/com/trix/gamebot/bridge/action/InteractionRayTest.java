package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.jupiter.api.Assertions.*;

class InteractionRayTest {
    @Test void extendsPastSurfaceButRejectsAnEarlierWall() {
        var agent=mock(AgentEntity.class);var level=mock(ServerLevel.class);var target=new BlockPos(2,0,0);
        when(agent.level()).thenReturn(level);when(agent.getEyePosition()).thenReturn(new Vec3(0.5,1.6,0.5));
        when(level.clip(any(ClipContext.class))).thenAnswer(call->{
            ClipContext ray=call.getArgument(0);assertTrue(ray.getTo().x>2);assertTrue(ray.getTo().x<2.001);
            return new BlockHitResult(new Vec3(2,.5,.5),Direction.WEST,target,false);
        });
        assertTrue(InteractionRay.canSee(agent,target,new Vec3(2,.5,.5)));
        when(level.clip(any(ClipContext.class))).thenReturn(new BlockHitResult(new Vec3(1,.5,.5),Direction.WEST,new BlockPos(1,0,0),false));
        assertFalse(InteractionRay.canSee(agent,target,new Vec3(2,.5,.5)));
    }
}
