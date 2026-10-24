package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonObject;

import java.util.regex.Pattern;

/** 服务端 NPC 桥的 v2 入站判定。v1 与未带版本的控制消息不能取得 agent。 */
public final class AgentMessages {
    public static final int VERSION = 2;
    public static final Pattern AGENT_ID = Pattern.compile("^[a-z0-9][a-z0-9-]{0,31}$");

    public static final class Verdict {
        public final String code;
        public final String message;
        public final boolean close;
        public final String event;
        public final String agentId;

        private Verdict(String code, String message, boolean close, String event, String agentId) {
            this.code = code;
            this.message = message;
            this.close = close;
            this.event = event;
            this.agentId = agentId;
        }

        public boolean ok() {
            return code == null;
        }
    }

    private AgentMessages() {
    }

    public static boolean validAgentId(String agentId) {
        return agentId != null && AGENT_ID.matcher(agentId).matches();
    }

    public static String agentId(JsonObject payload) {
        if (payload == null) {
            return null;
        }
        JsonObject data = object(payload, "data");
        String fromData = text(data, "agent_id");
        if (fromData != null) {
            return fromData;
        }
        return text(payload, "agent_id");
    }

    public static Verdict inspect(JsonObject payload, String boundAgentId) {
        if (payload == null) {
            return reject("invalid_params", "message must be an object", false, null);
        }
        boolean versioned = payload.has("protocol_version") && !payload.get("protocol_version").isJsonNull();
        if (!versioned) {
            return inspectLegacy(payload, boundAgentId);
        }
        int version;
        try {
            version = payload.get("protocol_version").getAsInt();
        } catch (RuntimeException e) {
            return reject("unsupported", "protocol_version is not supported", true, null);
        }
        if (version != VERSION) {
            return reject(
                    "unsupported",
                    "protocol_version " + version + " is not supported; this server NPC bridge speaks protocol_version 2",
                    true,
                    null
            );
        }
        String event = text(payload, "event");
        if (event == null) {
            event = "";
        }
        String claimed = agentId(payload);
        return switch (event) {
            case "hello" -> inspectHello(claimed, boundAgentId);
            case "action_request", "cancel_action", "claim_revoke" -> inspectScoped(event, claimed, boundAgentId);
            default -> reject("unsupported", "event is not supported", false, event);
        };
    }

    private static Verdict inspectLegacy(JsonObject payload, String boundAgentId) {
        if (boundAgentId == null) {
            return reject("unsupported", "protocol_version 2 is required", true, null);
        }
        if (payload.has("command")) {
            return optionalAgent(boundAgentId, agentId(payload), "command");
        }
        if (payload.has("message")) {
            return optionalAgent(boundAgentId, agentId(payload), "chat");
        }
        return reject("unsupported", "legacy message is not supported", false, text(payload, "event"));
    }

    private static Verdict inspectHello(String claimed, String boundAgentId) {
        if (!validAgentId(claimed)) {
            return reject("agent_id_required", "hello requires data.agent_id matching ^[a-z0-9][a-z0-9-]{0,31}$", true, "hello");
        }
        if (boundAgentId != null && !boundAgentId.equals(claimed)) {
            return reject("agent_mismatch", "connection is already bound to a different agent", true, "hello");
        }
        return accept("hello", claimed);
    }

    private static Verdict inspectScoped(String event, String claimed, String boundAgentId) {
        if (boundAgentId == null) {
            return reject("not_bound", "connection has no agent", false, event);
        }
        if (!validAgentId(claimed)) {
            return reject("agent_id_required", event + " requires data.agent_id", false, event);
        }
        if (!boundAgentId.equals(claimed)) {
            return reject("agent_mismatch", "agent_id does not match this connection", false, event);
        }
        return accept(event, claimed);
    }

    private static Verdict optionalAgent(String boundAgentId, String claimed, String event) {
        if (claimed != null && !boundAgentId.equals(claimed)) {
            return reject("agent_mismatch", "agent_id does not match this connection", false, event);
        }
        return accept(event, boundAgentId);
    }

    private static Verdict accept(String event, String agentId) {
        return new Verdict(null, null, false, event, agentId);
    }

    private static Verdict reject(String code, String message, boolean close, String event) {
        return new Verdict(code, message, close, event, null);
    }

    private static JsonObject object(JsonObject payload, String key) {
        if (payload == null || !payload.has(key) || !payload.get(key).isJsonObject()) {
            return null;
        }
        return payload.getAsJsonObject(key);
    }

    private static String text(JsonObject payload, String key) {
        if (payload == null || !payload.has(key) || payload.get(key).isJsonNull()) {
            return null;
        }
        return payload.get(key).getAsString();
    }
}
