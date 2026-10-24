package com.trix.gamebot.bridge.transport;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.protocol.ProtocolException;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 只绑定 127.0.0.1，全局只有一个控制连接。新连接会替换旧连接。
 * 这是 legacy 客户端玩家模式（{@code legacyClientBridge}）专用。
 * 服务端 NPC 走 {@link AgentBridgeServer}：每个 agent 一条连接，不能再用这里的全局控制端。
 */
public final class BridgeServer extends WebSocketServer {
    private static final Logger LOGGER = LoggerFactory.getLogger(BridgeServer.class);
    private static final int QUEUE_LIMIT = 64;

    public interface Listener {
        void onHello(WebSocket conn);

        void onAction(WebSocket conn, JsonObject message);

        void onCancel(WebSocket conn, JsonObject message);

        void onChat(WebSocket conn, String user, String message);

        void onCommand(WebSocket conn, String command);

        void onControllerClosed();
    }

    private final Listener listener;
    private final String authUser;
    private final String authPass;
    private final AtomicReference<WebSocket> controller = new AtomicReference<>();
    private final AtomicLong sequence = new AtomicLong();
    private final ArrayDeque<JsonObject> outbound = new ArrayDeque<>();

    public BridgeServer(int port, Listener listener, String authUser, String authPass) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.listener = listener;
        this.authUser = authUser == null ? "" : authUser;
        this.authPass = authPass == null ? "" : authPass;
        setReuseAddr(true);
        setConnectionLostTimeout(30);
    }

    public WebSocket controller() {
        return controller.get();
    }

    public long nextSequence() {
        return sequence.incrementAndGet();
    }

    public void send(JsonObject payload) {
        synchronized (outbound) {
            String event = payload.has("event") ? payload.get("event").getAsString() : "";
            if (outbound.size() >= QUEUE_LIMIT) {
                boolean removed = false;
                var iterator = outbound.iterator();
                while (iterator.hasNext()) {
                    JsonObject queued = iterator.next();
                    String queuedEvent = queued.has("event") ? queued.get("event").getAsString() : "";
                    if (ProtocolCodec.droppable(queuedEvent)) {
                        iterator.remove();
                        removed = true;
                        break;
                    }
                }
                if (!removed && ProtocolCodec.droppable(event)) {
                    return;
                }
            }
            outbound.addLast(payload);
            WebSocket conn = controller.get();
            if (conn == null || !conn.isOpen()) {
                return;
            }
            while (!outbound.isEmpty()) {
                JsonObject next = outbound.pollFirst();
                String encoded = ProtocolCodec.toJson(next);
                if (encoded.getBytes(StandardCharsets.UTF_8).length > ProtocolCodec.MAX_MESSAGE_BYTES) {
                    LOGGER.warn("Dropped oversized bridge message");
                    continue;
                }
                conn.send(encoded);
            }
        }
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String header = handshake == null ? null : handshake.getFieldValue("Authorization");
        if (!Auth.authorize(authUser, authPass, header)) {
            LOGGER.info("Rejected a bridge connection: authentication failed");
            try {
                conn.send(ProtocolCodec.toJson(ProtocolCodec.errorEvent(nextSequence(), "action_rejected", "authentication failed")));
            } catch (Exception ignored) {
                // 关闭前尽量通知，失败也不记录请求头。
            }
            conn.close(1008, "unauthorized");
            return;
        }
        synchronized (outbound) {
            outbound.clear();
        }
        WebSocket previous = controller.getAndSet(conn);
        if (previous != null && previous != conn && previous.isOpen()) {
            previous.close(4000, "replaced");
        }
        LOGGER.info("Bridge controller connected");
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        if (controller.compareAndSet(conn, null)) {
            synchronized (outbound) {
                outbound.clear();
            }
            listener.onControllerClosed();
            LOGGER.info("Bridge controller disconnected");
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        if (conn != controller.get()) {
            conn.close(1008, "not controller");
            return;
        }
        if (message != null && message.getBytes(StandardCharsets.UTF_8).length > ProtocolCodec.MAX_MESSAGE_BYTES) {
            send(ProtocolCodec.errorEvent(nextSequence(), "invalid_params", "message exceeds 1 MiB"));
            return;
        }
        try {
            JsonObject payload = ProtocolCodec.parse(message);
            dispatch(conn, payload);
        } catch (ProtocolException e) {
            send(ProtocolCodec.errorEvent(nextSequence(), e.code, e.getMessage()));
        } catch (Exception e) {
            LOGGER.warn("Bridge message failed: {}", e.toString());
            send(ProtocolCodec.errorEvent(nextSequence(), "internal_error", "message could not be handled"));
        }
    }

    private void dispatch(WebSocket conn, JsonObject payload) {
        boolean versioned = payload.has("protocol_version") && !payload.get("protocol_version").isJsonNull();
        if (versioned) {
            int version = payload.get("protocol_version").getAsInt();
            if (version != ProtocolCodec.PROTOCOL_VERSION) {
                send(ProtocolCodec.errorEvent(nextSequence(), "unsupported", "protocol_version is not supported"));
                return;
            }
            String event = payload.has("event") ? payload.get("event").getAsString() : "";
            switch (event) {
                case "hello" -> listener.onHello(conn);
                case "action_request" -> listener.onAction(conn, payload);
                case "cancel_action" -> listener.onCancel(conn, payload);
                default -> send(ProtocolCodec.errorEvent(nextSequence(), "unsupported", "event is not supported"));
            }
            return;
        }
        if (payload.has("command")) {
            listener.onCommand(conn, payload.get("command").getAsString());
            return;
        }
        if (payload.has("message")) {
            String user = payload.has("user") && !payload.get("user").isJsonNull() ? payload.get("user").getAsString() : "";
            listener.onChat(conn, user, payload.get("message").getAsString());
            return;
        }
        String event = payload.has("event") ? payload.get("event").getAsString() : "";
        if ("hello".equals(event)) {
            listener.onHello(conn);
            return;
        }
        send(ProtocolCodec.errorEvent(nextSequence(), "unsupported", "legacy message is not supported"));
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        LOGGER.warn("Bridge socket error: {}", ex.toString());
    }

    @Override
    public void onStart() {
        LOGGER.info("Minaret bridge listening on 127.0.0.1:{}", getPort());
    }
}
