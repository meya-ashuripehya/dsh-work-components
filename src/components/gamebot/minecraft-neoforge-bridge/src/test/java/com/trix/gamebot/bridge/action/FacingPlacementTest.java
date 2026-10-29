package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Half;
import net.minecraft.world.level.block.state.properties.StairsShape;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Uses vanilla StairBlock.getStateForPlacement through OrientedPlaceContext.
 * The level is a mock: the clicked support is stone, every other cell is air.
 * This is not a live world placement.
 */
class FacingPlacementTest {
    @BeforeAll
    static void boot() {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
    }

    @Test
    void vanillaStairsFollowTheContextFacingOnAnUpClick() {
        Level level = airAroundStoneSupport();
        BlockPos support = new BlockPos(0, 64, 0);
        BlockHitResult click = upClick(support);
        ItemStack stack = new ItemStack(Blocks.POLISHED_DIORITE_STAIRS);
        for (Direction facing : Direction.Plane.HORIZONTAL) {
            BlockState desired = stair(facing);
            OrientedPlaceContext chosen = FacingPlacement.choose(level, Blocks.POLISHED_DIORITE_STAIRS, stack, click, desired);
            assertNotNull(chosen, facing.getName());
            assertEquals(facing, chosen.getHorizontalDirection());
            BlockState predicted = Blocks.POLISHED_DIORITE_STAIRS.getStateForPlacement(chosen);
            assertSame(chosen.horizontal(), facing);
            assertEquals(facing, predicted.getValue(StairBlock.FACING));
            assertEquals(Half.BOTTOM, predicted.getValue(StairBlock.HALF));
            assertEquals(StairsShape.STRAIGHT, predicted.getValue(StairBlock.SHAPE));
            assertEquals(false, predicted.getValue(StairBlock.WATERLOGGED));
            BlockState again = Blocks.POLISHED_DIORITE_STAIRS.getStateForPlacement(chosen);
            assertEquals(predicted, again);
        }
    }

    @Test
    void partialStateOnlyConstrainsListedProperties() {
        Level level = airAroundStoneSupport();
        BlockHitResult click = upClick(new BlockPos(0, 64, 0));
        ItemStack stack = new ItemStack(Blocks.POLISHED_DIORITE_STAIRS);
        JsonObject partial = new JsonObject();
        partial.addProperty("facing", "east");
        OrientedPlaceContext chosen = FacingPlacement.choose(level, Blocks.POLISHED_DIORITE_STAIRS, stack, click, partial);
        assertNotNull(chosen);
        BlockState predicted = Blocks.POLISHED_DIORITE_STAIRS.getStateForPlacement(chosen);
        assertEquals(Direction.EAST, predicted.getValue(StairBlock.FACING));
        assertTrue(FacingPlacement.partialMatches(predicted, partial));
    }

    @Test
    void cornerShapeIsNotProducedByAnIsolatedUpClick() {
        Level level = airAroundStoneSupport();
        BlockState corner = stair(Direction.SOUTH).setValue(StairBlock.SHAPE, StairsShape.INNER_LEFT);
        OrientedPlaceContext chosen = FacingPlacement.choose(
                level, Blocks.POLISHED_DIORITE_STAIRS, new ItemStack(Blocks.POLISHED_DIORITE_STAIRS), upClick(new BlockPos(0, 64, 0)), corner);
        assertNull(chosen);
    }

    private static BlockState stair(Direction facing) {
        return Blocks.POLISHED_DIORITE_STAIRS.defaultBlockState()
                .setValue(StairBlock.FACING, facing)
                .setValue(StairBlock.HALF, Half.BOTTOM)
                .setValue(StairBlock.SHAPE, StairsShape.STRAIGHT)
                .setValue(StairBlock.WATERLOGGED, false);
    }

    private static BlockHitResult upClick(BlockPos support) {
        Vec3 hit = new Vec3(support.getX() + 0.5, support.getY() + 1.0, support.getZ() + 0.5);
        return new BlockHitResult(hit, Direction.UP, support, false);
    }

    private static Level airAroundStoneSupport() {
        Level level = mock(Level.class);
        BlockPos support = new BlockPos(0, 64, 0);
        when(level.getBlockState(any(BlockPos.class))).thenAnswer(invocation -> {
            BlockPos pos = invocation.getArgument(0);
            if (support.equals(pos)) {
                return Blocks.STONE.defaultBlockState();
            }
            return Blocks.AIR.defaultBlockState();
        });
        when(level.getFluidState(any(BlockPos.class))).thenReturn(Fluids.EMPTY.defaultFluidState());
        return level;
    }
}
