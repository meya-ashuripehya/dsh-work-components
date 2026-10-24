package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.config.BridgeConfig;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.protocol.ProtocolException;
import com.trix.gamebot.bridge.protocol.RateLimiter;
import com.trix.gamebot.bridge.protocol.Validators;
import com.trix.gamebot.bridge.transport.BridgeServer;
import net.minecraft.client.Minecraft;
import org.java_websocket.WebSocket;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** 校验、限流，并把动作切回客户端主线程。 */
public final class ActionDispatcher {
    private static final int MAX_PENDING = 32;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private RateLimiter limiter = new RateLimiter(10);
    private int limiterLimit = 10;
    private BridgeServer server;

    public void bind(BridgeServer server) {
        this.server = server;
    }

    public void accept(WebSocket conn, JsonObject message) {
        String requestId = text(message, "request_id");
        JsonObject data = message.has("data") && message.get("data").isJsonObject() ? message.get("data").getAsJsonObject() : new JsonObject();
        String action = text(data, "action");
        if (requestId == null || action == null) {
            reply(requestId, action, ActionOutcome.failure("invalid_params", "request_id and action are required"));
            return;
        }
        if (pending.containsKey(requestId)) {
            return;
        }
        JsonObject params;
        try {
            params = Validators.validateAction(action, data.has("params") && data.get("params").isJsonObject() ? data.get("params").getAsJsonObject() : new JsonObject());
        } catch (ProtocolException e) {
            reply(requestId, action, ActionOutcome.failure(e.code, e.getMessage()));
            return;
        }
        ensureLimiter();
        if (!limiter.tryAcquire(System.currentTimeMillis())) {
            reply(requestId, action, ActionOutcome.failure("rate_limited", "too many actions"));
            return;
        }
        if (pending.size() >= MAX_PENDING) {
            reply(requestId, action, ActionOutcome.failure("action_rejected", "too many pending actions"));
            return;
        }
        long timeoutMs = "use_item".equals(action) && params.has("mode") && "until_finished".equals(params.get("mode").getAsString()) ? 30_000L : 5_000L;
        Pending job = new Pending(requestId, action, params, System.currentTimeMillis() + timeoutMs);
        pending.put(requestId, job);
        Minecraft minecraft = Minecraft.getInstance();
        minecraft.execute(() -> run(job));
    }

    public void cancel(JsonObject message) {
        JsonObject data = message.has("data") && message.get("data").isJsonObject() ? message.get("data").getAsJsonObject() : message;
        String target = text(data, "target_request_id");
        if (target == null) {
            return;
        }
        Pending job = pending.get(target);
        if (job != null) {
            job.cancel = true;
        }
        Minecraft.getInstance().execute(this::tick);
    }

    public void tick() {
        long now = System.currentTimeMillis();
        Minecraft minecraft = Minecraft.getInstance();
        for (Pending job : pending.values()) {
            if (job.cancel) {
                if (job.using) {
                    InteractionActions.releaseUse(minecraft);
                }
                finish(job, ActionOutcome.failure("action_rejected", "action cancelled"));
                continue;
            }
            if (job.deferred) {
                if (now >= job.deadlineMs) {
                    finish(job, ActionOutcome.failure("timeout", "action timed out"));
                }
                continue;
            }
            if (job.using) {
                boolean stillUsing = minecraft.player != null && minecraft.player.isUsingItem();
                if (!stillUsing && minecraft.player != null && now < job.deadlineMs && job.evidence != null) {
                    finish(job, InteractionActions.finishUse(minecraft, job.evidence));
                    continue;
                }
                if (now >= job.deadlineMs || minecraft.player == null) {
                    if (stillUsing) {
                        InteractionActions.releaseUse(minecraft);
                    }
                    String code = minecraft.player == null ? "client_not_ready" : "timeout";
                    String message = minecraft.player == null ? "client left the world" : "action timed out";
                    finish(job, ActionOutcome.failure(code, message));
                }
                continue;
            }
            if (!job.started && now >= job.deadlineMs) {
                finish(job, ActionOutcome.failure("timeout", "action timed out"));
            }
        }
    }

    public void failAll(String code, String message) {
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.player != null && minecraft.player.isUsingItem()) {
            InteractionActions.releaseUse(minecraft);
        }
        for (Pending job : pending.values()) {
            finish(job, ActionOutcome.failure(code, message));
        }
    }

    private void run(Pending job) {
        if (job.cancel || !pending.containsKey(job.requestId)) {
            return;
        }
        job.started = true;
        try {
            ActionOutcome outcome = switch (job.action) {
                case "look_at" -> InteractionActions.lookAt(Minecraft.getInstance(), job.params);
                case "select_item" -> InventoryActions.select(Minecraft.getInstance(), job.params);
                case "drop_item" -> InventoryActions.drop(Minecraft.getInstance(), job.params);
                case "use_item" -> InteractionActions.useItem(Minecraft.getInstance(), job.params);
                case "attack_block" -> InteractionActions.attack(Minecraft.getInstance(), job.params);
                case "interact", "use_item_on_block" -> InteractionActions.useOnBlock(Minecraft.getInstance(), job.params);
                case "find_item" -> {
                    job.deferred = true;
                    ContainerSearch.start(Minecraft.getInstance(), job.params, found -> finish(job, found));
                    yield null;
                }
                default -> ActionOutcome.failure("unsupported", "action is not supported");
            };
            if (outcome == null || outcome.pending) {
                if (outcome != null) {
                    job.using = true;
                    job.evidence = outcome.evidence;
                }
                return;
            }
            finish(job, outcome);
        } catch (RuntimeException e) {
            finish(job, ActionOutcome.failure("internal_error", "action failed"));
        }
    }

    private void finish(Pending job, ActionOutcome outcome) {
        if (pending.remove(job.requestId) == null) {
            return;
        }
        reply(job.requestId, job.action, outcome);
    }

    private void reply(String requestId, String action, ActionOutcome outcome) {
        if (server == null) {
            return;
        }
        server.send(ProtocolCodec.actionResult(
                requestId,
                server.nextSequence(),
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
            want = BridgeConfig.maxActionsPerSecond();
        } catch (RuntimeException ignored) {
            want = 10;
        }
        if (want != limiterLimit) {
            limiterLimit = want;
            limiter = new RateLimiter(want);
        }
    }

    private static String text(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static final class Pending {
        private final String requestId;
        private final String action;
        private final JsonObject params;
        private final long deadlineMs;
        private volatile boolean started;
        private volatile boolean using;
        private volatile boolean cancel;
        private volatile boolean deferred;
        private JsonObject evidence;

        private Pending(String requestId, String action, JsonObject params, long deadlineMs) {
            this.requestId = requestId;
            this.action = action;
            this.params = params;
            this.deadlineMs = deadlineMs;
        }
    }
}
