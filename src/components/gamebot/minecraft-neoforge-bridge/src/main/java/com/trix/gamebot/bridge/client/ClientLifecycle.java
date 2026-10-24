package com.trix.gamebot.bridge.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.MinaretMod;
import com.trix.gamebot.bridge.action.ActionDispatcher;
import com.trix.gamebot.bridge.config.BridgeConfig;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.observation.ClientSnapshotService;
import com.trix.gamebot.bridge.observation.PlayerActivityObserver;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.transport.BridgeServer;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import org.java_websocket.WebSocket;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

/** 客户端生命周期：loopback 套接字、快照和主线程动作。 */
@EventBusSubscriber(modid = MinaretMod.MOD_ID, value = Dist.CLIENT)
public final class ClientLifecycle implements BridgeServer.Listener {
    private static final Logger LOGGER = LoggerFactory.getLogger(ClientLifecycle.class);
    private static final ClientLifecycle INSTANCE = new ClientLifecycle();
    private static final ActionDispatcher DISPATCHER = new ActionDispatcher();
    private static final PlayerActivityObserver ACTIVITY = new PlayerActivityObserver();

    private static BridgeServer server;
    private static boolean startFailed;
    private static boolean wasInWorld;
    private static boolean scanned;
    private static int tick;
    private static JsonArray cachedBlocks = new JsonArray();
    private static BlockPos lastScanPos = BlockPos.ZERO;

    private ClientLifecycle() {
    }

    @SubscribeEvent
    public static void onTick(ClientTickEvent.Post event) {
        INSTANCE.tick();
    }

    @SubscribeEvent
    public static void onLogout(ClientPlayerNetworkEvent.LoggingOut event) {
        ACTIVITY.reset();
        cachedBlocks = new JsonArray();
        scanned = false;
        wasInWorld = false;
        DISPATCHER.failAll("client_not_ready", "client left the world");
        INSTANCE.sendHello();
    }

    private void tick() {
        Minecraft minecraft = Minecraft.getInstance();
        ensureServer();
        DISPATCHER.tick();
        LocalPlayer player = minecraft.player;
        if (player == null || minecraft.level == null) {
            if (wasInWorld) {
                ACTIVITY.reset();
                cachedBlocks = new JsonArray();
                scanned = false;
                wasInWorld = false;
                DISPATCHER.failAll("client_not_ready", "client left the world");
                sendHello();
            }
            return;
        }
        if (!wasInWorld) {
            ACTIVITY.reset();
            scanned = false;
            wasInWorld = true;
            sendHello();
        }
        if (server == null || server.controller() == null) {
            return;
        }
        tick++;
        for (JsonObject swing : ACTIVITY.pollSwings(minecraft)) {
            server.send(ProtocolCodec.envelope("player_activity", swing, server.nextSequence(), null));
        }
        boolean moved = !player.blockPosition().equals(lastScanPos);
        if (!scanned || tick % 10 == 0 || moved) {
            int radius = scanRadius();
            cachedBlocks = ClientSnapshotService.nearbyBlocks(minecraft, radius);
            for (JsonObject change : ACTIVITY.pollBlockChanges(minecraft, radius)) {
                server.send(ProtocolCodec.envelope("player_activity", change, server.nextSequence(), null));
            }
            lastScanPos = player.blockPosition();
            scanned = true;
        }
        if (tick % 5 == 0) {
            sendSnapshot(minecraft);
        }
    }

