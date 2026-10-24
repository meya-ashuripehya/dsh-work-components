package com.trix.gamebot.bridge.entity;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentTableTest {
    private static final String[] MEMBERS = {"claude", "gpt", "grok", "deepseek", "gemini"};

    @Test
    void fiveMembersGetFiveDistinctNpcsAndProvisioningIsIdempotent() {
        AgentTable table = new AgentTable();
        UUID[] ids = new UUID[MEMBERS.length];
        for (int i = 0; i < MEMBERS.length; i++) {
            ids[i] = UUID.randomUUID();
            assertNull(table.assign(MEMBERS[i], ids[i].toString(), MEMBERS[i], "minecraft:overworld", 8));
        }
        assertEquals(5, table.size());
        for (int i = 0; i < MEMBERS.length; i++) {
            assertEquals(ids[i].toString(), table.find(MEMBERS[i]).id());
            assertNull(table.assign(MEMBERS[i], ids[i].toString(), MEMBERS[i], "minecraft:overworld", 8));
        }
        assertEquals(5, table.size());
        assertEquals("already_exists", table.assign("claude", UUID.randomUUID().toString(), "Claude", "minecraft:overworld", 8));
        assertEquals("invalid", table.assign("Claude", UUID.randomUUID().toString(), "Claude", "minecraft:overworld", 8));
        assertEquals(ids[0].toString(), table.find("claude").id());
    }

    @Test
    void reloadDoesNotDuplicateRecords() {
        AgentTable table = new AgentTable();
        for (String member : MEMBERS) {
            table.assign(member, UUID.randomUUID().toString(), member, "minecraft:overworld", 8);
        }
        List<AgentRecord> records = new ArrayList<>();
        for (Map<String, String> fields : table.exportAgents()) {
            AgentRecord record = new AgentRecord();
            record.readFields(fields);
            records.add(record);
        }
        AgentTable loaded = new AgentTable();
        loaded.replace(records, null, true);
        assertEquals(5, loaded.size());
        for (String member : MEMBERS) {
            assertEquals(table.find(member).id(), loaded.find(member).id());
            assertNull(loaded.assign(member, loaded.find(member).id(), member, "minecraft:overworld", 8));
        }
        assertEquals(5, loaded.size());
    }

    @Test
    void legacySingleNpcStaysUnboundUntilAdopted() {
        UUID id = UUID.fromString("12345678-1234-1234-1234-123456789abc");
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("AgentId", id.toString());
        fields.put("Name", "Momo");
        fields.put("Dimension", "minecraft:overworld");
        fields.put("HasPosition", "true");
        fields.put("X", "1");
        fields.put("Y", "64");
        fields.put("Z", "2");
        AgentRecord legacy = new AgentRecord();
        legacy.readFields(fields);
        AgentTable table = new AgentTable();
        assertNull(table.importLegacy(legacy));
        assertTrue(table.legacy().legacyUnbound());
        assertNull(table.find("claude"));
        assertTrue(table.ownsEntity(id));
        assertEquals("no_legacy", new AgentTable().adoptLegacy("claude"));
        assertNull(table.adoptLegacy("claude"));
        assertNull(table.legacy());
        assertEquals(id.toString(), table.find("claude").id());
        assertEquals("active", table.find("claude").status());
        assertEquals("no_legacy", table.adoptLegacy("gpt"));
        assertEquals("already_exists", table.assign("gpt", id.toString(), "gpt", "minecraft:overworld", 8));
    }
}
