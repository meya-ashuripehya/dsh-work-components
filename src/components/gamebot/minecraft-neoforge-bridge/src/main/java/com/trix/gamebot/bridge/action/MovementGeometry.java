package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Shared standability and body clearance checks for movement and placement stances. */
public final class MovementGeometry {
    private MovementGeometry() {
    }

    public static boolean canStandAt(ServerLevel level, AgentEntity agent, double x, double y, double z) {
        if (!isSafeUnderfoot(level, agent, x, y, z)) {
            return false;
        }
        AABB box = agentDimensionsAt(agent, x, y, z);
        if (!level.noCollision(agent, box)) {
            return false;
        }
        return !touchesHazard(level, box);
    }

    public static boolean bodyClearAt(ServerLevel level, AgentEntity agent, double x, double y, double z) {
        return level.noCollision(agent, agentDimensionsAt(agent, x, y, z));
    }

    private static AABB agentDimensionsAt(AgentEntity agent, double x, double y, double z) {
        AABB base = agent.getBoundingBox();
        double halfW = (base.getXsize()) / 2.0;
        double height = base.getYsize();
        return new AABB(x - halfW, y, z - halfW, x + halfW, y + height, z + halfW);
    }

    private static boolean isSafeUnderfoot(ServerLevel level, AgentEntity agent, double x, double y, double z) {
        BlockPos feet = BlockPos.containing(x, y - 0.05, z);
        BlockState below = level.getBlockState(feet);
        if (below.isAir()) {
            BlockState deeper = level.getBlockState(feet.below());
            if (deeper.isAir() && level.getFluidState(feet).isEmpty()) {
                return false;
            }
        }
        if (level.getFluidState(feet).is(FluidTags.LAVA) || level.getFluidState(feet.below()).is(FluidTags.LAVA)) {
            return false;
        }
        if (below.is(BlockTags.FIRE) || below.is(BlockTags.CAMPFIRES)) {
            return false;
        }
        return !below.isAir() || !level.getFluidState(feet).isEmpty() || agent.onClimbable();
    }

    private static boolean touchesHazard(ServerLevel level, AABB box) {
        int x0 = (int) Math.floor(box.minX);
        int x1 = (int) Math.floor(box.maxX);
        int y0 = (int) Math.floor(box.minY);
        int y1 = (int) Math.floor(box.maxY);
        int z0 = (int) Math.floor(box.minZ);
        int z1 = (int) Math.floor(box.maxZ);
        for (int x = x0; x <= x1; x++) {
            for (int y = y0; y <= y1; y++) {
                for (int z = z0; z <= z1; z++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    if (level.getFluidState(pos).is(FluidTags.LAVA)) {
                        return true;
                    }
                    BlockState state = level.getBlockState(pos);
                    if (state.is(BlockTags.FIRE) || state.is(BlockTags.CAMPFIRES)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    public static double feetDistance(Vec3 feet, double x, double y, double z) {
        return feet.distanceTo(new Vec3(x, y, z));
    }

    public static void writeFeet(JsonObject evidence, AgentEntity agent) {
        JsonObject position = new JsonObject();
        position.addProperty("x", agent.getX());
        position.addProperty("y", agent.getY());
        position.addProperty("z", agent.getZ());
        evidence.add("feet", position);
        JsonObject eye = new JsonObject();
        Vec3 eyePos = agent.getEyePosition();
        eye.addProperty("x", eyePos.x);
        eye.addProperty("y", eyePos.y);
        eye.addProperty("z", eyePos.z);
        evidence.add("eye", eye);
    }
}
