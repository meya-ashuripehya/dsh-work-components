package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.SharedConstants;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PartialStateMatchTest {
    @BeforeAll
    static void boot() {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
    }

    @Test
    void onlySpecifiedPropertiesAreRequired() {
        BlockState stair = Blocks.OAK_STAIRS.defaultBlockState().setValue(StairBlock.FACING, Direction.NORTH);
        JsonObject partial = new JsonObject();
        partial.addProperty("facing", "north");
        assertTrue(FacingPlacement.partialMatches(stair, partial));
        partial.addProperty("half", "top");
        assertFalse(FacingPlacement.partialMatches(stair, partial));
    }
}
