package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.transport.AgentBridgeServer;
import com.trix.gamebot.bridge.transport.AgentConnections;
import java.util.UUID;

/** Player-to-NPC messages travel only over the selected seat's connection. */
public final class PlayerPrivateChat {
    private PlayerPrivateChat() {}

    public static String deliver(AgentBridgeServer socket, String player, String agentId, String message) {
        if (socket == null || !AgentMessages.validAgentId(agentId)) return "目标席位不合法或工作台未连接";
        AgentConnections.Binding binding = socket.connections().bindingOfAgent(agentId);
        if (binding == null || !binding.channel.isOpen()) return "目标席位未连接工作台";
        if (player == null || player.isBlank() || message == null || message.isBlank() || message.length() > 2000) {
            return "私聊内容不能为空且不得超过2000字符";
        }
        long sequence = socket.nextSequence();
        JsonObject data = new JsonObject();
        data.addProperty("player", player);
        data.addProperty("username", player);
        data.addProperty("source", "player");
        data.addProperty("audience", "private");
        data.addProperty("target", agentId);
        data.addProperty("message", message);
        data.addProperty("message_id", "private:" + sequence + ":" + UUID.randomUUID());
        socket.send(agentId, binding.generation,
                ProtocolCodec.envelope(ProtocolCodec.AGENT_PROTOCOL_VERSION, "chat", data, sequence, null));
        return null;
    }
}
