package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.command.AgentCommands;
import com.trix.gamebot.bridge.compat.AgentAdapterRegistry;
import com.trix.gamebot.bridge.compat.api.AgentActionContext;
import com.trix.gamebot.bridge.compat.api.AgentInteractionAdapter;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.trix.gamebot.bridge.observation.WorldQueries;
import com.trix.gamebot.bridge.protocol.FacePoints;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.protocol.ProtocolException;
import com.trix.gamebot.bridge.protocol.Validators;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 服务端线程上的 NPC 动作。每个成员各自记账，移动和挖掘由 tick 推进，不占用玩家键鼠。 */
public final class ServerActionDispatcher {
    private static final double ATTACK_REACH = 3.5;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Map<String, String> requestPayloads = new ConcurrentHashMap<>();
    private final ActionLedger ledger = new ActionLedger(10);
    private final NavigationTasks tasks = new NavigationTasks();
    public JsonObject taskView(String id) { return tasks.view(id); }
    public String taskInterest(String id) { return tasks.interest(id); }
    public void clearTasks() { tasks.clear(); }
    private ActionReplies replies;

    public void bind(ActionReplies replies) {
        this.replies = replies;
    }

    public void accept(MinecraftServer minecraftServer, String agentId, long generation, JsonObject message) {
        String requestId = text(message, "request_id");
        JsonObject data = message.has("data") && message.get("data").isJsonObject() ? message.get("data").getAsJsonObject() : new JsonObject();
        String action = text(data, "action");
        AgentEntity scopedAgent = AgentCommands.find(minecraftServer, agentId);
        String world = text(data, "world_id");
        String dimension = text(data, "dimension");
        if ((world != null && !world.equals(com.trix.gamebot.bridge.entity.AgentRegistry.get(minecraftServer).worldId()))
                || (dimension != null && (scopedAgent == null || !dimension.equals(scopedAgent.level().dimension().location().toString())))) {
            reply(agentId, generation, requestId, action, ActionOutcome.failure("action_rejected", "stale world or dimension"));
            return;
        }
        if (requestId == null || action == null) {
            reply(agentId, generation, requestId, action, ActionOutcome.failure("invalid_params", "request_id and action are required"));
            return;
        }
        JsonObject params;
        try {
            params = Validators.validateAction(action, data.has("params") && data.get("params").isJsonObject() ? data.get("params").getAsJsonObject() : new JsonObject());
        } catch (ProtocolException e) {
            reply(agentId, generation, requestId, action, ActionOutcome.failure(e.code, e.getMessage()));
            return;
        }
        ensureLimiter();
        boolean longRunning = longAction(action, params);
        String payloadKey = key(agentId, requestId);
        String payloadHash = paramsFingerprint(params);
        String priorHash = requestPayloads.get(payloadKey);
        if (priorHash != null && !priorHash.equals(payloadHash)) {
            reply(agentId, generation, requestId, action, ActionOutcome.failure("invalid_params", "request_id reused with different payload"));
            return;
        }
        requestPayloads.put(payloadKey, payloadHash);
        ActionLedger.Decision decision = ledger.accept(agentId, requestId, generation, action, longRunning, System.currentTimeMillis());
        if (decision.status == ActionLedger.Status.DUPLICATE) {
            return;
        }
        if (decision.status != ActionLedger.Status.ACCEPTED) {
            reply(agentId, generation, requestId, action, ActionOutcome.failure(decision.code, decision.message));
            return;
        }
        MinaretDiagnostics.transition(agentId, generation, requestId, "accepted", action);
        AgentEntity agent = AgentCommands.find(minecraftServer, agentId);
        if (agent == null || !agent.isAlive() || !(agent.level() instanceof ServerLevel)) {
            ledger.complete(agentId, requestId, generation);
            reply(agentId, generation, requestId, action, ActionOutcome.failure("client_not_ready", "server npc is not spawned"));
            return;
        }
        if (tasks.active(agentId) && longRunning) {
            ledger.complete(agentId,requestId,generation);
            reply(agentId,generation,requestId,action,ActionOutcome.failure("busy","stop_task before a manual long world action"));return;
        }
        if (NavigationTasks.ACTIONS.contains(action) && ledger.snapshot().stream().anyMatch(j -> j.agentId.equals(agentId) && j.longAction)) {
            ledger.complete(agentId,requestId,generation);
            reply(agentId,generation,requestId,action,ActionOutcome.failure("busy","cancel the previous long world action before starting a task"));return;
        }
        if (data.has("goal") && !data.get("goal").isJsonNull()) {
            agent.setGoal(data.get("goal").getAsString());
        }
        long timeoutMs = longRunning ? 30_000L : 5_000L;
        Pending job = new Pending(agentId, generation, requestId, action, params, System.currentTimeMillis() + timeoutMs);
        if (data.has("claim") && data.get("claim").isJsonObject()) {
            job.claim = data.getAsJsonObject("claim").deepCopy();
        }
        pending.put(key(agentId, requestId), job);
        run(agent, job);
    }

