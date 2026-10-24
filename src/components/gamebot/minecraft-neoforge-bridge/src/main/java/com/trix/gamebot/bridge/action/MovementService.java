package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.WorldQueries;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.ai.navigation.PathNavigation;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;

import java.util.List;

/** Navigation, goal selection from a fixed candidate set, exclusions, and strict arrival. */
public final class MovementService {
    public static final double MOVE_LIMIT = 96.0;
    public static final double DEFAULT_TOLERANCE = 0.45;
    public static final double PLACEMENT_TOLERANCE = 0.35;
    public static final int MAX_REPLAN = 3;
    public static final int MAX_CANDIDATES = 48;

    private MovementService() {
    }

    public static double tolerance(JsonObject params, double fallback) {
        if (params == null || !params.has("arrival_tolerance")) {
            return fallback;
        }
        double value = params.get("arrival_tolerance").getAsDouble();
        if (!Double.isFinite(value) || value <= 0 || value > 2.0) {
            return fallback;
        }
        return value;
    }

    public static NavCandidate singleGoal(String id, double x, double y, double z) {
        return new NavCandidate(id, x, y, z);
    }

    /**
     * Bounded planning: pick one reachable candidate by path cost. Does not walk the NPC to each candidate.
     */
    public static NavCandidate selectReachable(AgentEntity agent, List<NavCandidate> candidates, MovementExclusions exclusions) {
        if (candidates.isEmpty()) {
            return null;
        }
        if (!(agent.level() instanceof ServerLevel level)) {
            return null;
        }
        PathNavigation navigation = agent.getNavigation();
        NavCandidate best = null;
        double bestCost = Double.MAX_VALUE;
        for (NavCandidate candidate : candidates) {
            if (!WorldQueries.chunkLoaded(level, BlockPos.containing(candidate.x(), candidate.y(), candidate.z()))) {
                continue;
            }
            if (agent.position().distanceTo(new Vec3(candidate.x(), candidate.y(), candidate.z())) > MOVE_LIMIT) {
                continue;
            }
            if (!MovementGeometry.canStandAt(level, agent, candidate.x(), candidate.y(), candidate.z())) {
                continue;
            }
            if (exclusions.contains(new Vec3(candidate.x(), candidate.y(), candidate.z()))) {
                continue;
            }
            Path path = navigation.createPath(candidate.x(), candidate.y(), candidate.z(), 1);
            if (path == null || path.isDone()) {
                continue;
            }
            if (pathCrossesExclusion(path, exclusions)) {
                continue;
            }
            double cost = path.getNodeCount();
            if (cost < bestCost) {
                bestCost = cost;
                best = candidate;
            }
        }
        return best;
    }

    private static boolean pathCrossesExclusion(Path path, MovementExclusions exclusions) {
        if (exclusions.isEmpty() || path == null) {
            return false;
        }
        Vec3 previous = null;
        for (int i = 0; i < path.getNodeCount(); i++) {
            var node = path.getNode(i);
            Vec3 point = new Vec3(node.x + 0.5, node.y, node.z + 0.5);
            if (previous != null && exclusions.segmentCrosses(previous, point)) {
                return true;
            }
            if (exclusions.contains(point)) {
                return true;
            }
            previous = point;
        }
        return false;
    }

    public static MovementSession begin(AgentEntity agent, NavCandidate locked, double tolerance, MovementExclusions exclusions, long deadlineMs) {
        agent.lookAtPoint(locked.x(), locked.y(), locked.z());
        agent.getNavigation().moveTo(locked.x(), locked.y(), locked.z(), 1.0);
        return new MovementSession(locked, tolerance, exclusions, deadlineMs);
    }

