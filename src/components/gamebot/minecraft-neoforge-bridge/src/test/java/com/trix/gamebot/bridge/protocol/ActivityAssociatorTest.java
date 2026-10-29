package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ActivityAssociatorTest {
    @Test
    void fixtureConfidenceMatchesPython() throws Exception {
        JsonObject fixture;
        try (var input = ActivityAssociatorTest.class.getResourceAsStream("/protocol/minaret/fixtures/activity-input.json")) {
            assertNotNull(input, "shared activity fixture must be on the test classpath");
            try (var reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                fixture = JsonParser.parseReader(reader).getAsJsonObject();
            }
        }
        JsonObject matched = fixture.getAsJsonObject("matched");
        List<ActivityAssociator.Inference> found = ActivityAssociator.associate(swings(matched.getAsJsonArray("swings")), changes(matched.getAsJsonArray("changes")));
        assertEquals(1, found.size());
        assertEquals(matched.get("expected_confidence").getAsDouble(), found.get(0).confidence());
        assertEquals("Steve", found.get(0).player());
        assertTrue(found.get(0).evidence().contains("player_swing"));
        assertTrue(found.get(0).evidence().contains("block_changed"));

        JsonObject unlinked = fixture.getAsJsonObject("unlinked");
        assertTrue(ActivityAssociator.associate(swings(unlinked.getAsJsonArray("swings")), changes(unlinked.getAsJsonArray("changes"))).isEmpty());
    }

    private static List<ActivityAssociator.Swing> swings(JsonArray array) {
        List<ActivityAssociator.Swing> swings = new ArrayList<>();
        array.forEach(element -> {
            JsonObject swing = element.getAsJsonObject();
            JsonObject look = swing.getAsJsonObject("look");
            swings.add(new ActivityAssociator.Swing(
                    swing.get("player").getAsString(),
                    swing.get("uuid").getAsString(),
                    swing.get("time_ms").getAsLong(),
                    swing.get("x").getAsDouble(),
                    swing.get("y").getAsDouble(),
                    swing.get("z").getAsDouble(),
                    look.get("x").getAsDouble(),
                    look.get("y").getAsDouble(),
                    look.get("z").getAsDouble()
            ));
        });
        return swings;
    }

    private static List<ActivityAssociator.Change> changes(JsonArray array) {
        List<ActivityAssociator.Change> changes = new ArrayList<>();
        array.forEach(element -> {
            JsonObject change = element.getAsJsonObject();
            changes.add(new ActivityAssociator.Change(
                    change.get("time_ms").getAsLong(),
                    change.get("block_id").getAsString(),
                    change.get("x").getAsInt(),
                    change.get("y").getAsInt(),
                    change.get("z").getAsInt()
            ));
        });
        return changes;
    }
}
