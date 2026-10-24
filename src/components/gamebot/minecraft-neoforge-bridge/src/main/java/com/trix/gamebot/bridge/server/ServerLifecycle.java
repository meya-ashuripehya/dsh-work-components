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
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.trix.gamebot.bridge.protocol.AgentMessages;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.transport.AgentBridgeServer;
import com.trix.gamebot.bridge.transport.AgentConnections;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
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
        data.addProperty("player", event.getUsername());
        data.addProperty("username", event.getUsername());
        data.addProperty("message", event.getRawText());
        data.addProperty("source", "player");
        socket.broadcast(ProtocolCodec.envelope(ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat", data, socket.nextSequence(), null));
    }

    public static void refreshHello(String agentId) {
        INSTANCE.sendHello(agentId);
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
        AgentConnections.Binding closed = socket.connections().close(binding.channel);
        binding.channel.close(1000, "removed");
        if (closed != null) {
            // close() 已经摘掉当前代际。套接字的 onClose 还会再走一次，那里看到的是过期连接。
        }
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
            scan.tick++;
            if (!scan.scanned || scan.tick % 10 == 0 || !agent.blockPosition().equals(scan.lastScanPos)) {
                ServerSnapshotService.NearbyScan nearby = ServerSnapshotService.scanNearby(agent, scanRadius());
                scan.cachedBlocks = nearby.blocks;
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
        data.add("player", ServerSnapshotService.player(agent));
        data.add("nearby_players", ServerSnapshotService.nearbyPlayers(agent));
        data.add("nearby_blocks", scan.cachedBlocks == null ? new JsonArray() : scan.cachedBlocks);
        data.addProperty("nearby_blocks_truncated", scan.blocksTruncated);
        data.add("inventory", ServerSnapshotService.inventory(agent));
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
        boolean provision = data.has("provision") && !data.get("provision").isJsonNull() && data.get("provision").getAsBoolean();
        String displayName = text(data, "display_name");
        String error = provision
                ? AgentCommands.ensure(minecraftServer, agentId, displayName == null ? agentId : displayName)
                : AgentCommands.requireReady(minecraftServer, agentId);
        if (error != null) {
            String message = "agent_not_available".equals(error)
                    ? "server npc is not available for " + agentId + "; remove the stale record before provisioning a new body"
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
        String message = text(payload, "message");
        if (message == null || message.isBlank()) {
            AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
            if (binding != null) {
                socket.send(agentId, binding.generation, ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "invalid_params", "message is empty"));
            }
            return;
        }
        AgentEntity agent = AgentCommands.find(minecraftServer, agentId);
        if (agent == null) {
            AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
            if (binding != null) {
                socket.send(agentId, binding.generation, ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION, socket.nextSequence(), "client_not_ready", "server npc is not spawned"));
            }
            return;
        }
        String clipped = message.length() > 256 ? message.substring(0, 256) : message;
        minecraftServer.getPlayerList().broadcastSystemMessage(Component.literal("<" + agent.agentName() + "> " + clipped), false);
        JsonObject data = new JsonObject();
        data.addProperty("agent_id", agentId);
        data.addProperty("player", agent.agentName());
        data.addProperty("username", agent.agentName());
        data.addProperty("message", clipped);
        data.addProperty("source", "agent");
        socket.broadcast(ProtocolCodec.envelope(ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat", data, socket.nextSequence(), null));
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
                "minecraft.block.scan",
                "minecraft.entity.nearby",
                "minecraft.player.look_at",
                "minecraft.player.move_to",
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
        private int tick;
        private boolean scanned;
        private JsonArray cachedBlocks = new JsonArray();
        private boolean blocksTruncated = true;
        private BlockPos lastScanPos = BlockPos.ZERO;
    }
}
