package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.WorldQueries;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

/** Generate bounded interaction stance candidates around a placement target. */
public final class PlacementStances {
    private static final int MAX_STANCES = 32;
    private static final double[][] OFFSETS = {
            {0, 0, 0},
            {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1},
            {1, 0, 1}, {1, 0, -1}, {-1, 0, 1}, {-1, 0, -1},
            {0, 1, 0}, {0, -1, 0},
    };

    private PlacementStances() {
    }

    public record Stance(NavCandidate candidate, double distance) {
    }

    public static List<NavCandidate> candidatesFor(
            ServerLevel level,
            AgentEntity agent,
            BlockPos target,
            BlockPos supportPos,
            Vec3 hitPoint,
            double maxDistance,
            MovementExclusions exclusions
    ) {
        List<NavCandidate> out = new ArrayList<>();
        int index = 0;
        for (double[] offset : OFFSETS) {
            if (out.size() >= MAX_STANCES) {
                break;
            }
            double x = target.getX() + 0.5 + offset[0];
            double y = target.getY() + offset[1];
            double z = target.getZ() + 0.5 + offset[2];
            if (!WorldQueries.chunkLoaded(level, BlockPos.containing(x, y, z))) {
                continue;
            }
            if (!MovementGeometry.canStandAt(level, agent, x, y, z)) {
                continue;
            }
            if (exclusions.contains(new Vec3(x, y, z))) {
                continue;
            }
            Vec3 eye = eyeAt(agent, x, y, z);
            if (eye.distanceTo(hitPoint) > maxDistance) {
                continue;
            }
            if (!lineOfSight(level, agent, eye, hitPoint, supportPos)) {
                continue;
            }
            if (!MovementGeometry.bodyClearAt(level, agent, x, y, z)) {
                continue;
            }
            String id = "s" + index++;
            out.add(new NavCandidate(id, x, y, z));
        }
        return out;
    }

    private static Vec3 eyeAt(AgentEntity agent, double x, double y, double z) {
        double eyeHeight = agent.getEyeHeight();
        return new Vec3(x, y + eyeHeight, z);
    }

    private static boolean lineOfSight(ServerLevel level, AgentEntity agent, Vec3 from, Vec3 to, BlockPos supportPos) {
        BlockHitResult clip = level.clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, agent));
        if (clip.getType() == HitResult.Type.MISS) {
            return true;
        }
        return clip.getBlockPos().equals(supportPos) || clip.getBlockPos().equals(supportPos.relative(clip.getDirection().getOpposite()));
    }

    public static boolean canInteractNow(ServerLevel level, AgentEntity agent, BlockPos supportPos, Vec3 hitPoint, double maxDistance) {
        Vec3 eye = agent.getEyePosition();
        if (eye.distanceTo(hitPoint) > maxDistance) {
            return false;
        }
        return lineOfSight(level, agent, eye, hitPoint, supportPos);
    }

    public static boolean targetStillPlaceable(ServerLevel level, BlockPos target, String blockId, JsonBlockState requested) {
        BlockState existing = level.getBlockState(target);
        if (existing.isAir()) {
            return true;
        }
        return existing.canBeReplaced();
    }

    /** Minimal block state comparison wrapper to avoid pulling Gson into stance helpers. */
    public static final class JsonBlockState {
        private final com.google.gson.JsonObject props;

        public JsonBlockState(com.google.gson.JsonObject props) {
            this.props = props == null ? new com.google.gson.JsonObject() : props;
        }

        public com.google.gson.JsonObject props() {
            return props;
        }
    }
}
