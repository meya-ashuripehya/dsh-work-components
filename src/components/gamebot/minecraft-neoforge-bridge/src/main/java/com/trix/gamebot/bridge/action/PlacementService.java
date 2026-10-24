package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.trix.gamebot.bridge.observation.WorldQueries;
import com.trix.gamebot.bridge.protocol.FacePoints;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Map;

/**
 * Placement orchestration: validate, optional movement, single vanilla BlockItem.place, read-back.
 */
public final class PlacementService {
    public enum Phase {
        APPROACH,
        PLACE,
        AWAIT_STOP
    }

    public static final class Run {
        public Phase phase = Phase.APPROACH;
        public MovementSession movement;
        public JsonObject params;
        public JsonObject evidence = new JsonObject();
        public boolean submitted;
        public int materialSlot = -1;
        public int materialBefore;
        public BlockPos target;
        public BlockPos supportPos;
        public Direction clicked;
        public Vec3 hitPoint;
        public String blockId;
        public JsonObject requestedState = new JsonObject();
        public double maxDistance;
        public boolean autoMove = true;
    }

    private PlacementService() {
    }

    public static boolean autoMove(JsonObject params) {
        return !params.has("auto_move") || params.get("auto_move").getAsBoolean();
    }

    public static ActionOutcome start(AgentEntity agent, JsonObject params, long deadlineMs) {
        Run run = new Run();
        run.params = params;
        return startWithRun(agent, run, deadlineMs);
    }

    public static ActionOutcome startWithRun(AgentEntity agent, Run run, long deadlineMs) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        JsonObject params = run.params;
        run.autoMove = autoMove(params);
        run.target = blockPos(params);
        run.blockId = params.get("block_id").getAsString();
        run.requestedState = params.has("state") ? params.getAsJsonObject("state") : new JsonObject();
        run.maxDistance = params.get("max_distance").getAsDouble();
        run.evidence.add("pos", posJson(run.target));
        run.evidence.addProperty("block_id", run.blockId);
        run.evidence.addProperty("stage", "validate");
        stampWorld(level, run.evidence);
        MovementExclusions exclusions = MovementExclusions.parse(params);
        exclusions.writeEvidence(run.evidence);

        Block block = BuiltInRegistries.BLOCK.getOptional(net.minecraft.resources.ResourceLocation.parse(run.blockId)).orElse(null);
        if (block == null) {
            return ActionOutcome.failure("invalid_params", "block_id is not a known block", run.evidence);
        }
        if (!WorldQueries.chunkLoaded(level, run.target)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded", run.evidence);
        }
        BlockState existing = level.getBlockState(run.target);
        if (blockId(existing).equals(run.blockId) && stateMatches(existing, run.requestedState)) {
            run.evidence.addProperty("already_present", true);
            run.evidence.add("state", stateJson(existing));
            run.evidence.addProperty("summary", "目标位置已满足要求");
            return ActionOutcome.done(true, "observed", null, null, "already in place", run.evidence);
        }
        if (!existing.isAir() && !existing.canBeReplaced()) {
            run.evidence.addProperty("actual_block", blockId(existing));
            return ActionOutcome.failure("position_occupied", "目标位置已被占用", run.evidence);
        }
        int slot = findBlockItem(agent, run.blockId, 0, 8);
        if (slot < 0) {
            if (findBlockItem(agent, run.blockId, 9, agent.inventory().getContainerSize() - 1) >= 0) {
                run.evidence.addProperty("material_in_hotbar", false);
                return ActionOutcome.failure("unsupported", "方块仅在背包非快捷栏槽位", run.evidence);
            }
            run.evidence.addProperty("material_in_hotbar", false);
            return ActionOutcome.failure("item_not_found", "快捷栏中没有所需方块", run.evidence);
        }
        run.materialSlot = slot;
        run.materialBefore = agent.inventory().getItem(slot).getCount();

        Direction support = supportDirection(level, run.target, params);
        if (support == null) {
            return ActionOutcome.failure("action_rejected", "没有可用的支撑相邻方块", run.evidence);
        }
        run.supportPos = run.target.relative(support);
        run.clicked = support.getOpposite();
        run.hitPoint = hitVec(run.supportPos, params, run.clicked);

