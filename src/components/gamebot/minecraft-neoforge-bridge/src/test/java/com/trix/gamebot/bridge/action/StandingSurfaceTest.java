package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.WorldQueries;
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.google.gson.JsonParser;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class StandingSurfaceTest {
    @BeforeAll
    static void boot() { SharedConstants.tryDetectVersion(); Bootstrap.bootStrap(); }

    @Test
    void fullBlockAndSlabUseTheirActualCollisionTop() {
        ServerLevel level = mock(ServerLevel.class);
        AgentEntity agent = mock(AgentEntity.class);
        BlockPos support = new BlockPos(125, -61, 225);
        try (var queries = mockStatic(WorldQueries.class);
             var geometry = mockStatic(MovementGeometry.class, CALLS_REAL_METHODS)) {
            queries.when(() -> WorldQueries.chunkLoaded(level, support)).thenReturn(true);
            geometry.when(() -> MovementGeometry.canStandAt(eq(level), eq(agent), anyDouble(), anyDouble(), anyDouble())).thenReturn(true);
            when(level.getBlockState(support)).thenReturn(Blocks.GRASS_BLOCK.defaultBlockState());
            assertEquals(new Vec3(125.5, -60, 225.5), MovementGeometry.standingSurface(level, agent, support));
            when(agent.level()).thenReturn(level);
            when(agent.getX()).thenReturn(125.5); when(agent.getY()).thenReturn(-60.0); when(agent.getZ()).thenReturn(222.5);
            when(agent.position()).thenReturn(new Vec3(125.5, -60, 222.5));
            var blocks = JsonParser.parseString("[{\"pos\":{\"x\":125,\"y\":-61,\"z\":225}}]").getAsJsonArray();
            var goals = ServerSnapshotService.standableGoals(agent, blocks);
            assertEquals(1, goals.size());
            assertEquals(-60, goals.get(0).getAsJsonObject().getAsJsonObject("position").get("y").getAsDouble());
            assertFalse(goals.get(0).getAsJsonObject().get("path_checked").getAsBoolean());
            when(level.getBlockState(support)).thenReturn(Blocks.STONE_SLAB.defaultBlockState());
            assertEquals(new Vec3(125.5, -60.5, 225.5), MovementGeometry.standingSurface(level, agent, support));
            geometry.when(() -> MovementGeometry.canStandAt(eq(level), eq(agent), anyDouble(), anyDouble(), anyDouble())).thenReturn(false);
            assertNull(MovementGeometry.standingSurface(level, agent, support));
            when(level.getBlockState(support)).thenReturn(Blocks.AIR.defaultBlockState());
            assertNull(MovementGeometry.standingSurface(level, agent, support));
        }
    }

    @Test
    void unloadedSurfaceDoesNotReadOrLoadBlocks() {
        ServerLevel level = mock(ServerLevel.class);
        try (var queries = mockStatic(WorldQueries.class)) {
            assertNull(MovementGeometry.standingSurface(level, mock(AgentEntity.class), BlockPos.ZERO));
            verifyNoInteractions(level);
        }
    }
}
