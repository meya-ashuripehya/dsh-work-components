package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;

public final class ActionOutcome {
    public final boolean ok;
    public final boolean pending;
    public final String effect;
    public final String error;
    public final String errorCode;
    public final String sent;
    public final JsonObject evidence;

    private ActionOutcome(boolean ok, boolean pending, String effect, String error, String errorCode, String sent, JsonObject evidence) {
        this.ok = ok;
        this.pending = pending;
        this.effect = effect;
        this.error = error;
        this.errorCode = errorCode;
        this.sent = sent;
        this.evidence = evidence == null ? new JsonObject() : evidence;
    }

    public static ActionOutcome done(boolean ok, String effect, String error, String errorCode, String sent, JsonObject evidence) {
        return new ActionOutcome(ok, false, effect, error, errorCode, sent, evidence);
    }

    public static ActionOutcome pending(String sent, JsonObject evidence) {
        return new ActionOutcome(true, true, "observed", null, null, sent, evidence);
    }

    public static ActionOutcome failure(String code, String error) {
        return done(false, "failed", error, code, null, new JsonObject());
    }

    public static ActionOutcome failure(String code, String error, JsonObject evidence) {
        return done(false, "failed", error, code, null, evidence);
    }

    public static ActionOutcome unsupportedAdapter(String action, String blockId, String detail) {
        JsonObject evidence = new JsonObject();
        evidence.addProperty("action", action == null ? "" : action);
        if (blockId != null) {
            evidence.addProperty("block_id", blockId);
        }
        evidence.addProperty("reason", detail);
        return failure("unsupported_adapter", detail, evidence);
    }
}
