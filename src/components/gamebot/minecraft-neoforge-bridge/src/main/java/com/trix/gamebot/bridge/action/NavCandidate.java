package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;

/** One discrete navigation goal in a fixed candidate set. */
public record NavCandidate(String id, double x, double y, double z) {
    public void writeEvidence(JsonObject evidence) {
        evidence.addProperty("candidate_id", id);
        evidence.addProperty("candidate_x", x);
        evidence.addProperty("candidate_y", y);
        evidence.addProperty("candidate_z", z);
    }
}
