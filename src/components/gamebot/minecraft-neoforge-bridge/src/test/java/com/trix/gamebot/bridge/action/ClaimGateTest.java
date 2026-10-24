package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ClaimGateTest {
    private static final byte[] KEY = "test-claim-key".getBytes(StandardCharsets.UTF_8);
    private static final String SIG = "ea759c111249978caa1b3512eb8c15007982bbf29e6b99d1f8128180da1ef9d3";
    private static final String REVOKE = "27db5cf3f4a7e531fe8556bf2b37b28701a6423a69980dc1e222a72dfe383b91";
    private static final long NOW = 1_700_000_000_000L;

    @Test
    void acceptsTheSignedCellAndRejectsTheRest() {
        assertNull(ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim(), KEY, NOW, 0));
        assertEquals("claim signature does not match", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim("00"), KEY, NOW, 0).message);
        assertEquals("seat does not match", ClaimGate.check("beta", "place_block", pos(0, 64, 0), claim(), KEY, NOW, 0).message);
        assertEquals("claim expired", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim(), KEY, 1_700_000_900_000L, 0).message);
        assertEquals("claim generation is spent", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim(), KEY, NOW, 1).message);
        assertEquals("cell is not in the claim", ClaimGate.check("alpha", "place_block", pos(1, 64, 0), claim(), KEY, NOW, 0).message);
        assertEquals("claim does not allow this action", ClaimGate.check("alpha", "break_block", pos(0, 64, 0), claim(), KEY, NOW, 0).message);
        assertEquals("claim does not allow this action", ClaimGate.check("alpha", "attack_block", pos(0, 64, 0), claim(), KEY, NOW, 0).message);
        assertEquals("claim does not allow this action", ClaimGate.check("alpha", "use_item_on_block", pos(0, 64, 0), claim(), KEY, NOW, 0).message);
        assertEquals("claim key is missing", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim(), null, NOW, 0).message);
        assertEquals("claim is missing", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), null, KEY, NOW, 0).message);
        assertNull(ClaimGate.check("alpha", "move_to", pos(9, 9, 9), null, null, NOW, 0));
        assertNull(ClaimGate.check("alpha", "probe_blocks", pos(9, 9, 9), null, null, NOW, 0));
    }

    @Test
    void revokeRaisesTheGenerationFloor() {
        HashMap<String, Integer> floors = new HashMap<>();
        assertEquals("revoke signature does not match", ClaimGate.noteRevoke(KEY, "site", "floor", 2, "00", floors));
        assertNull(ClaimGate.noteRevoke(KEY, "site", "floor", 2, REVOKE, floors));
        assertEquals(2, floors.get("site\0floor"));
        assertEquals("claim generation is spent", ClaimGate.check("alpha", "place_block", pos(0, 64, 0), claim(), KEY, NOW, floors.get("site\0floor")).message);
    }

    private static JsonObject claim() {
        return claim(SIG);
    }

    private static JsonObject claim(String sig) {
        JsonObject cell = new JsonObject();
        cell.addProperty("x", 0);
        cell.addProperty("y", 64);
        cell.addProperty("z", 0);
        JsonArray cells = new JsonArray();
        cells.add(cell);
        JsonArray act = new JsonArray();
        act.add("place");
        JsonObject claim = new JsonObject();
        claim.addProperty("v", 1);
        claim.addProperty("mid", "alpha");
        claim.addProperty("tid", "floor");
        claim.addProperty("pid", "site");
        claim.addProperty("bv", 1);
        claim.addProperty("gen", 1);
        claim.addProperty("exp", 1700000900);
        claim.add("act", act);
        claim.add("cells", cells);
        claim.addProperty("sig", sig);
        return claim;
    }

    private static JsonObject pos(int x, int y, int z) {
        JsonObject pos = new JsonObject();
        pos.addProperty("x", x);
        pos.addProperty("y", y);
        pos.addProperty("z", z);
        JsonObject params = new JsonObject();
        params.add("pos", pos);
        return params;
    }
}