        if (run.autoMove && PlacementStances.canInteractNow(level, agent, run.supportPos, run.hitPoint, run.maxDistance)) {
            run.phase = Phase.PLACE;
            return executePlace(agent, run);
        }
        if (!run.autoMove) {
            JsonObject gateParams = gateParams(params, run.clicked);
            ActionOutcome gate = gateBlock(agent, gateParams, run.supportPos, run.hitPoint);
            if (gate != null) {
                return gate;
            }
            run.phase = Phase.PLACE;
            return executePlace(agent, run);
        }
        List<NavCandidate> stances = PlacementStances.candidatesFor(level, agent, run.target, run.supportPos, run.hitPoint, run.maxDistance, exclusions);
        if (stances.isEmpty()) {
            run.evidence.addProperty("summary", "找不到可到达的交互站位");
            return ActionOutcome.failure("out_of_reach", "没有满足距离与视线的交互站位", run.evidence);
        }
        NavCandidate chosen = MovementService.selectReachable(agent, stances, exclusions);
        if (chosen == null) {
            run.evidence.addProperty("candidate_count", stances.size());
            return ActionOutcome.failure("out_of_reach", "候选站位均不可达", run.evidence);
        }
        run.evidence.addProperty("stage", "approach");
        chosen.writeEvidence(run.evidence);
        run.movement = MovementService.begin(agent, chosen, MovementService.PLACEMENT_TOLERANCE, exclusions, deadlineMs);
        run.phase = Phase.APPROACH;
        return null;
    }

    public static ActionOutcome tick(AgentEntity agent, Run run, long nowMs, Runnable validityCheck) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        if (run.phase == Phase.APPROACH && run.movement != null) {
            validityCheck.run();
            ActionOutcome move = MovementService.tick(agent, run.movement, nowMs);
            if (move == null) {
                return null;
            }
            if (!move.ok) {
                run.evidence.addProperty("stage", "approach");
                mergeEvidence(run.evidence, move.evidence);
                return move;
            }
            mergeEvidence(run.evidence, move.evidence);
            run.phase = Phase.AWAIT_STOP;
            return null;
        }
        if (run.phase == Phase.AWAIT_STOP) {
            if (run.movement != null && !MovementService.stopComplete(agent, run.movement)) {
                return null;
            }
            run.phase = Phase.PLACE;
            return recheckAndPlace(agent, run, validityCheck);
        }
        return null;
    }

    private static ActionOutcome recheckAndPlace(AgentEntity agent, Run run, Runnable validityCheck) {
        validityCheck.run();
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        BlockState existing = level.getBlockState(run.target);
        if (!existing.isAir() && !existing.canBeReplaced()) {
            run.evidence.addProperty("actual_block", blockId(existing));
            run.evidence.addProperty("summary", "到位后目标已被占用");
            return ActionOutcome.failure("position_occupied", "到位后目标已被占用", run.evidence);
        }
        ItemStack stack = agent.inventory().getItem(run.materialSlot);
        if (stack.isEmpty() || !run.blockId.equals(blockKey(((BlockItem) stack.getItem()).getBlock()))) {
            run.evidence.addProperty("summary", "到位后材料已变化");
            return ActionOutcome.failure("item_not_found", "到位后快捷栏材料不匹配", run.evidence);
        }
        if (!PlacementStances.canInteractNow(level, agent, run.supportPos, run.hitPoint, run.maxDistance)) {
            MovementGeometry.writeFeet(run.evidence, agent);
            run.evidence.addProperty("summary", "到位后距离或视线不满足，未执行放置");
            return ActionOutcome.failure("line_of_sight_blocked", "到位后交互条件不满足", run.evidence);
        }
        return executePlace(agent, run);
    }

    private static ActionOutcome executePlace(AgentEntity agent, Run run) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        run.evidence.addProperty("stage", "place");
        Block block = BuiltInRegistries.BLOCK.getOptional(net.minecraft.resources.ResourceLocation.parse(run.blockId)).orElse(null);
        agent.selectSlot(run.materialSlot);
        boolean resumeLook = agent.suspendLook();
        agent.armMainHand();
        boolean consumed = false;
        OrientedPlaceContext chosen = null;
        try {
            ItemStack stack = agent.getMainHandItem();
            BlockHitResult click = new BlockHitResult(run.hitPoint, run.clicked, run.supportPos, false);
            chosen = FacingPlacement.choose(level, block, stack, click, run.requestedState);
            if (chosen == null) {
                run.evidence.addProperty("state_unachievable", true);
                stampWorld(level, run.evidence);
                return ActionOutcome.failure("state_unachievable", "原版放置无法产生请求的状态", run.evidence);
            }
            agent.lockFacing(chosen.horizontalYaw(), chosen.placementPitch());
            run.submitted = true;
            run.evidence.addProperty("placement_submitted", true);
            consumed = ((BlockItem) stack.getItem()).place(chosen).consumesAction();
        } finally {
            agent.disarmMainHand();
            if (resumeLook) {
                agent.resumeLook();
            }
        }
        stampWorld(level, run.evidence);
        run.evidence.addProperty("support_pos", run.supportPos.toShortString());
        run.evidence.addProperty("clicked_face", run.clicked.getName());
        if (chosen != null) {
            run.evidence.addProperty("facing_yaw", chosen.horizontalYaw());
            run.evidence.addProperty("facing_pitch", chosen.placementPitch());
        }
        int after = agent.inventory().getItem(run.materialSlot).getCount();
        run.evidence.addProperty("material_before", run.materialBefore);
        run.evidence.addProperty("material_after", after);
        BlockState placed = level.getBlockState(run.target);
        run.evidence.add("state", stateJson(placed));
        if (!consumed || !blockId(placed).equals(run.blockId)) {
            run.evidence.addProperty("actual_block", blockId(placed));
            run.evidence.addProperty("diagnosis", "unknown");
            run.evidence.addProperty("summary", "放置被拒绝；原因未完全确定");
            return ActionOutcome.failure("action_rejected", "方块未能放置到目标位置", run.evidence);
        }
        boolean matches = stateMatches(placed, run.requestedState);
        boolean multiOk = MultiBlockVerify.verify(level, run.target, block, run.requestedState, run.evidence);
        if (!matches || !multiOk) {
            run.evidence.addProperty("summary", "放置后读回与请求不完全一致");
            return ActionOutcome.done(true, "unverified", null, null, "placed block state did not match", run.evidence);
        }
        run.evidence.addProperty("summary", "放置完成并已读回确认");
        return ActionOutcome.done(true, "confirmed", null, null, "placed block", run.evidence);
    }

    public static ActionOutcome placeInPlace(AgentEntity agent, JsonObject params) {
        Run run = new Run();
        run.params = params;
        run.autoMove = false;
        long deadline = System.currentTimeMillis() + 5_000L;
        ActionOutcome started = startWithRun(agent, run, deadline);
        if (started != null) {
            return started;
        }
        return executePlace(agent, run);
    }

    private static JsonObject gateParams(JsonObject params, Direction clicked) {
        JsonObject gateParams = new JsonObject();
        gateParams.addProperty("face", clicked.getName());
        gateParams.addProperty("max_distance", params.get("max_distance").getAsDouble());
        if (params.has("hit_offset")) {
            gateParams.add("hit_offset", params.getAsJsonObject("hit_offset"));
        }
        return gateParams;
    }

    private static ActionOutcome gateBlock(AgentEntity agent, JsonObject params, BlockPos pos, Vec3 hit) {
        if (!WorldQueries.chunkLoaded(agent.level(), pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        double maxDistance = params.get("max_distance").getAsDouble();
        if (agent.getEyePosition().distanceTo(hit) > maxDistance) {
            return ActionOutcome.failure("out_of_reach", "target is out of reach");
        }
        return InteractionRay.canSee(agent, pos, hit) ? null : ActionOutcome.failure("line_of_sight_blocked", "line of sight is blocked");
    }

    private static void mergeEvidence(JsonObject into, JsonObject from) {
        for (var entry : from.entrySet()) {
            into.add(entry.getKey(), entry.getValue());
        }
    }

    private static Direction supportDirection(ServerLevel level, BlockPos pos, JsonObject params) {
        List<Direction> order = List.of(Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST, Direction.UP);
        if (params.has("face")) {
            Direction face = Direction.byName(params.get("face").getAsString());
            order = face == null ? List.of() : List.of(face);
        }
        for (Direction direction : order) {
            BlockPos neighbour = pos.relative(direction);
            if (!WorldQueries.chunkLoaded(level, neighbour)) {
                continue;
            }
            BlockState state = level.getBlockState(neighbour);
            if (!state.isAir() && !state.canBeReplaced()) {
                return direction;
            }
        }
        return null;
    }

    private static Vec3 hitVec(BlockPos supportPos, JsonObject params, Direction clicked) {
        if (params.has("hit_offset")) {
            JsonObject offset = params.getAsJsonObject("hit_offset");
            return new Vec3(
                    supportPos.getX() + offset.get("x").getAsDouble(),
                    supportPos.getY() + offset.get("y").getAsDouble(),
                    supportPos.getZ() + offset.get("z").getAsDouble()
            );
        }
        double[] center = FacePoints.center(clicked.getName());
        return new Vec3(supportPos.getX() + center[0], supportPos.getY() + center[1], supportPos.getZ() + center[2]);
    }

    private static int findBlockItem(AgentEntity agent, String blockId, int from, int to) {
        for (int slot = from; slot <= to; slot++) {
            ItemStack stack = agent.inventory().getItem(slot);
            if (!stack.isEmpty() && stack.getItem() instanceof BlockItem item && blockId.equals(blockKey(item.getBlock()))) {
                return slot;
            }
        }
        return -1;
    }

    private static String blockKey(Block block) {
        return BuiltInRegistries.BLOCK.getKey(block).toString();
    }

    private static String blockId(BlockState state) {
        return blockKey(state.getBlock());
    }

    private static BlockPos blockPos(JsonObject params) {
        JsonObject pos = params.getAsJsonObject("pos");
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    private static JsonObject posJson(BlockPos pos) {
        JsonObject out = new JsonObject();
        out.addProperty("x", pos.getX());
        out.addProperty("y", pos.getY());
        out.addProperty("z", pos.getZ());
        return out;
    }

    private static void stampWorld(ServerLevel level, JsonObject evidence) {
        evidence.addProperty("dimension", level.dimension().location().toString());
        evidence.addProperty("game_time", level.getGameTime());
    }

    private static boolean stateMatches(BlockState actual, JsonObject requested) {
        return FacingPlacement.partialMatches(actual, requested);
    }

    private static JsonObject stateJson(BlockState state) {
        JsonObject out = new JsonObject();
        for (Property<?> property : state.getProperties()) {
            out.addProperty(property.getName(), valueName(state, property));
        }
        return out;
    }

    private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> property) {
        return property.getName(state.getValue(property));
    }
}
