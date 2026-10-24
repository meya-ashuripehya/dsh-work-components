package com.trix.gamebot.bridge.action;

import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Placement context with explicit horizontal facing and pitch for vertical placement.
 * Player is null; facing comes from exploration, not entity look defaults.
 */
public final class OrientedPlaceContext extends BlockPlaceContext {
    private final Direction horizontal;
    private final Direction nearestLooking;
    private final float yaw;
    private final float pitch;

    public OrientedPlaceContext(Level level, ItemStack stack, BlockHitResult hit, Direction horizontal, Direction nearestLooking, float yaw, float pitch) {
        super(level, null, InteractionHand.MAIN_HAND, stack, hit);
        this.horizontal = horizontal;
        this.nearestLooking = nearestLooking;
        this.yaw = yaw;
        this.pitch = pitch;
    }

    public static OrientedPlaceContext horizontal(Level level, ItemStack stack, BlockHitResult hit, Direction horizontal) {
        float yaw = horizontal.toYRot();
        return new OrientedPlaceContext(level, stack, hit, horizontal, horizontal, yaw, 0.0F);
    }

    public static OrientedPlaceContext vertical(Level level, ItemStack stack, BlockHitResult hit, Direction vertical) {
        float pitch = vertical == Direction.UP ? -90.0F : 90.0F;
        Direction horizontal = Direction.NORTH;
        return new OrientedPlaceContext(level, stack, hit, horizontal, vertical, horizontal.toYRot(), pitch);
    }

    public Direction horizontal() {
        return horizontal;
    }

    public float horizontalYaw() {
        return yaw;
    }

    public float placementPitch() {
        return pitch;
    }

    @Override
    public float getRotation() {
        return yaw;
    }

    @Override
    public Direction getHorizontalDirection() {
        return horizontal;
    }

    @Override
    public Direction getNearestLookingDirection() {
        return nearestLooking;
    }

    @Override
    public Direction[] getNearestLookingDirections() {
        if (nearestLooking == Direction.UP || nearestLooking == Direction.DOWN) {
            return new Direction[] { nearestLooking, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST };
        }
        return new Direction[] { nearestLooking, nearestLooking.getOpposite(), Direction.UP, Direction.DOWN };
    }

    @Override
    public Vec3 getClickLocation() {
        return super.getClickLocation();
    }
}