    public static ActionOutcome tick(AgentEntity agent, MovementSession session, long nowMs) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        if (session.awaitingStop) {
            if (!agent.getNavigation().isDone() && nowMs - session.stopRequestedAtMs < 2_000L) {
                return null;
            }
            agent.getNavigation().stop();
            return null;
        }
        if (nowMs >= session.deadlineMs) {
            requestStop(agent, session);
            return failureMove(session, "timeout", "移动超时", level, agent);
        }
        Vec3 goal = session.goal();
        if (!WorldQueries.chunkLoaded(level, BlockPos.containing(goal.x, goal.y, goal.z))) {
            requestStop(agent, session);
            return failureMove(session, "block_unloaded", "目标区块未加载", level, agent);
        }
        Vec3 feet = agent.position();
        if (session.exclusions.contains(feet)) {
            requestStop(agent, session);
            return failureMove(session, "action_rejected", "已进入禁入区", level, agent);
        }
        PathNavigation navigation = agent.getNavigation();
        Path path = navigation.getPath();
        if (path != null && path.getNextNodeIndex() < path.getNodeCount()) {
            var next = path.getNode(path.getNextNodeIndex());
            Vec3 nextPoint = new Vec3(next.x + 0.5, next.y, next.z + 0.5);
            if (session.exclusions.contains(nextPoint) || session.exclusions.segmentCrosses(feet, nextPoint)) {
                if (session.replans >= MAX_REPLAN) {
                    requestStop(agent, session);
                    return failureMove(session, "out_of_reach", "路径需穿越禁入区且重规划次数已用尽", level, agent);
                }
                navigation.stop();
                navigation.moveTo(goal.x, goal.y, goal.z, 1.0);
                session.replans++;
            }
        }
        double dist = MovementGeometry.feetDistance(feet, goal.x, goal.y, goal.z);
        if (dist <= session.tolerance && navigation.isDone() && agent.getDeltaMovement().lengthSqr() < 0.01) {
            if (!MovementGeometry.canStandAt(level, agent, feet.x, feet.y, feet.z)) {
                requestStop(agent, session);
                return failureMove(session, "action_rejected", "到达位置不可安全停留", level, agent);
            }
            if (!session.awaitingStop) {
                requestStop(agent, session);
                return null;
            }
            if (!stopComplete(agent, session)) {
                return null;
            }
            return successMove(session, level, agent, dist);
        }
        if (navigation.isDone() && dist > session.tolerance) {
            if (session.replans >= MAX_REPLAN) {
                requestStop(agent, session);
                return failureMove(session, "out_of_reach", "导航结束但未到达目标", level, agent);
            }
            if (agent.tickCount % 10 == 0) {
                navigation.moveTo(goal.x, goal.y, goal.z, 1.0);
                session.replans++;
            }
        }
        return null;
    }

    public static void requestStop(AgentEntity agent, MovementSession session) {
        session.awaitingStop = true;
        session.stopRequestedAtMs = System.currentTimeMillis();
        agent.getNavigation().stop();
    }

    public static boolean stopComplete(AgentEntity agent, MovementSession session) {
        return agent.getNavigation().isDone() && agent.getDeltaMovement().lengthSqr() < 0.02;
    }

    private static ActionOutcome successMove(MovementSession session, ServerLevel level, AgentEntity agent, double remaining) {
        JsonObject evidence = baseEvidence(session, level, agent);
        evidence.addProperty("stage", "movement");
        evidence.addProperty("navigation_result", "arrived");
        evidence.addProperty("remaining_distance", remaining);
        evidence.addProperty("summary", "移动完成");
        return ActionOutcome.done(true, "confirmed", null, null, "moved", evidence);
    }

    private static ActionOutcome failureMove(MovementSession session, String code, String summary, ServerLevel level, AgentEntity agent) {
        JsonObject evidence = baseEvidence(session, level, agent);
        evidence.addProperty("stage", "movement");
        evidence.addProperty("navigation_result", "failed");
        evidence.addProperty("summary", summary);
        return ActionOutcome.failure(code, summary, evidence);
    }

    public static JsonObject baseEvidence(MovementSession session, ServerLevel level, AgentEntity agent) {
        JsonObject evidence = new JsonObject();
        session.locked.writeEvidence(evidence);
        MovementGeometry.writeFeet(evidence, agent);
        session.exclusions.writeEvidence(evidence);
        evidence.addProperty("arrival_tolerance", session.tolerance);
        evidence.addProperty("replan_count", session.replans);
        evidence.addProperty("remaining_distance", MovementGeometry.feetDistance(agent.position(), session.locked.x(), session.locked.y(), session.locked.z()));
        return evidence;
    }
}
