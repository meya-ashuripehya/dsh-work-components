package com.trix.gamebot.bridge.transport;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.action.ActionReplies;
import com.trix.gamebot.bridge.protocol.ProtocolCodec;
import com.trix.gamebot.bridge.protocol.ProtocolException;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 服务端 NPC 的 loopback 桥。每条连接先进入未绑定状态，握手成功后只代表一个 agent。
 * 单控制端的 {@link BridgeServer} 只留给 legacy 客户端玩家模式。
 */
public final class AgentBridgeServer extends WebSocketServer implements ActionReplies {
    private static final Logger LOGGER = LoggerFactory.getLogger(AgentBridgeServer.class);

    public interface Listener {
        void onInbound(WebSocket conn, JsonObject message);

        void onAgentClosed(String agentId, long generation);
    }

    private final Listener listener;
    private final String authUser;
    private final String authPass;
    private final AgentConnections connections = new AgentConnections();
    private final AtomicLong sequence = new AtomicLong();

    public AgentBridgeServer(int port, Listener listener, String authUser, String authPass) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.listener = listener;
        this.authUser = authUser == null ? "" : authUser;
        this.authPass = authPass == null ? "" : authPass;
        setReuseAddr(true);
        setConnectionLostTimeout(30);
    }

    public AgentConnections connections() {
        return connections;
    }

    public AgentConnections.Channel channel(WebSocket conn) {
        if (conn == null) {
            return null;
        }
        Object attachment = conn.getAttachment();
        if (attachment instanceof SocketChannel channel) {
            return channel;
        }
        return null;
    }

    @Override
    public long nextSequence() {
        return sequence.incrementAndGet();
    }

    @Override
    public void send(String agentId, long generation, JsonObject payload) {
        deliver(agentId, generation, payload);
    }

    public void sendDirect(WebSocket conn, JsonObject payload) {
        if (conn == null || !conn.isOpen() || payload == null) {
            return;
        }
        String encoded = ProtocolCodec.toJson(payload);
        if (encoded.getBytes(StandardCharsets.UTF_8).length > ProtocolCodec.MAX_MESSAGE_BYTES) {
            LOGGER.warn("Dropped oversized bridge message");
            return;
        }
        conn.send(encoded);
    }

    public void broadcast(JsonObject payload) {
        if (payload == null) {
            return;
        }
        for (AgentConnections.Binding binding : connections.bound()) {
            deliver(binding.agentId, binding.generation, payload);
        }
    }

    private void deliver(String agentId, long generation, JsonObject payload) {
        String event = payload.has("event") && !payload.get("event").isJsonNull() ? payload.get("event").getAsString() : "";
        String encoded = ProtocolCodec.toJson(payload);
        if (encoded.getBytes(StandardCharsets.UTF_8).length > ProtocolCodec.MAX_MESSAGE_BYTES) {
            LOGGER.warn("Dropped oversized bridge message");
            return;
        }
        connections.send(agentId, generation, event, encoded, ProtocolCodec.droppable(event));
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        String header = handshake == null ? null : handshake.getFieldValue("Authorization");
        if (!Auth.authorize(authUser, authPass, header)) {
            LOGGER.info("Rejected a bridge connection: authentication failed");
            try {
                conn.send(ProtocolCodec.toJson(ProtocolCodec.errorEvent(
                        ProtocolCodec.AGENT_PROTOCOL_VERSION,
                        nextSequence(),
                        "action_rejected",
                        "authentication failed"
                )));
            } catch (Exception ignored) {
                // 关闭前尽量通知，失败也不记录请求头。
            }
            conn.close(1008, "unauthorized");
            return;
        }
        SocketChannel channel = new SocketChannel(conn);
        conn.setAttachment(channel);
        connections.open(channel);
        LOGGER.info("Bridge agent socket connected");
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        AgentConnections.Channel channel = channel(conn);
        if (channel == null) {
            return;
        }
        AgentConnections.Binding closed = connections.close(channel);
        if (closed == null) {
            return;
        }
        listener.onAgentClosed(closed.agentId, closed.generation);
        LOGGER.info("Bridge agent {} generation {} disconnected", closed.agentId, closed.generation);
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        if (channel(conn) == null) {
            conn.close(1008, "not controller");
            return;
        }
        if (message != null && message.getBytes(StandardCharsets.UTF_8).length > ProtocolCodec.MAX_MESSAGE_BYTES) {
            sendDirect(conn, ProtocolCodec.errorEvent(ProtocolCodec.AGENT_PROTOCOL_VERSION, nextSequence(), "invalid_params", "message exceeds 1 MiB"));
            return;
        }
        try {
            listener.onInbound(conn, ProtocolCodec.parse(message));
        } catch (ProtocolException e) {
            sendDirect(conn, ProtocolCodec.errorEvent(ProtocolCodec.AGENT_PROTOCOL_VERSION, nextSequence(), e.code, e.getMessage()));
        } catch (Exception e) {
            LOGGER.warn("Bridge message failed: {}", e.toString());
            sendDirect(conn, ProtocolCodec.errorEvent(ProtocolCodec.AGENT_PROTOCOL_VERSION, nextSequence(), "internal_error", "message could not be handled"));
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (conn != null) {
            AgentConnections.Channel channel = channel(conn);
            if (channel != null) {
                connections.onChannelError(channel);
            }
        }
        LOGGER.warn("Bridge socket error: {}", ex.toString());
    }

    @Override
    public void onStart() {
        LOGGER.info("Minaret agent bridge listening on 127.0.0.1:{}", getPort());
    }

    private static final class SocketChannel implements AgentConnections.Channel {
        private final WebSocket socket;

        private SocketChannel(WebSocket socket) {
            this.socket = socket;
        }

        @Override
        public boolean isOpen() {
            return socket.isOpen();
        }

        @Override
        public void send(String text) {
            socket.send(text);
        }

        @Override
        public void close(int code, String reason) {
            socket.close(code, reason);
        }
    }
}
