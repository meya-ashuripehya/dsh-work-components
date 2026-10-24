package com.trix.gamebot.bridge.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;

/** 信封编解码。未知字段保留在原始对象里，由调用方忽略。legacy 客户端桥仍用 v1；服务端 NPC 桥用 v2。 */
public final class ProtocolCodec {
    public static final int PROTOCOL_VERSION = 1;
    public static final int AGENT_PROTOCOL_VERSION = 2;
    public static final int MAX_MESSAGE_BYTES = 1024 * 1024;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    private ProtocolCodec() {
    }

    public static JsonObject parse(String text) throws ProtocolException {
        if (text == null || text.length() > MAX_MESSAGE_BYTES) {
            throw new ProtocolException("invalid_params", "message exceeds 1 MiB");
        }
        try {
            var element = JsonParser.parseString(text);
            if (!element.isJsonObject()) {
                throw new ProtocolException("invalid_params", "message must be an object");
            }
            return element.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            throw new ProtocolException("invalid_params", "message is not valid json");
        }
    }

    public static JsonObject envelope(String event, JsonObject data, long sequence, String requestId) {
        return envelope(PROTOCOL_VERSION, event, data, sequence, requestId);
    }

    public static JsonObject envelope(int protocolVersion, String event, JsonObject data, long sequence, String requestId) {
        JsonObject payload = new JsonObject();
        payload.addProperty("protocol_version", protocolVersion);
        payload.addProperty("event", event);
        if (requestId != null && !requestId.isEmpty()) {
            payload.addProperty("request_id", requestId);
        }
        payload.addProperty("sequence", sequence);
        payload.addProperty("timestamp_ms", System.currentTimeMillis());
        payload.add("data", data == null ? new JsonObject() : data);
        return payload;
    }

    public static JsonObject actionResult(
            String requestId,
            long sequence,
            boolean ok,
            String action,
            String effect,
            String error,
            String errorCode,
            String sent,
            JsonObject evidence
    ) {
        return actionResult(PROTOCOL_VERSION, requestId, sequence, ok, action, effect, error, errorCode, sent, evidence);
    }

    public static JsonObject actionResult(
            int protocolVersion,
            String requestId,
            long sequence,
            boolean ok,
            String action,
            String effect,
            String error,
            String errorCode,
            String sent,
            JsonObject evidence
    ) {
        JsonObject data = new JsonObject();
        data.addProperty("ok", ok);
        data.addProperty("action", action == null ? "" : action);
        data.addProperty("effect", effect);
        data.add("error", error == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(error));
        data.add("error_code", errorCode == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(errorCode));
        data.add("sent", sent == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(sent));
        data.add("evidence", evidence == null ? new JsonObject() : evidence);
        return envelope(protocolVersion, "action_result", data, sequence, requestId);
    }

    public static JsonObject errorEvent(long sequence, String errorCode, String error) {
        return errorEvent(PROTOCOL_VERSION, sequence, errorCode, error);
    }

    public static JsonObject errorEvent(int protocolVersion, long sequence, String errorCode, String error) {
        JsonObject data = new JsonObject();
        data.addProperty("error_code", errorCode);
        data.addProperty("error", error);
        return envelope(protocolVersion, "error", data, sequence, null);
    }

    public static String toJson(JsonObject payload) {
        return GSON.toJson(payload);
    }

    public static boolean droppable(String event) {
        return "snapshot".equals(event) || "player_activity".equals(event);
    }
}