    private void ensureServer() {
        boolean legacy;
        try {
            legacy = CommonBridgeConfig.legacyClientBridge();
        } catch (RuntimeException e) {
            return;
        }
        if (!legacy) {
            if (server != null) {
                try {
                    server.stop(200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (RuntimeException ignored) {
                    // 切回 NPC 模式时旧监听已经关掉即可。
                }
                server = null;
                startFailed = false;
            }
            return;
        }
        if (server != null || startFailed) {
            return;
        }
        boolean enabled;
        int port;
        try {
            enabled = BridgeConfig.enabled();
            port = BridgeConfig.port();
        } catch (RuntimeException e) {
            return;
        }
        if (!enabled) {
            return;
        }
        try {
            server = new BridgeServer(port, this, BridgeConfig.authUser(), BridgeConfig.authPass());
            DISPATCHER.bind(server);
            server.start();
        } catch (RuntimeException e) {
            startFailed = true;
            server = null;
            LOGGER.warn("Minaret bridge did not start: {}", e.toString());
        }
    }

    private void sendSnapshot(Minecraft minecraft) {
        JsonObject data = new JsonObject();
        data.add("player", ClientSnapshotService.player(minecraft));
        data.add("inventory", ClientSnapshotService.inventory(minecraft.player));
        data.add("nearby_blocks", cachedBlocks);
        data.add("nearby_players", ClientSnapshotService.nearbyPlayers(minecraft));
        data.add("screen", ClientSnapshotService.screen(minecraft));
        server.send(ProtocolCodec.envelope("snapshot", data, server.nextSequence(), null));
    }

    private void sendHello() {
        if (server == null || server.controller() == null) {
            return;
        }
        Minecraft minecraft = Minecraft.getInstance();
        boolean ready = minecraft.player != null && minecraft.level != null;
        JsonObject data = new JsonObject();
        data.addProperty("version", SharedConstants.getCurrentVersion().getName());
        data.addProperty("loader", "neoforge");
        data.addProperty("loader_version", loaderVersion());
        data.add("mods", modIds());
        if (ready) {
            data.addProperty("username", minecraft.player.getGameProfile().getName());
        } else {
            data.add("username", JsonNull.INSTANCE);
        }
        data.addProperty("world_ready", ready);
        data.add("capabilities", capabilities(ready));
        server.send(ProtocolCodec.envelope("hello", data, server.nextSequence(), null));
    }

    private static JsonArray capabilities(boolean worldReady) {
        JsonArray caps = new JsonArray();
        if (!worldReady) {
            return caps;
        }
        for (String cap : List.of(
                "minecraft.chat.say",
                "minecraft.player.position.read",
                "minecraft.player.health.read",
                "minecraft.inventory.read",
                "minecraft.block.scan",
                "minecraft.entity.nearby",
                "minecraft.player.look_at",
                "minecraft.inventory.select",
                "minecraft.inventory.drop",
                "minecraft.item.use",
                "minecraft.world.use_item_on_block",
                "minecraft.world.attack_block",
                "minecraft.world.interact",
                "minecraft.player.activity.observe",
                "minecraft.container.find_item"
        )) {
            caps.add(cap);
        }
        if (commandsAllowed()) {
            caps.add("minecraft.server.command");
        }
        return caps;
    }

    private static JsonArray modIds() {
        List<String> ids = new ArrayList<>();
        ModList.get().getMods().forEach(mod -> ids.add(mod.getModId()));
        ids.sort(String::compareTo);
        JsonArray array = new JsonArray();
        ids.forEach(array::add);
        return array;
    }

    private static String loaderVersion() {
        return ModList.get().getModContainerById("neoforge")
                .map(container -> container.getModInfo().getVersion().toString())
                .orElse("unknown");
    }

    private static int scanRadius() {
        try {
            return BridgeConfig.scanRadius();
        } catch (RuntimeException e) {
            return 8;
        }
    }

    private static boolean commandsAllowed() {
        try {
            return BridgeConfig.allowCommands();
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public void onHello(WebSocket conn) {
        Minecraft.getInstance().execute(this::sendHello);
    }

    @Override
    public void onAction(WebSocket conn, JsonObject message) {
        DISPATCHER.accept(conn, message);
    }

    @Override
    public void onCancel(WebSocket conn, JsonObject message) {
        DISPATCHER.cancel(message);
    }

    @Override
    public void onChat(WebSocket conn, String user, String message) {
        Minecraft.getInstance().execute(() -> {
            Minecraft minecraft = Minecraft.getInstance();
            if (minecraft.player == null || minecraft.player.connection == null) {
                server.send(ProtocolCodec.errorEvent(server.nextSequence(), "client_not_ready", "client is not in a world"));
                return;
            }
            if (message == null || message.isBlank()) {
                server.send(ProtocolCodec.errorEvent(server.nextSequence(), "invalid_params", "message is empty"));
                return;
            }
            minecraft.player.connection.sendChat(message);
        });
    }

    @Override
    public void onCommand(WebSocket conn, String command) {
        if (!commandsAllowed()) {
            server.send(ProtocolCodec.errorEvent(server.nextSequence(), "unsupported", "commands are disabled"));
            return;
        }
        String stripped = command == null ? "" : command.trim();
        if (stripped.startsWith("/")) {
            stripped = stripped.substring(1).trim();
        }
        String finalCommand = stripped;
        Minecraft.getInstance().execute(() -> {
            Minecraft minecraft = Minecraft.getInstance();
            if (finalCommand.isEmpty()) {
                server.send(ProtocolCodec.errorEvent(server.nextSequence(), "invalid_params", "command is empty"));
                return;
            }
            if (minecraft.player == null || minecraft.player.connection == null) {
                server.send(ProtocolCodec.errorEvent(server.nextSequence(), "client_not_ready", "client is not in a world"));
                return;
            }
            minecraft.player.connection.sendCommand(finalCommand);
        });
    }

    @Override
    public void onControllerClosed() {
        Minecraft.getInstance().execute(() -> DISPATCHER.failAll("not_connected", "controller disconnected"));
    }
}
