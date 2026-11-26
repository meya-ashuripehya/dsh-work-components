package com.trix.gamebot.bridge.server;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.MinaretMod;
import com.trix.gamebot.bridge.action.ClaimGate;
import com.trix.gamebot.bridge.action.ServerActionDispatcher;
import com.trix.gamebot.bridge.command.AgentCommands;
import com.trix.gamebot.bridge.compat.AgentAdapterRegistry;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.entity.AgentRegistry;
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.trix.gamebot.bridge.observation.SemanticPerception;
import com.trix.gamebot.bridge.protocol.AgentMessages;
import com.trix.gamebot.bridge.protocol.ChatSpeech;
import com.trix.gamebot.bridge.protocol.PlayerPrivateChat;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.transport.AgentBridgeServer;
import com.trix.gamebot.bridge.transport.AgentConnections;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import org.java_websocket.WebSocket;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 服务端 NPC 桥。每个已绑定的成员各自扫描、快照和断线清理。 */
@EventBusSubscriber(modid = MinaretMod.MOD_ID)
public final class ServerLifecycle implements AgentBridgeServer.Listener {
    private static final Logger LOGGER = LoggerFactory.getLogger(ServerLifecycle.class);
    private static final ServerLifecycle INSTANCE = new ServerLifecycle();
    private static final ServerActionDispatcher DISPATCHER = new ServerActionDispatcher();

    private static AgentBridgeServer socket;
    private static MinecraftServer minecraftServer;
    private static boolean startFailed;
    private static final Map<String, Scan> scans = new HashMap<>();

    private ServerLifecycle() {
    }

    @SubscribeEvent
    public static void onStarted(ServerStartedEvent event) {
        DISPATCHER.clearTasks();
        minecraftServer = event.getServer();
        AgentAdapterRegistry.bootstrap();
        startFailed = false;
        if (legacyClientBridge()) {
            LOGGER.info("Legacy client bridge is enabled; the server NPC bridge stays off");
            return;
        }
        INSTANCE.ensureSocket();
    }

