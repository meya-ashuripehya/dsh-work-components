package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;

/** Read-back verification for multi-cell blocks (doors, beds). */
public final class MultiBlockVerify {
    private MultiBlockVerify() {
    }

    public static boolean verify(ServerLevel level, BlockPos primary, Block block, JsonObject requested, JsonObject evidence) {
        if (block instanceof DoorBlock) {
            return verifyDoor(level, primary, requested, evidence);
        }
        if (block instanceof BedBlock) {
            return verifyBed(level, primary, requested, evidence);
        }
        return true;
    }

    private static boolean verifyDoor(ServerLevel level, BlockPos primary, JsonObject requested, JsonObject evidence) {
        BlockState lower = level.getBlockState(primary);
        if (!(lower.getBlock() instanceof DoorBlock)) {
            return false;
        }
        DoubleBlockHalf half = lower.getValue(DoorBlock.HALF);
        BlockPos otherPos = half == DoubleBlockHalf.LOWER ? primary.above() : primary.below();
        BlockState upper = level.getBlockState(otherPos);
        JsonArray cells = new JsonArray();
        cells.add(cell(level, primary));
        cells.add(cell(level, otherPos));
        evidence.add("related_cells", cells);
        if (!(upper.getBlock() instanceof DoorBlock)) {
            evidence.addProperty("multi_cell", "door_second_missing");
            return false;
        }
        return FacingPlacement.partialMatches(lower, requested);
    }

    private static boolean verifyBed(ServerLevel level, BlockPos primary, JsonObject requested, JsonObject evidence) {
        BlockState head = level.getBlockState(primary);
        if (!(head.getBlock() instanceof BedBlock)) {
            return false;
        }
        BedPart part = head.getValue(BedBlock.PART);
        Direction facing = head.getValue(BedBlock.FACING);
        BlockPos otherPos = part == BedPart.HEAD ? primary.relative(facing.getOpposite()) : primary.relative(facing);
        JsonArray cells = new JsonArray();
        cells.add(cell(level, primary));
        cells.add(cell(level, otherPos));
        evidence.add("related_cells", cells);
        BlockState other = level.getBlockState(otherPos);
        if (!(other.getBlock() instanceof BedBlock)) {
            evidence.addProperty("multi_cell", "bed_second_missing");
            return false;
        }
        return FacingPlacement.partialMatches(head, requested);
    }

    private static JsonObject cell(ServerLevel level, BlockPos pos) {
        BlockState state = level.getBlockState(pos);
        JsonObject cell = new JsonObject();
        cell.addProperty("x", pos.getX());
        cell.addProperty("y", pos.getY());
        cell.addProperty("z", pos.getZ());
        cell.addProperty("block_id", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        return cell;
    }
}
