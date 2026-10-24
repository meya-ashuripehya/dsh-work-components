package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProtocolRulesTest {
    @Test
    void helloFixtureKeepsVersionAndCapabilities() throws Exception {
        JsonObject hello = JsonParser.parseString(Files.readString(fixture("hello-v1.json"))).getAsJsonObject();
        assertEquals(1, hello.get("protocol_version").getAsInt());
        assertEquals("1.21.1", hello.getAsJsonObject("data").get("version").getAsString());
        assertTrue(hello.getAsJsonObject("data").getAsJsonArray("capabilities").toString().contains("minecraft.world.use_item_on_block"));
    }

    @Test
    void useRequestAcceptsIronOnDepot() throws Exception {
        JsonObject request = JsonParser.parseString(Files.readString(fixture("action-request-use.json"))).getAsJsonObject();
        JsonObject params = Validators.validateAction("use_item_on_block", request.getAsJsonObject("data").getAsJsonObject("params"));
        assertEquals("minecraft:iron_ingot", params.get("item_id").getAsString());
        assertEquals(12, params.getAsJsonObject("pos").get("x").getAsInt());
        assertEquals("up", params.get("face").getAsString());
    }

    @Test
    void hotbarLimitAndBadIdsFailClosed() {
        ProtocolException slot = assertThrows(ProtocolException.class, () -> Validators.validateAction("select_item", object("{\"slot\":9}")));
        assertEquals("unsupported", slot.code);
        ProtocolException item = assertThrows(ProtocolException.class, () -> Validators.validateAction("use_item_on_block", object("{\"item_id\":\"Iron\",\"pos\":{\"x\":1,\"y\":2,\"z\":3}}")));
        assertEquals("invalid_params", item.code);
    }

    @Test
    void findItemRequiresAnItemIdAndClampsRadius() throws Exception {
        JsonObject params = Validators.validateAction("find_item", object("{\"item_id\":\"minecraft:iron_ingot\",\"radius\":8}"));
        assertEquals("minecraft:iron_ingot", params.get("item_id").getAsString());
        assertEquals(8, params.get("radius").getAsInt());
        ProtocolException missing = assertThrows(ProtocolException.class, () -> Validators.validateAction("find_item", object("{}")));
        assertEquals("invalid_params", missing.code);
        ProtocolException radius = assertThrows(ProtocolException.class, () -> Validators.validateAction("find_item", object("{\"item_id\":\"minecraft:iron_ingot\",\"radius\":17}")));
        assertEquals("invalid_params", radius.code);
    }

    @Test
    void moveToAndAttackEntityStayInTheServerActionSet() throws Exception {
        JsonObject move = Validators.validateAction("move_to", object("{\"x\":1.5,\"y\":64,\"z\":-2}"));
        assertEquals(1.5, move.get("x").getAsDouble());
        JsonObject attack = Validators.validateAction("attack_entity", object("{}"));
        assertTrue(!attack.has("uuid"));
        ProtocolException uuid = assertThrows(ProtocolException.class, () -> Validators.validateAction("attack_entity", object("{\"uuid\":\"not-a-uuid\"}")));
        assertEquals("invalid_params", uuid.code);
    }

    @Test
    void faceCenterIsTheTopMiddle() {
        double[] center = FacePoints.center("up");
        assertEquals(0.5, center[0]);
        assertEquals(1.0, center[1]);
        assertEquals(0.5, center[2]);
    }

    @Test
    void eleventhActionInOneSecondIsLimited() {
        RateLimiter limiter = new RateLimiter(10);
        for (int i = 0; i < 10; i++) {
            assertTrue(limiter.tryAcquire(1_000));
        }
        assertTrue(!limiter.tryAcquire(1_000));
        assertTrue(limiter.tryAcquire(2_001));
    }

    private static JsonObject object(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static Path fixture(String name) {
        Path relative = Path.of("..", "protocol", "minaret", "fixtures", name);
        if (Files.exists(relative)) return relative;
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path beside = dir.resolve("protocol").resolve("minaret").resolve("fixtures").resolve(name);
            if (Files.exists(beside)) return beside;
            dir = dir.getParent();
        }
        return relative;
    }

    @Test
    void placeBlockNormalizesDefaultsAndState() throws Exception {
        JsonObject params = Validators.validateAction("place_block", object(
                "{\"pos\":{\"x\":1,\"y\":64,\"z\":-3},\"block_id\":\"minecraft:oak_stairs\",\"state\":{\"facing\":\"north\",\"half\":\"bottom\"}}"));
        assertEquals("minecraft:oak_stairs", params.get("block_id").getAsString());
        assertEquals(4.5, params.get("max_distance").getAsDouble());
        assertEquals("north", params.getAsJsonObject("state").get("facing").getAsString());
        assertTrue(!params.has("face"));
    }

    @Test
    void placeBlockRejectsBadInputs() {
        for (String bad : new String[] {
                "{\"block_id\":\"minecraft:stone\"}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3}}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"block_id\":\"Stone\"}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"block_id\":\"minecraft:stone\",\"state\":{\"Facing\":\"north\"}}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"block_id\":\"minecraft:stone\",\"state\":{\"facing\":\"north east\"}}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"block_id\":\"minecraft:stone\",\"face\":\"sideways\"}",
                "{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"block_id\":\"minecraft:stone\",\"max_distance\":9}"
        }) {
            ProtocolException error = assertThrows(ProtocolException.class, () -> Validators.validateAction("place_block", object(bad)));
            assertEquals("invalid_params", error.code, bad);
        }
    }

    @Test
    void probeBlocksRequiresOneToSixteenPositions() throws Exception {
        JsonObject params = Validators.validateAction("probe_blocks", object(
                "{\"positions\":[{\"x\":4,\"y\":2,\"z\":3},{\"x\":4,\"y\":3,\"z\":3}]}"));
        assertEquals(2, params.getAsJsonArray("positions").size());
        assertEquals(4, params.getAsJsonArray("positions").get(0).getAsJsonObject().get("x").getAsInt());
        for (String bad : new String[] {"{}", "{\"positions\":[]}", "{\"positions\":[{\"x\":1}]}"}) {
            ProtocolException error = assertThrows(ProtocolException.class, () -> Validators.validateAction("probe_blocks", object(bad)));
            assertEquals("invalid_params", error.code, bad);
        }
    }

    @Test
    void breakBlockRequiresExpectedBlock() throws Exception {
        JsonObject params = Validators.validateAction("break_block", object(
                "{\"pos\":{\"x\":1,\"y\":64,\"z\":-3},\"expected_block\":\"minecraft:dirt\"}"));
        assertEquals("minecraft:dirt", params.get("expected_block").getAsString());
        ProtocolException missing = assertThrows(ProtocolException.class, () -> Validators.validateAction("break_block", object(
                "{\"pos\":{\"x\":1,\"y\":64,\"z\":-3}}")));
        assertEquals("invalid_params", missing.code);
    }

    @Test
    void serverNpcHelloRequiresAnAgentId() {
        AgentMessages.Verdict missing = AgentMessages.inspect(object("{\"protocol_version\":2,\"event\":\"hello\",\"data\":{}}"), null);
        assertEquals("agent_id_required", missing.code);
        assertTrue(missing.close);
        AgentMessages.Verdict named = AgentMessages.inspect(object("{\"protocol_version\":2,\"event\":\"hello\",\"data\":{\"agent_id\":\"claude\"}}"), null);
        assertTrue(named.ok());
        assertEquals("claude", named.agentId);
    }

    @Test
    void versionOneCannotBindAServerNpc() {
        AgentMessages.Verdict verdict = AgentMessages.inspect(object("{\"protocol_version\":1,\"event\":\"hello\",\"data\":{\"agent_id\":\"claude\"}}"), null);
        assertEquals("unsupported", verdict.code);
        assertTrue(verdict.close);
        AgentMessages.Verdict legacy = AgentMessages.inspect(object("{\"event\":\"hello\",\"user\":\"Bot\"}"), null);
        assertEquals("unsupported", legacy.code);
        assertTrue(legacy.close);
    }

    @Test
    void actionForAnotherAgentIsRejectedWithoutClosing() {
        JsonObject action = object("{\"protocol_version\":2,\"event\":\"action_request\",\"request_id\":\"r\",\"data\":{\"action\":\"look_at\",\"agent_id\":\"gpt\"}}");
        assertTrue(AgentMessages.inspect(action, "gpt").ok());
        AgentMessages.Verdict spoof = AgentMessages.inspect(action, "claude");
        assertEquals("agent_mismatch", spoof.code);
        assertFalse(spoof.close);
        AgentMessages.Verdict unbound = AgentMessages.inspect(action, null);
        assertEquals("not_bound", unbound.code);
        JsonObject revoke = object("{\"protocol_version\":2,\"event\":\"claim_revoke\",\"data\":{\"agent_id\":\"gpt\",\"pid\":\"site\",\"tid\":\"floor\",\"gen\":2,\"sig\":\"abc\"}}");
        assertTrue(AgentMessages.inspect(revoke, "gpt").ok());
    }
}