    @SubscribeEvent
    public static void onStopping(ServerStoppingEvent event) {
        DISPATCHER.failAll(minecraftServer, "client_not_ready", "server is stopping");
        if (socket != null) {
            try {
                socket.stop(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            socket = null;
        }
        scans.clear();
        minecraftServer = null;
    }

    @SubscribeEvent
    public static void onTick(ServerTickEvent.Post event) {
        INSTANCE.tick(event.getServer());
    }

    @SubscribeEvent
    public static void onChat(ServerChatEvent event) {
        if (socket == null || socket.connections().bound().isEmpty()) {
            return;
        }
        JsonObject data = new JsonObject();
        long sequence = socket.nextSequence();
        data.addProperty("player", event.getUsername());
        data.addProperty("username", event.getUsername());
        data.addProperty("message", event.getRawText());
        data.addProperty("source", "player");
        data.addProperty("audience", "public");
        data.addProperty("message_id", "player:" + sequence + ":" + UUID.randomUUID());
        socket.broadcast(ProtocolCodec.envelope(ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat", data, sequence, null));
    }

    public static void refreshHello(String agentId) {
        INSTANCE.sendHello(agentId);
    }

    public static boolean eligible(String agentId) {
        return socket != null && socket.connections().bindingOfAgent(agentId) != null;
    }

    public static String tell(ServerPlayer sender, String agentId, String message) {
        if (socket == null || minecraftServer == null || AgentCommands.find(minecraftServer, agentId) == null) {
            return "目标席位未加入游戏或尚未连接工作台";
        }
        return PlayerPrivateChat.deliver(socket, sender.getGameProfile().getName(), agentId, message);
    }

    public static void forget(String agentId) {
        scans.remove(agentId);
        if (socket == null || minecraftServer == null) {
            return;
        }
        AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
        if (binding == null) {
            return;
        }
        DISPATCHER.failAgent(minecraftServer, agentId, binding.generation, "client_not_ready", "server npc was removed");
        INSTANCE.sendHello(agentId);
    }

    private void tick(MinecraftServer server) {
        minecraftServer = server;
        if (legacyClientBridge()) {
            return;
        }
        ensureSocket();
        DISPATCHER.tick(server);
        if (socket == null) {
            return;
        }
        for (AgentConnections.Binding binding : socket.connections().bound()) {
            AgentEntity agent = AgentCommands.find(server, binding.agentId);
            if (agent == null) {
                continue;
            }
            Scan scan = scans.computeIfAbsent(binding.agentId, ignored -> new Scan());
            // A saved NPC can become available after the initial registration
            // hello. Announce actual capabilities once per live connection before
            // its first snapshot, instead of leaving it permanently wait-only.
            if (scan.helloGeneration != binding.generation) {
                sendHello(binding.agentId);
                scan.helloGeneration = binding.generation;
            }
            scan.tick++;
            com.trix.gamebot.bridge.action.ResourceActions.pickupNearby(agent);
            if (!scan.scanned || scan.tick % 10 == 0 || !agent.blockPosition().equals(scan.lastScanPos)) {
                ServerSnapshotService.NearbyScan nearby = ServerSnapshotService.scanNearby(agent, scanRadius());
                scan.cachedBlocks = nearby.blocks;
                scan.semantic = SemanticPerception.scan(agent,nearby.source,DISPATCHER.taskInterest(binding.agentId));
                scan.cachedGoals = ServerSnapshotService.standableGoals(agent, nearby.blocks);
                JsonArray visibleGoals=new JsonArray();
                for(var g:scan.cachedGoals) {var p=g.getAsJsonObject().getAsJsonObject("position");
                    BlockPos support=BlockPos.containing(p.get("x").getAsDouble(),p.get("y").getAsDouble()-0.05,p.get("z").getAsDouble());
                    if(SemanticPerception.visible(agent,support))visibleGoals.add(g);
                } scan.cachedGoals=visibleGoals;
                SemanticPerception.addDirections(scan.semantic,visibleGoals,agent.position());
                scan.blocksTruncated = nearby.truncated;
                scan.lastScanPos = agent.blockPosition();
                scan.scanned = true;
            }
            if (scan.tick % 5 == 0) {
                sendSnapshot(binding.agentId, agent);
            }
        }
    }

    private void sendSnapshot(String agentId, AgentEntity agent) {
        AgentConnections.Binding binding = socket == null ? null : socket.connections().bindingOfAgent(agentId);
        if (binding == null || agent == null) {
            return;
        }
        Scan scan = scans.computeIfAbsent(agentId, ignored -> new Scan());
        JsonObject data = new JsonObject();
        data.addProperty("actor_type", "server_npc");
        data.addProperty("agent_id", agentId);
        data.addProperty("entity_uuid", agent.getUUID().toString());
        data.addProperty("world_id", AgentRegistry.get(minecraftServer).worldId());
        data.addProperty("game_time", agent.level().getGameTime());
        data.add("player", ServerSnapshotService.player(agent));
        data.add("nearby_players", ServerSnapshotService.nearbyPlayers(agent));
        JsonArray peers = new JsonArray();
        for (var record : AgentRegistry.get(minecraftServer).table().records()) {
            AgentEntity other = AgentCommands.find(minecraftServer, record.agentKey());
            if (other == null || other == agent || other.level() != agent.level() || agent.distanceTo(other) > 64) continue;
            JsonObject peer = new JsonObject();
            peer.addProperty("agent_id", record.agentKey());
            peer.addProperty("name", other.agentName());
            peer.add("position", ServerSnapshotService.player(other).get("position"));
            peers.add(peer);
        }
        data.add("nearby_agents", peers);
        data.add("nearby_blocks", scan.cachedBlocks == null ? new JsonArray() : scan.cachedBlocks);
        data.add("standable_goals", scan.cachedGoals == null ? new JsonArray() : scan.cachedGoals);
        data.add("terrain_summary",scan.semantic.has("terrain_summary")?scan.semantic.get("terrain_summary"):new JsonObject());
        data.add("points_of_interest",scan.semantic.has("points_of_interest")?scan.semantic.get("points_of_interest"):new JsonArray());
        data.add("task",DISPATCHER.taskView(agentId));
        data.addProperty("nearby_blocks_truncated", scan.blocksTruncated);
        data.add("inventory", ServerSnapshotService.inventory(agent));
        data.add("nearby_items", com.trix.gamebot.bridge.action.ResourceActions.nearbyItems(agent, scanRadius()));
        data.add("recent_pickups", agent.recentPickups());
        data.add("screen", ServerSnapshotService.closedScreen());
        socket.send(agentId, binding.generation, ProtocolCodec.envelope(
                ProtocolCodec.AGENT_PROTOCOL_VERSION, "snapshot", data, socket.nextSequence(), null));
    }

    private void sendHello(String agentId) {
        if (socket == null || agentId == null) {
            return;
        }
        AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
        if (binding == null) {
            return;
        }
        AgentEntity agent = minecraftServer == null ? null : AgentCommands.find(minecraftServer, agentId);
        boolean ready = agent != null && agent.level() != null;
        JsonObject data = new JsonObject();
        data.addProperty("version", SharedConstants.getCurrentVersion().getName());
        data.addProperty("loader", "neoforge");
        data.addProperty("loader_version", loaderVersion());
        data.addProperty("protocol_version", ProtocolCodec.AGENT_PROTOCOL_VERSION);
        data.add("capabilities", capabilities(ready));
        data.add("mods", modIds());
        data.addProperty("username", ready ? agent.agentName() : "");
        data.addProperty("world_ready", ready);
        data.addProperty("world_id", AgentRegistry.get(minecraftServer).worldId());
        data.addProperty("actor_type", "server_npc");
        data.addProperty("agent_id", agentId);
        data.add("entity_uuid", ready ? new com.google.gson.JsonPrimitive(agent.getUUID().toString()) : JsonNull.INSTANCE);
        socket.send(agentId, binding.generation, ProtocolCodec.envelope(
                ProtocolCodec.AGENT_PROTOCOL_VERSION, "hello", data, socket.nextSequence(), null));
    }

    private void ensureSocket() {
        if (socket != null || startFailed || minecraftServer == null || !enabled()) {
            return;
        }
        try {
            socket = new AgentBridgeServer(port(), this, authUser(), authPass());
            socket.setDaemon(true);
            socket.start();
            DISPATCHER.bind(socket);
        } catch (Exception e) {
            startFailed = true;
            LOGGER.warn("Minaret agent bridge did not start: {}", e.toString());
        }
    }

    @Override
    public void onInbound(WebSocket conn, JsonObject message) {
        onServer(() -> handleInbound(conn, message));
    }

    @Override
    public void onAgentClosed(String agentId, long generation) {
        ClaimGate.forget(agentId, generation);
        onServer(() -> {
            if (minecraftServer != null) {
                DISPATCHER.failAgent(minecraftServer, agentId, generation, "not_connected", "controller disconnected");
            }
        });
    }

    private void handleInbound(WebSocket conn, JsonObject payload) {
        if (socket == null || minecraftServer == null) {
            return;
        }
        AgentConnections.Channel channel = socket.channel(conn);
        AgentConnections.Binding bound = channel == null ? null : socket.connections().bindingOf(channel);
        AgentMessages.Verdict verdict = AgentMessages.inspect(payload, bound == null ? null : bound.agentId);
        if (!verdict.ok()) {
            socket.sendDirect(conn, ProtocolCodec.errorEvent(ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), verdict.code, verdict.message));
            if (verdict.close) {
                conn.close(1008, verdict.code);
            }
            return;
        }
        switch (verdict.event) {
            case "hello" -> handleHello(conn, channel, payload);
            case "action_request" -> DISPATCHER.accept(minecraftServer, bound.agentId, bound.generation, payload);
            case "cancel_action" -> DISPATCHER.cancel(minecraftServer, bound.agentId, bound.generation, payload);
            case "claim_revoke" -> handleRevoke(bound.agentId, bound.generation, payload);
            case "chat" -> handleChat(bound.agentId, payload);
            case "command" -> handleCommand(bound.agentId, payload);
            default -> socket.sendDirect(conn, ProtocolCodec.errorEvent(
                    ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "unsupported", "event is not supported"));
        }
    }

    private void handleHello(WebSocket conn, AgentConnections.Channel channel, JsonObject payload) {
        if (channel == null) {
            socket.sendDirect(conn, ProtocolCodec.errorEvent(
                    ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "not_bound", "connection is not open"));
            conn.close(1008, "not_bound");
            return;
        }
        String agentId = AgentMessages.agentId(payload);
        JsonObject data = payload.has("data") && payload.get("data").isJsonObject() ? payload.getAsJsonObject("data") : new JsonObject();
        String displayName = text(data, "display_name");
        String error = AgentRegistry.get(minecraftServer).find(agentId) != null
                ? AgentCommands.ensure(minecraftServer, agentId, displayName == null ? agentId : displayName)
                : null;
        if (error != null) {
            String message = "agent_not_available".equals(error)
                    ? "server npc is not available for " + agentId
                    : "limit".equals(error) ? "too many agents" : "agent_id is not valid";
            String code = "limit".equals(error) || "invalid".equals(error) ? "action_rejected" : "agent_not_available";
            socket.sendDirect(conn, ProtocolCodec.errorEvent(ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), code, message));
            conn.close(1008, code);
            return;
        }
        AgentConnections.Binding previous = socket.connections().bind(channel, agentId);
        if (previous != null) {
            DISPATCHER.failAgent(minecraftServer, agentId, previous.generation, "not_connected", "connection replaced");
            previous.channel.close(4000, "replaced");
        }
        AgentConnections.Binding current = socket.connections().bindingOfAgent(agentId);
        if (current != null) {
            ClaimGate.remember(agentId, current.generation, claimKey(data));
        }
        sendHello(agentId);
    }

    private void handleRevoke(String agentId, long generation, JsonObject payload) {
        JsonObject data = payload.has("data") && payload.get("data").isJsonObject() ? payload.getAsJsonObject("data") : new JsonObject();
        String pid = text(data, "pid");
        String tid = text(data, "tid");
        String sig = text(data, "sig");
        int gen = 0;
        try {
            if (data.has("gen") && !data.get("gen").isJsonNull()) gen = data.get("gen").getAsInt();
        } catch (RuntimeException e) {
            gen = 0;
        }
        String error = ClaimGate.noteRevoke(agentId, generation, pid, tid, gen, sig);
        if (error != null) {
            socket.send(agentId, generation, ProtocolCodec.errorEvent(
                    ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "claim_invalid", error));
        }
    }

    private static byte[] claimKey(JsonObject data) {
        String raw = text(data, "claim_key");
        if (raw == null || raw.isBlank()) return null;
        try {
            byte[] key = java.util.Base64.getDecoder().decode(raw.trim());
            return key.length == 0 ? null : key;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private void handleChat(String agentId, JsonObject payload) {
        String sayId = text(payload, "say_id");
        if (sayId == null || sayId.isBlank()) {
            sayId = UUID.randomUUID().toString();
        }
        ChatSpeech.Result speech = ChatSpeech.prepare(
                text(payload, "message"),
                text(payload, "audience"),
                text(payload, "target"),
                text(payload, "emote"));
        if (!speech.ok) {
            replyChat(agentId, sayId, false, speech.errorCode, speech.error, null, "public", "");
            return;
        }
        AgentEntity agent = AgentCommands.find(minecraftServer, agentId);
        if (agent == null) {
            replyChat(agentId, sayId, false, "client_not_ready", "server npc is not spawned", null, speech.audience, speech.target);
            return;
        }
        String world = text(payload, "world_id");
        String dimension = text(payload, "dimension");
        if ((world != null && !world.equals(AgentRegistry.get(minecraftServer).worldId()))
                || (dimension != null && !dimension.equals(agent.level().dimension().location().toString()))) {
            replyChat(agentId, sayId, false, "action_rejected", "stale world or dimension", null, speech.audience, speech.target);
            return;
        }
        String line = ChatSpeech.line(agent.agentName(), speech);
        if ("private".equals(speech.audience)) {
            ServerPlayer target = minecraftServer.getPlayerList().getPlayerByName(speech.target);
            if (target == null) {
                replyChat(agentId, sayId, false, "target_offline", "target is offline", null, "private", speech.target);
                return;
            }
            target.sendSystemMessage(Component.literal(line), false);
            replyChat(agentId, sayId, true, null, null, line, "private", speech.target);
            return;
        }
        minecraftServer.getPlayerList().broadcastSystemMessage(Component.literal(line), false);
        JsonObject data = new JsonObject();
        data.addProperty("agent_id", agentId);
        data.addProperty("player", agent.agentName());
        data.addProperty("username", agent.agentName());
        data.addProperty("message", line);
        data.addProperty("source", "agent");
        data.addProperty("audience", "public");
        data.addProperty("say_id", sayId);
        data.addProperty("message_id", sayId);
        if (!speech.emote.isEmpty()) {
            data.addProperty("emote", speech.emote);
        }
        socket.broadcast(ProtocolCodec.envelope(ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat", data, socket.nextSequence(), null));
        replyChat(agentId, sayId, true, null, null, line, "public", "");
    }

    /** 只回给说话的这条连接。私聊失败不广播。 */
    private void replyChat(String agentId, String sayId, boolean ok, String errorCode, String error, String sent, String audience, String target) {
        if (socket == null) {
            return;
        }
        AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
        if (binding == null) {
            return;
        }
        JsonObject data = new JsonObject();
        data.addProperty("agent_id", agentId);
        data.addProperty("say_id", sayId);
        data.addProperty("message_id", sayId);
        data.addProperty("ok", ok);
        data.addProperty("audience", audience == null ? "public" : audience);
        if (target != null && !target.isEmpty()) {
            data.addProperty("target", target);
        }
        if (sent != null) {
            data.addProperty("sent", sent);
        }
        if (!ok) {
            data.addProperty("error_code", errorCode == null ? "invalid_params" : errorCode);
            data.addProperty("error", error == null ? "" : error);
        }
        socket.send(agentId, binding.generation, ProtocolCodec.envelope(
                ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat_result", data, socket.nextSequence(), null));
    }

    private void handleCommand(String agentId, JsonObject payload) {
        AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
        if (!allowCommands()) {
            if (binding != null) {
                socket.send(agentId, binding.generation, ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "unsupported", "commands are disabled"));
            }
            return;
        }
        String command = text(payload, "command");
        if (command == null || command.isBlank()) {
            if (binding != null) {
                socket.send(agentId, binding.generation, ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "invalid_params", "command is empty"));
            }
            return;
        }
        AgentEntity agent = AgentCommands.find(minecraftServer, agentId);
        if (agent == null) {
            if (binding != null) {
                socket.send(agentId, binding.generation, ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "client_not_ready", "server npc is not spawned"));
            }
            return;
        }
        String normalized = command.startsWith("/") ? command.substring(1) : command;
        minecraftServer.getCommands().performPrefixedCommand(agent.createCommandSourceStack().withPermission(2), normalized);
    }

    private static void onServer(Runnable task) {
        MinecraftServer server = minecraftServer;
        if (server == null) {
            return;
        }
        if (server.isSameThread()) {
            task.run();
        } else {
            server.execute(task);
        }
    }

    private static JsonArray capabilities(boolean worldReady) {
        JsonArray values = new JsonArray();
        if (!worldReady) {
            return values;
        }
        for (String name : List.of(
                "minecraft.chat.say",
                "minecraft.player.position.read",
                "minecraft.player.health.read",
                "minecraft.inventory.read",
                "minecraft.inventory.auto_pickup",
                "minecraft.world.harvest_with_tools",
                "minecraft.world.place_from_inventory", "minecraft.inventory.drop_safe",
                "minecraft.block.scan",
                "minecraft.entity.nearby",
                "minecraft.player.look_at",
                "minecraft.player.move_to",
                "minecraft.task.navigate_to", "minecraft.task.follow_entity", "minecraft.task.explore_area", "minecraft.task.stop_task", "minecraft.world.inspect_blocks",
                "minecraft.inventory.select",
                "minecraft.inventory.drop",
                "minecraft.item.use",
                "minecraft.world.use_item_on_block",
                "minecraft.world.attack_block",
                "minecraft.world.place_block",
                "minecraft.world.probe_blocks",
                "minecraft.world.break_block",
                "minecraft.entity.attack",
                "minecraft.world.interact",
                "minecraft.container.find_item"
        )) {
            values.add(name);
        }
        if (allowCommands()) {
            values.add("minecraft.server.command");
        }
        return values;
    }

    private static JsonArray modIds() {
        List<String> ids = new ArrayList<>();
        ModList.get().getMods().forEach(mod -> ids.add(mod.getModId()));
        ids.sort(String::compareTo);
        JsonArray values = new JsonArray();
        ids.forEach(values::add);
        return values;
    }

    private static String loaderVersion() {
        return ModList.get().getModContainerById("neoforge")
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("unknown");
    }

    private static boolean enabled() {
        try {
            return CommonBridgeConfig.enabled();
        } catch (IllegalStateException e) {
            return true;
        }
    }

    private static int port() {
        try {
            return CommonBridgeConfig.port();
        } catch (IllegalStateException e) {
            return 8765;
        }
    }

    private static String authUser() {
        try {
            return CommonBridgeConfig.authUser();
        } catch (IllegalStateException e) {
            return "";
        }
    }

    private static String authPass() {
        try {
            return CommonBridgeConfig.authPass();
        } catch (IllegalStateException e) {
            return "";
        }
    }

    private static boolean allowCommands() {
        try {
            return CommonBridgeConfig.allowCommands();
        } catch (IllegalStateException e) {
            return false;
        }
    }

    private static int scanRadius() {
        try {
            return CommonBridgeConfig.scanRadius();
        } catch (IllegalStateException e) {
            return 8;
        }
    }

    private static boolean legacyClientBridge() {
        try {
            return CommonBridgeConfig.legacyClientBridge();
        } catch (IllegalStateException e) {
            return false;
        }
    }

    private static String text(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static final class Scan {
        private long helloGeneration = -1;
        private int tick;
        private boolean scanned;
        private JsonArray cachedBlocks = new JsonArray();
        private JsonArray cachedGoals = new JsonArray();
        private JsonObject semantic = new JsonObject();
        private boolean blocksTruncated = true;
        private BlockPos lastScanPos = BlockPos.ZERO;
    }
}