    public void cancel(MinecraftServer minecraftServer, String agentId, long generation, JsonObject message) {
        JsonObject data = message.has("data") && message.get("data").isJsonObject() ? message.get("data").getAsJsonObject() : message;
        String target = text(data, "target_request_id");
        if (target == null) {
            return;
        }
        if (target.equals("*")) {
            tasks.cancel(minecraftServer,agentId,generation,"cancelled");
            for(Pending job:pending.values()) if(job.agentId.equals(agentId)&&job.generation==generation) job.cancel=true;
            tick(minecraftServer);return;
        }
        if (ledger.get(agentId, target, generation) == null) {
            reply(agentId, generation, target, "cancel_action", ActionOutcome.failure("action_rejected", "no such request for this agent"));
            return;
        }
        Pending job = pending.get(key(agentId, target));
        if (job != null && job.generation == generation) {
            job.cancel = true;
        }
        tick(minecraftServer);
    }

    public void tick(MinecraftServer minecraftServer) {
        tasks.tick(minecraftServer);
        if (pending.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        for (Pending job : pending.values()) {
            AgentEntity agent = AgentCommands.find(minecraftServer, job.agentId);
            if (job.cancel || job.terminalOutcome != null) {
                ActionOutcome outcome = job.terminalOutcome != null
                        ? job.terminalOutcome
                        : ActionOutcome.failure("action_rejected", "action cancelled");
                holdOrRelease(agent, job, outcome, job.retainRequest);
                continue;
            }
            if (agent == null || !agent.isAlive()) {
                finish(job, ActionOutcome.failure("client_not_ready", "server npc is not spawned"));
                continue;
            }
            if (job.placing) {
                advancePlace(agent, job, now);
                continue;
            }
            if (job.moving) {
                advanceMove(agent, job, now);
                continue;
            }
            if (job.mining) {
                try { advanceMine(agent, job, now); }
                catch (RuntimeException error) {
                    agent.disarmMainHand();
                    if (agent.level() instanceof ServerLevel level && job.minePos != null) level.destroyBlockProgress(agent.getId(), job.minePos, -1);
                    finish(job, ActionOutcome.failure("action_failed", "mining failed; observe before any retry"));
                }
                continue;
            }
            if (job.using) {
                if (!agent.isUsingItem() && now < job.deadlineMs && job.evidence != null) {
                    agent.disarmMainHand();
                    finish(job, finishUse(agent, job.evidence));
                    continue;
                }
                if (now >= job.deadlineMs) {
                    if (agent.isUsingItem()) {
                        agent.stopUsingItem();
                    }
                    agent.disarmMainHand();
                    finish(job, ActionOutcome.failure("timeout", "action timed out"));
                }
                continue;
            }
            if (!job.started && now >= job.deadlineMs) {
                finish(job, ActionOutcome.failure("timeout", "action timed out"));
            }
        }
    }

    public void failAgent(MinecraftServer minecraftServer, String agentId, long generation, String code, String message) {
        tasks.cancel(minecraftServer,agentId,generation,code);
        for (ActionLedger.Job doomed : ledger.snapshot()) {
            if (!agentId.equals(doomed.agentId) || doomed.generation != generation) {
                continue;
            }
            Pending job = pending.get(key(agentId, doomed.requestId));
            if (job == null || job.generation != generation) {
                ledger.complete(agentId, doomed.requestId, generation);
                continue;
            }
            AgentEntity agent = minecraftServer == null ? null : AgentCommands.find(minecraftServer, agentId);
            holdOrRelease(agent, job, ActionOutcome.failure(code, message), true);
        }
    }

    public void failAll(MinecraftServer minecraftServer, String code, String message) {
        tasks.cancelAll(minecraftServer,code);
        for (Pending job : new ArrayList<>(pending.values())) {
            AgentEntity agent = minecraftServer == null ? null : AgentCommands.find(minecraftServer, job.agentId);
            holdOrRelease(agent, job, ActionOutcome.failure(code, message), true);
        }
        for (ActionLedger.Job doomed : ledger.snapshot()) {
            Pending live = pending.get(key(doomed.agentId, doomed.requestId));
            if (live != null && live.generation == doomed.generation) {
                continue;
            }
            ledger.complete(doomed.agentId, doomed.requestId, doomed.generation);
        }
    }

    private void run(AgentEntity agent, Pending job) {
        if (job.cancel || !pending.containsKey(key(job.agentId, job.requestId))) {
            return;
        }
        job.started = true;
        if (agent.handLocked() && java.util.Set.of("select_item", "drop_item", "use_item", "attack_entity", "interact", "use_item_on_block", "place_block").contains(job.action)) {
            finish(job, ActionOutcome.failure("busy", "wait for the active hand transaction")); return;
        }
        if (ClaimGate.changesWorld(job.action)) {
            ClaimGate.Denial denial = ClaimGate.check(job.agentId, job.generation, job.action, job.params, job.claim, System.currentTimeMillis());
            if (denial != null) {
                finish(job, ActionOutcome.failure(denial.code, denial.message));
                return;
            }
        }
        try {
            ActionOutcome outcome = switch (job.action) {
                case "navigate_to", "follow_entity", "explore_area", "stop_task" -> tasks.submit(job.agentId,job.generation,job.requestId,job.action,job.params,NavigationTasks.driver((MinecraftServer)agent.level().getServer(),agent));
                case "inspect_blocks" -> inspectBlocks(agent,job.params);
                case "look_at" -> lookAt(agent, job.params);
                case "move_to" -> beginMove(agent, job);
                case "select_item" -> select(agent, job.params);
                case "drop_item" -> drop(agent, job.params);
                case "use_item" -> useItem(agent, job);
                case "attack_block" -> beginMine(agent, job);
                case "break_block" -> breakBlock(agent, job);
                case "place_block" -> beginPlace(agent, job);
                case "probe_blocks" -> probeBlocks(agent, job.params);
                case "attack_entity" -> attackEntity(agent, job.params);
                case "find_item" -> findItem(agent, job.params);
                case "interact", "use_item_on_block" -> interact(agent, job.action, job.params);
                default -> ActionOutcome.failure("unsupported", "action is not supported");
            };
            if (outcome == null || outcome.pending) {
                return;
            }
            finish(job, outcome);
        } catch (CancelledAction e) {
            holdOrRelease(agent, job, ActionOutcome.failure("action_rejected", "action cancelled"), false);
        } catch (RuntimeException e) {
            finish(job, ActionOutcome.failure("internal_error", "action failed"));
        }
    }

    private static ActionOutcome lookAt(AgentEntity agent, JsonObject params) {
        agent.lookAtPoint(params.get("x").getAsDouble(), params.get("y").getAsDouble(), params.get("z").getAsDouble());
        JsonObject evidence = new JsonObject();
        evidence.addProperty("yaw", agent.getYRot());
        evidence.addProperty("pitch", agent.getXRot());
        return ActionOutcome.done(true, "confirmed", null, null, "looked", evidence);
    }

    private static ActionOutcome inspectBlocks(AgentEntity agent,JsonObject params) {
        var nearby=ServerSnapshotService.scanNearby(agent,CommonBridgeConfig.scanRadius());
        var scan=com.trix.gamebot.bridge.observation.SemanticPerception.scan(agent,nearby.source,null);
        JsonObject evidence=new JsonObject();evidence.add("visible_blocks",com.trix.gamebot.bridge.observation.SemanticPerception.inspect(scan,params));
        return ActionOutcome.done(true,"observed",null,null,"inspected",evidence);
    }

    private static ActionOutcome beginMove(AgentEntity agent, Pending job) {
        JsonObject params = job.params;
        double x = params.get("x").getAsDouble();
        double y = params.get("y").getAsDouble();
        double z = params.get("z").getAsDouble();
        BlockPos pos = BlockPos.containing(x, y, z);
        if (!WorldQueries.chunkLoaded(agent.level(), pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        if (agent.position().distanceTo(new Vec3(x, y, z)) > MovementService.MOVE_LIMIT) {
            return ActionOutcome.failure("out_of_reach", "target is too far to path without loading chunks");
        }
        if (!MovementGeometry.canStandAt((ServerLevel) agent.level(), agent, x, y, z)) {
            JsonObject evidence = new JsonObject();
            Vec3 surface = MovementGeometry.standingSurface((ServerLevel) agent.level(), agent, pos);
            String hint = surface == null ? "choose a different observed standable_goals position"
                    : "supporting block top has feet y=" + surface.y + "; use an observed standable_goals position";
            evidence.addProperty("requested_feet_y", y);
            return ActionOutcome.failure("action_rejected", "target feet position is not standable (body collision, missing support or hazard); " + hint, evidence);
        }
        MovementExclusions exclusions = MovementExclusions.parse(params);
        double tolerance = MovementService.tolerance(params, MovementService.DEFAULT_TOLERANCE);
        NavCandidate goal = MovementService.singleGoal("move", x, y, z);
        NavCandidate chosen = MovementService.selectReachable(agent, List.of(goal), exclusions);
        if (chosen == null) {
            JsonObject evidence = new JsonObject();
            goal.writeEvidence(evidence);
            exclusions.writeEvidence(evidence);
            evidence.addProperty("summary", "移动失败：目标不可达");
            return ActionOutcome.failure("out_of_reach", "no reachable path to target", evidence);
        }
        job.moving = true;
        job.movementSession = MovementService.begin(agent, chosen, tolerance, exclusions, job.deadlineMs);
        job.movementSession.correlate(job.agentId, job.generation, job.requestId);
        return null;
    }

    private void advanceMove(AgentEntity agent, Pending job, long now) {
        if (job.movementSession == null) {
            finish(job, ActionOutcome.failure("internal_error", "movement session missing"));
            return;
        }
        ActionOutcome outcome = MovementService.tick(agent, job.movementSession, now);
        if (outcome == null) {
            return;
        }
        if (!outcome.ok) {
            holdOrRelease(agent, job, outcome, true);
            return;
        }
        job.moving = false;
        job.movementSession = null;
        finish(job, outcome);
    }

    private static ActionOutcome beginPlace(AgentEntity agent, Pending job) {
        PlacementService.Run run = new PlacementService.Run();
        run.params = job.params;
        run.agentId = job.agentId;
        run.generation = job.generation;
        run.requestId = job.requestId;
        ActionOutcome outcome = PlacementService.startWithRun(agent, run, job.deadlineMs);
        if (outcome != null) {
            return outcome;
        }
        job.placing = true;
        job.placementRun = run;
        return null;
    }

    private void advancePlace(AgentEntity agent, Pending job, long now) {
        if (job.placementRun == null) {
            finish(job, ActionOutcome.failure("internal_error", "placement session missing"));
            return;
        }
        if (job.cancel || job.terminalOutcome != null) {
            ActionOutcome outcome = job.terminalOutcome != null
                    ? job.terminalOutcome
                    : ActionOutcome.failure("action_rejected", "action cancelled");
            holdOrRelease(agent, job, outcome, job.retainRequest);
            return;
        }
        ActionOutcome outcome;
        try {
            outcome = PlacementService.tick(agent, job.placementRun, now, () -> ensureActive(job));
        } catch (CancelledAction ignored) {
            holdOrRelease(agent, job, ActionOutcome.failure("action_rejected", "action cancelled"), false);
            return;
        }
        if (outcome == null) {
            return;
        }
        if (!outcome.ok) {
            holdOrRelease(agent, job, outcome, true);
            return;
        }
        job.placing = false;
        job.placementRun = null;
        finish(job, outcome);
    }

    private void ensureActive(Pending job) {
        if (job.cancel || job.terminalOutcome != null || pending.get(key(job.agentId, job.requestId)) != job) {
            throw new CancelledAction();
        }
    }

    private static ActionOutcome select(AgentEntity agent, JsonObject params) {
        int slot;
        try {
            slot = hotbarSlot(agent, params);
        } catch (ActionRejection rejection) {
            return rejection.outcome;
        }
        JsonObject before = ServerSnapshotService.evidence(agent);
        agent.selectSlot(slot);
        JsonObject after = ServerSnapshotService.evidence(agent);
        String itemId = AgentEntity.itemId(agent.selectedStack());
        return ActionOutcome.done(true, "confirmed", null, null, "selected " + (itemId == null ? "empty" : itemId), ServerSnapshotService.merge(before, after));
    }

    private static ActionOutcome drop(AgentEntity agent, JsonObject params) {
        if (!(agent.level() instanceof ServerLevel level)) return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        int slot;
        if (params.has("item_id")) {
            slot = ResourceActions.dropSlot(agent.inventory(), params.get("item_id").getAsString(), params.get("count").getAsInt());
            if (slot < 0) return ActionOutcome.failure("item_not_found", "no inventory stack contains the requested item and quantity");
        } else {
        try {
            slot = hotbarSlot(agent, params);
        } catch (ActionRejection rejection) {
            return rejection.outcome;
        }
        }
        ItemStack stack = agent.inventory().getItem(slot);
        if (stack.isEmpty()) {
            return ActionOutcome.failure("item_not_found", "hotbar slot is empty");
        }
        int count = params.get("count").getAsInt();
        if (count > stack.getCount()) {
            return ActionOutcome.failure("invalid_params", "count exceeds the current stack");
        }
        JsonObject before = ServerSnapshotService.evidence(agent);
        ItemStack dropped = stack.copyWithCount(count);
        ItemEntity entity = new ItemEntity(level, agent.getX(), agent.getEyeY(), agent.getZ(), dropped);
        entity.setPickUpDelay(10);
        Vec3 forward = agent.getLookAngle(); entity.setDeltaMovement(forward.x * 0.25, 0.15, forward.z * 0.25);
        if (!level.addFreshEntity(entity)) return ActionOutcome.failure("action_rejected", "item spawn rejected; inventory unchanged");
        stack.shrink(count); agent.deferOwnPickup(entity.getUUID()); agent.refreshHands();
        JsonObject after = ServerSnapshotService.evidence(agent);
        String effect = ServerSnapshotService.countsChanged(before, after) ? "confirmed" : "unverified";
        JsonObject evidence = ServerSnapshotService.merge(before, after);
        evidence.addProperty("spawned", true); evidence.addProperty("item_id", AgentEntity.itemId(dropped));
        evidence.addProperty("count", count); evidence.addProperty("entity_uuid", entity.getUUID().toString());
        return ActionOutcome.done(true, effect, null, null, "dropped " + count, evidence);
    }

    private static ActionOutcome useItem(AgentEntity agent, Pending job) {
        JsonObject params = job.params;
        String hand = params.get("hand").getAsString();
        if (params.has("item_id") && "main_hand".equals(hand)) {
            try {
                agent.selectSlot(hotbarSlot(agent, params));
            } catch (ActionRejection rejection) {
                return rejection.outcome;
            }
        } else if (params.has("item_id") && !params.get("item_id").getAsString().equals(AgentEntity.itemId(agent.handStack("off_hand")))) {
            return ActionOutcome.failure("item_not_found", "off hand does not contain the requested item");
        }
        ItemStack stack = agent.handStack(hand);
        if (stack.isEmpty()) {
            return ActionOutcome.failure("item_not_found", "hand is empty");
        }
        JsonObject before = ServerSnapshotService.evidence(agent);
        agent.armMainHand();
        InteractionHand interaction = agent.interactionHand(hand);
        agent.startUsingItem(interaction);
        if ("until_finished".equals(params.get("mode").getAsString()) && agent.isUsingItem()) {
            job.using = true;
            job.evidence = ServerSnapshotService.merge(before, before);
            job.evidence.addProperty("mode", "until_finished");
            return ActionOutcome.pending("using", job.evidence);
        }
        if (agent.isUsingItem()) {
            agent.stopUsingItem();
        }
        agent.disarmMainHand();
        JsonObject after = ServerSnapshotService.evidence(agent);
        boolean changed = ServerSnapshotService.countsChanged(before, after);
        return ActionOutcome.done(true, changed ? "confirmed" : "observed", null, null, "used item", ServerSnapshotService.merge(before, after));
    }

    private static ActionOutcome finishUse(AgentEntity agent, JsonObject beforeEvidence) {
        JsonObject after = ServerSnapshotService.evidence(agent);
        JsonObject before = new JsonObject();
        before.add("inventory", beforeEvidence.get("inventory_before"));
        before.add("main_hand", beforeEvidence.get("main_hand_before"));
        before.add("selected_slot", beforeEvidence.get("selected_slot_before"));
        boolean changed = ServerSnapshotService.countsChanged(before, after);
        return ActionOutcome.done(true, changed ? "confirmed" : "observed", null, null, "used item", ServerSnapshotService.merge(before, after));
    }

    private static ActionOutcome beginMine(AgentEntity agent, Pending job) {
        if (agent.handLocked()) return ActionOutcome.failure("busy", "hand transaction in progress");
        BlockPos pos = blockPos(job.params);
        ActionOutcome gate = gateBlock(agent, job.params, pos);
        if (gate != null) {
            return gate;
        }
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        BlockState state = level.getBlockState(pos);
        if (state.isAir()) return ActionOutcome.failure("state_mismatch", "target is already air");
        float hardness = state.getDestroySpeed(level, pos);
        if (hardness < 0.0F) {
            return ActionOutcome.failure("unsupported", "block cannot be destroyed");
        }
        int slot = ResourceActions.bestTool(agent.inventory(), state);
        if (slot < 0) return ActionOutcome.failure("missing_tool", "no suitable harvesting tool in inventory; block was not changed");
        agent.equipInventorySlot(slot);
        var player = ResourceActions.player(agent);
        if (!state.canHarvestBlock(level, pos, player)) return ActionOutcome.failure("missing_tool", "held tool cannot harvest this block; block was not changed");
        agent.lookAtPoint(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        agent.armMainHand();
        agent.swing(InteractionHand.MAIN_HAND);
        job.mining = true;
        job.minePos = pos;
        job.mineState = state;
        job.mineProgress = 0.0F;
        return null;
    }

    private void advanceMine(AgentEntity agent, Pending job, long now) {
        if (!(agent.level() instanceof ServerLevel level) || job.minePos == null) {
            agent.disarmMainHand();
            finish(job, ActionOutcome.failure("client_not_ready", "server npc is not spawned"));
            return;
        }
        if (now >= job.deadlineMs) {
            agent.disarmMainHand();
            level.destroyBlockProgress(agent.getId(), job.minePos, -1);
            finish(job, ActionOutcome.failure("timeout", "mining timed out"));
            return;
        }
        if (!WorldQueries.chunkLoaded(level, job.minePos)) {
            agent.disarmMainHand();
            finish(job, ActionOutcome.failure("block_unloaded", "target chunk is not loaded"));
            return;
        }
        BlockState state = level.getBlockState(job.minePos);
        if (!state.equals(job.mineState)) {
            agent.disarmMainHand();
            level.destroyBlockProgress(agent.getId(), job.minePos, -1);
            finish(job, ActionOutcome.failure("state_mismatch", "target changed during mining; acquisition not confirmed"));
            return;
        }
        ActionOutcome gate = gateBlock(agent, job.params, job.minePos);
        if (gate != null) { agent.disarmMainHand(); level.destroyBlockProgress(agent.getId(), job.minePos, -1); finish(job, gate); return; }
        if (agent.tickCount % 4 == 0) {
            agent.swing(InteractionHand.MAIN_HAND);
        }
        var player = ResourceActions.player(agent);
        if (!state.canHarvestBlock(level, job.minePos, player)) {
            agent.disarmMainHand(); level.destroyBlockProgress(agent.getId(), job.minePos, -1);
            finish(job, ActionOutcome.failure("missing_tool", "tool no longer permits harvesting")); return;
        }
        job.mineProgress += state.getDestroyProgress(player, level, job.minePos);
        level.destroyBlockProgress(agent.getId(), job.minePos, Math.min(9, (int)(job.mineProgress * 10)));
        if (job.mineProgress < 1.0F) {
            return;
        }
        boolean destroyed;
        try { destroyed = player.gameMode.destroyBlock(job.minePos); }
        finally { ResourceActions.commitInventory(agent, player); agent.disarmMainHand(); level.destroyBlockProgress(agent.getId(), job.minePos, -1); }
        JsonObject evidence = new JsonObject();
        evidence.addProperty("block_id", net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        evidence.addProperty("destroyed", destroyed && !level.getBlockState(job.minePos).equals(state));
        evidence.addProperty("acquired", false);
        evidence.addProperty("acquisition_status", "check_inventory_and_pickup_events; destruction alone is not acquisition");
        evidence.add("pos", posJson(job.minePos));
        evidence.add("inventory_after", ServerSnapshotService.inventory(agent));
        finish(job, evidence.get("destroyed").getAsBoolean() ? ActionOutcome.done(true, "confirmed", null, null, "block destroyed; drops not yet collected", evidence) : ActionOutcome.failure("action_rejected", "block break was denied or unchanged", evidence));
    }

    /** 带前提的拆除：目标位置的方块必须与 expected_block 一致，否则不改世界。其余沿用 attack_block 的挖掘流程。 */
    private static ActionOutcome breakBlock(AgentEntity agent, Pending job) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        BlockPos pos = blockPos(job.params);
        if (!WorldQueries.chunkLoaded(level, pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        String expected = job.params.get("expected_block").getAsString();
        String actual = blockId(level.getBlockState(pos));
        if (!expected.equals(actual)) {
            JsonObject evidence = new JsonObject();
            evidence.add("pos", posJson(pos));
            evidence.addProperty("expected_block", expected);
            evidence.addProperty("actual_block", actual);
            return ActionOutcome.failure("state_mismatch", "block at the target does not match expected_block", evidence);
        }
        return beginMine(agent, job);
    }

    private static final AtomicLong PROBE_SEQ = new AtomicLong();

    private static void stampWorld(ServerLevel level, JsonObject evidence) {
        evidence.addProperty("dimension", level.dimension().location().toString());
        evidence.addProperty("game_time", level.getGameTime());
    }

    /**
     * Read one to sixteen cells. Air is returned as minecraft:air. An unloaded chunk is loaded=false, not air.
     */
    private static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static JsonObject posJson(BlockPos pos) {
        JsonObject out = new JsonObject();
        out.addProperty("x", pos.getX());
        out.addProperty("y", pos.getY());
        out.addProperty("z", pos.getZ());
        return out;
    }

    private static JsonObject stateJson(BlockState state) {
        JsonObject out = new JsonObject();
        for (Property<?> property : state.getProperties()) {
            out.addProperty(property.getName(), stateValueName(state, property));
        }
        return out;
    }

    private static <T extends Comparable<T>> String stateValueName(BlockState state, Property<T> property) {
        return property.getName(state.getValue(property));
    }

    private static ActionOutcome probeBlocks(AgentEntity agent, JsonObject params) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        JsonArray positions = params.getAsJsonArray("positions");
        JsonArray cells = new JsonArray();
        for (JsonElement element : positions) {
            JsonObject pos = element.getAsJsonObject();
            BlockPos blockPos = new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
            JsonObject cell = new JsonObject();
            cell.add("pos", posJson(blockPos));
            boolean loaded = WorldQueries.chunkLoaded(level, blockPos);
            cell.addProperty("loaded", loaded);
            if (!loaded) {
                cell.add("block_id", JsonNull.INSTANCE);
                cell.add("state", new JsonObject());
            } else {
                BlockState state = level.getBlockState(blockPos);
                cell.addProperty("block_id", blockId(state));
                cell.add("state", stateJson(state));
            }
            cells.add(cell);
        }
        JsonObject evidence = new JsonObject();
        stampWorld(level, evidence);
        evidence.addProperty("probe_seq", PROBE_SEQ.incrementAndGet());
        evidence.add("cells", cells);
        return ActionOutcome.done(true, "observed", null, null, "probed blocks", evidence);
    }

    private static ActionOutcome attackEntity(AgentEntity agent, JsonObject params) {
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        LivingEntity target;
        if (params.has("uuid")) {
            Entity entity;
            try {
                entity = level.getEntity(UUID.fromString(params.get("uuid").getAsString()));
            } catch (IllegalArgumentException e) {
                return ActionOutcome.failure("invalid_params", "uuid is invalid");
            }
            if (!(entity instanceof LivingEntity living) || !living.isAlive()) {
                return ActionOutcome.failure("out_of_reach", "target entity is not loaded");
            }
            target = living;
        } else {
            target = nearestHostile(agent);
            if (target == null) {
                return ActionOutcome.failure("out_of_reach", "no attackable entity within reach");
            }
        }
        if (agent.distanceTo(target) > ATTACK_REACH) {
            return ActionOutcome.failure("out_of_reach", "target is out of melee reach");
        }
        agent.lookAtPoint(target.getX(), target.getEyeY(), target.getZ());
        agent.armMainHand();
        agent.swing(InteractionHand.MAIN_HAND);
        boolean hurt = agent.doHurtTarget(target);
        agent.disarmMainHand();
        JsonObject evidence = new JsonObject();
        evidence.addProperty("uuid", target.getUUID().toString());
        evidence.addProperty("name", target.getName().getString());
        evidence.addProperty("distance", agent.distanceTo(target));
        evidence.addProperty("hurt", hurt);
        return ActionOutcome.done(true, hurt ? "confirmed" : "observed", null, null, "attacked entity", evidence);
    }

    private static LivingEntity nearestHostile(AgentEntity agent) {
        AABB box = agent.getBoundingBox().inflate(ATTACK_REACH);
        return agent.level().getEntitiesOfClass(LivingEntity.class, box, entity ->
                        entity != agent && entity.isAlive() && !(entity instanceof Player) && agent.distanceTo(entity) <= ATTACK_REACH)
                .stream()
                .min(Comparator.comparingDouble(agent::distanceTo))
                .orElse(null);
    }

    private static ActionOutcome findItem(AgentEntity agent, JsonObject params) {
        String itemId = params.get("item_id").getAsString();
        int radius = params.has("radius") ? params.get("radius").getAsInt() : defaultRadius();
        return ContainerSearch.search(agent.level(), agent.position(), itemId, radius, "server");
    }

    private static ActionOutcome interact(AgentEntity agent, String action, JsonObject params) {
        BlockPos pos = blockPos(params);
        ActionOutcome gate = gateBlock(agent, params, pos);
        if (gate != null) {
            return gate;
        }
        if (!(agent.level() instanceof ServerLevel level)) {
            return ActionOutcome.failure("client_not_ready", "server npc is not spawned");
        }
        if (params.has("item_id")) {
            try {
                agent.selectSlot(hotbarSlot(agent, params));
            } catch (ActionRejection rejection) {
                return rejection.outcome;
            }
        }
        boolean sneaking = params.has("sneaking") && params.get("sneaking").getAsBoolean();
        agent.setShiftKeyDown(sneaking);
        try {
            AgentActionContext context = new AgentActionContext(level, agent, action, params, pos);
            AgentInteractionAdapter adapter = AgentAdapterRegistry.resolve(context);
            if (adapter == null) {
                return ActionOutcome.unsupportedAdapter(context.action, context.blockId(), "no adapter can handle this block");
            }
            agent.lookAtPoint(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
            agent.armMainHand();
            try {
                return adapter.execute(context);
            } finally {
                agent.disarmMainHand();
            }
        } finally {
            agent.setShiftKeyDown(false);
        }
    }

    private static ActionOutcome gateBlock(AgentEntity agent, JsonObject params, BlockPos pos) {
        if (!WorldQueries.chunkLoaded(agent.level(), pos)) {
            return ActionOutcome.failure("block_unloaded", "target chunk is not loaded");
        }
        double maxDistance = params.has("max_distance") ? params.get("max_distance").getAsDouble() : 4.5;
        Vec3 hit = hitVec(pos, params);
        if (agent.getEyePosition().distanceTo(hit) > maxDistance) {
            return ActionOutcome.failure("out_of_reach", "target is out of reach");
        }
        if (!InteractionRay.canSee(agent, pos, hit)) {
            return ActionOutcome.failure("line_of_sight_blocked", "line of sight is blocked");
        }
        return null;
    }

    private static Vec3 hitVec(BlockPos pos, JsonObject params) {
        JsonObject offset = params.getAsJsonObject("hit_offset");
        if (offset == null) {
            double[] center = FacePoints.center(params.has("face") ? params.get("face").getAsString() : "up");
            return new Vec3(pos.getX() + center[0], pos.getY() + center[1], pos.getZ() + center[2]);
        }
        return new Vec3(
                pos.getX() + offset.get("x").getAsDouble(),
                pos.getY() + offset.get("y").getAsDouble(),
                pos.getZ() + offset.get("z").getAsDouble()
        );
    }

    private static BlockPos blockPos(JsonObject params) {
        JsonObject pos = params.getAsJsonObject("pos");
        return new BlockPos(pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt());
    }

    private static int hotbarSlot(AgentEntity agent, JsonObject params) throws ActionRejection {
        boolean hasSlot = params.has("slot");
        boolean hasItem = params.has("item_id");
        String itemId = hasItem ? params.get("item_id").getAsString() : null;
        if (hasSlot) {
            int slot = params.get("slot").getAsInt();
            ItemStack stack = agent.inventory().getItem(slot);
            if (hasItem && (stack.isEmpty() || !itemId.equals(AgentEntity.itemId(stack)))) {
                throw new ActionRejection(ActionOutcome.failure("invalid_params", "item_id and slot do not match"));
            }
            return slot;
        }
        int found = agent.findHotbar(itemId);
        if (found >= 0) {
            return found;
        }
        if (agent.itemOutsideHotbar(itemId)) {
            throw new ActionRejection(ActionOutcome.failure("unsupported", "item is outside the hotbar"));
        }
        throw new ActionRejection(ActionOutcome.failure("item_not_found", "item is not in the hotbar"));
    }

    private static MovementSession activeMovementSession(Pending job) {
        if (job.moving && job.movementSession != null) {
            return job.movementSession;
        }
        if (job.placing && job.placementRun != null && job.placementRun.movement != null) {
            return job.placementRun.movement;
        }
        return null;
    }

    private static void stopMotion(AgentEntity agent, Pending job) {
        if (agent == null) {
            return;
        }
        if (job.moving) {
            if (job.movementSession != null) {
                MovementService.requestStop(agent, job.movementSession);
            }
            agent.getNavigation().stop();
        }
        if (job.placing && job.placementRun != null && job.placementRun.movement != null) {
            MovementService.requestStop(agent, job.placementRun.movement);
            agent.getNavigation().stop();
        }
        if (job.using && agent.isUsingItem()) {
            agent.stopUsingItem();
        }
        if (job.mining || job.using) {
            agent.disarmMainHand();
            if (job.mining && job.minePos != null && agent.level() instanceof ServerLevel level) level.destroyBlockProgress(agent.getId(), job.minePos, -1);
        }
    }

    private static boolean longAction(String action, JsonObject params) {
        if ("move_to".equals(action) || "attack_block".equals(action) || "break_block".equals(action)) {
            return true;
        }
        if ("place_block".equals(action) && PlacementService.autoMove(params)) {
            return true;
        }
        return "use_item".equals(action) && params.has("mode") && "until_finished".equals(params.get("mode").getAsString());
    }

    private static int defaultRadius() {
        try {
            return CommonBridgeConfig.scanRadius();
        } catch (RuntimeException e) {
            return 8;
        }
    }

    /**
     * 活着的 NPC 还有移动会话且 {@link MovementService#stopComplete} 未确认时，只请求停止。
     * 不回执，也不从 pending 或账本摘掉。没有活体或没有移动会话时直接释放。
     * retainRequest 为真时保留 request_id 指纹（失败/断连）；取消仍按 finish 清掉指纹。
     */
    private void holdOrRelease(AgentEntity agent, Pending job, ActionOutcome outcome, boolean retainRequest) {
        if (pending.get(key(job.agentId, job.requestId)) != job) {
            if (!replacementOwnsMotion(job)) {
                stopMotion(agent, job);
            }
            return;
        }
        stopMotion(agent, job);
        if (stopUnconfirmed(agent, job)) {
            job.cancel = true;
            if (job.terminalOutcome == null) {
                job.terminalOutcome = outcome;
                job.retainRequest = retainRequest;
            }
            return;
        }
        boolean retain = job.terminalOutcome != null ? job.retainRequest : retainRequest;
        ActionOutcome terminal = job.terminalOutcome != null ? job.terminalOutcome : outcome;
        release(job, terminal, !retain);
    }

    private boolean replacementOwnsMotion(Pending job) {
        for (Pending other : pending.values()) {
            if (other != job && job.agentId.equals(other.agentId) && (other.moving || other.placing || other.mining || other.using)) {
                return true;
            }
        }
        return false;
    }

    private static boolean stopUnconfirmed(AgentEntity agent, Pending job) {
        if (agent == null || !agent.isAlive()) {
            return false;
        }
        MovementSession session = activeMovementSession(job);
        return session != null && !MovementService.stopComplete(agent, session);
    }

    private void finish(Pending job, ActionOutcome outcome) {
        release(job, outcome, true);
    }

    private void release(Pending job, ActionOutcome outcome, boolean clearRequest) {
        String payloadKey = key(job.agentId, job.requestId);
        if (!pending.remove(payloadKey, job)) {
            return;
        }
        if (clearRequest) {
            requestPayloads.remove(payloadKey);
        }
        if (!ledger.complete(job.agentId, job.requestId, job.generation)) {
            return;
        }
        MinaretDiagnostics.transition(job.agentId, job.generation, job.requestId, "released",
                clearRequest ? "pending_and_ledger clear_request" : "pending_and_ledger retain_request");
        if (job.claim != null) {
            outcome.evidence.add("claim", job.claim);
        }
        reply(job.agentId, job.generation, job.requestId, job.action, outcome);
    }

    private void reply(String agentId, long generation, String requestId, String action, ActionOutcome outcome) {
        if (replies == null || agentId == null || generation <= 0) {
            return;
        }
        MinaretDiagnostics.transition(agentId, generation, requestId, "send_attempt",
                "action=" + action + " ok=" + outcome.ok + " effect=" + outcome.effect + " error_code=" + outcome.errorCode);
        replies.send(agentId, generation, ProtocolCodec.actionResult(
                ProtocolCodec.AGENT_PROTOCOL_VERSION,
                requestId,
                replies.nextSequence(),
                outcome.ok,
                action,
                outcome.effect,
                outcome.error,
                outcome.errorCode,
                outcome.sent,
                outcome.evidence
        ));
    }

    private void ensureLimiter() {
        int want = 10;
        try {
            want = CommonBridgeConfig.maxActionsPerSecond();
        } catch (RuntimeException ignored) {
            want = 10;
        }
        ledger.setPerSecond(want);
    }

    private static String key(String agentId, String requestId) {
        return agentId + "\n" + requestId;
    }

    private static String text(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static final class ActionRejection extends Exception {
        private final ActionOutcome outcome;

        private ActionRejection(ActionOutcome outcome) {
            this.outcome = outcome;
        }
    }

    private static final class CancelledAction extends RuntimeException {
    }

    private static String paramsFingerprint(JsonObject params) {
        return params == null ? "{}" : params.toString();
    }

    private static final class Pending {
        private final String agentId;
        private final long generation;
        private final String requestId;
        private final String action;
        private final JsonObject params;
        private final long deadlineMs;
        private boolean started;
        private boolean using;
        private boolean moving;
        private boolean placing;
        private boolean mining;
        private boolean cancel;
        private boolean retainRequest;
        private ActionOutcome terminalOutcome;
        private MovementSession movementSession;
        private PlacementService.Run placementRun;
        private float mineProgress;
        private BlockPos minePos;
        private BlockState mineState;
        private JsonObject evidence;
        private JsonObject claim;

        private Pending(String agentId, long generation, String requestId, String action, JsonObject params, long deadlineMs) {
            this.agentId = agentId;
            this.generation = generation;
            this.requestId = requestId;
            this.action = action;
            this.params = params;
            this.deadlineMs = deadlineMs;
        }
    }
}
