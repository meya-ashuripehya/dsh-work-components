package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Opt-in state transitions. Enabled only when {@code -Dminaret.diagnostics=true}. */
public final class MinaretDiagnostics {
    public static final String PROPERTY = "minaret.diagnostics";
    private static final Logger LOGGER = LoggerFactory.getLogger(MinaretDiagnostics.class);

    private MinaretDiagnostics() {
    }

    public static boolean enabled() {
        return Boolean.getBoolean(PROPERTY);
    }

    public static void transition(String agentId, long generation, String requestId, String phase, String detail) {
        if (!enabled()) {
            return;
        }
        try {
            LOGGER.info(
                    "minaret.diagnostics phase={} agent_id={} generation={} request_id={} {}",
                    phase,
                    agentId,
                    generation,
                    requestId,
                    detail == null ? "" : detail
            );
        } catch (RuntimeException ignored) {
            // Diagnostics must not change action control flow.
        }
    }

    public static void footprint(String agentId, long generation, String requestId, boolean stateMatch, boolean multiOk, JsonObject evidence) {
        if (!enabled()) {
            return;
        }
        String cells = evidence != null && evidence.has("related_cells") ? evidence.get("related_cells").toString() : "[]";
        String multi = evidence != null && evidence.has("multi_cell") ? evidence.get("multi_cell").getAsString() : "none";
        transition(agentId, generation, requestId, "footprint",
                "state_match=" + stateMatch + " multi_ok=" + multiOk + " multi_cell=" + multi + " cells=" + cells);
    }
}
