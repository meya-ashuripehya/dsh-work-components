package com.trix.gamebot.bridge.observation;

import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.status.ChunkStatus;

/** 用未弃用的区块查询判断目标是否已加载。 */
public final class WorldQueries {
    private WorldQueries() {
    }

    public static boolean chunkLoaded(Level level, BlockPos pos) {
        return level.getChunk(
                SectionPos.blockToSectionCoord(pos.getX()),
                SectionPos.blockToSectionCoord(pos.getZ()),
                ChunkStatus.FULL,
                false
        ) != null;
    }
}
