package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MovementExclusionsTest {
    @Test
    void absentExclusionsAreExplicit() {
        MovementExclusions none = MovementExclusions.parse(new JsonObject());
        JsonObject evidence = new JsonObject();
        none.writeEvidence(evidence);
        assertFalse(evidence.get("exclusions_applied").getAsBoolean());
        assertTrue(evidence.get("exclusions_note").getAsString().contains("no external"));
    }

    @Test
    void segmentCrossesBox() {
        JsonObject params = JsonParser.parseString(
                "{\"exclusions\":[{\"x1\":1,\"y1\":60,\"z1\":1,\"x2\":2,\"y2\":62,\"z2\":2}]}").getAsJsonObject();
        MovementExclusions zones = MovementExclusions.parse(params);
        assertTrue(zones.segmentCrosses(new Vec3(0.5, 61, 1.5), new Vec3(3, 61, 1.5)));
        assertFalse(zones.segmentCrosses(new Vec3(0, 61, 0), new Vec3(0.5, 61, 0.5)));
    }
}
