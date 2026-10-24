package com.trix.gamebot.bridge.entity;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentRecordTest {
    @Test
    void secondSpawnIsRejectedUntilRemoved() {
        AgentRecord record = new AgentRecord();
        UUID first = UUID.randomUUID();
        assertNull(record.tryAssign(first.toString(), "Momo", "minecraft:overworld"));
        assertEquals("already_exists", record.tryAssign(UUID.randomUUID().toString(), "Other", "minecraft:overworld"));
        assertTrue(record.owns(first));
        record.clear();
        assertFalse(record.occupied());
        assertNull(record.tryAssign(UUID.randomUUID().toString(), "Other", "minecraft:the_nether"));
    }

    @Test
    void saveAndLoadKeepsTheSingleNpc() {
        AgentRecord record = new AgentRecord();
        UUID id = UUID.fromString("12345678-1234-1234-1234-123456789abc");
        record.tryAssign(id.toString(), "Momo", "minecraft:overworld");
        record.remember("minecraft:overworld", 12.2, 64.0, -3.4);
        AgentRecord loaded = new AgentRecord();
        loaded.readFields(record.fields());
        assertTrue(loaded.owns(id));
        assertEquals("Momo", loaded.name());
        assertEquals("minecraft:overworld", loaded.dimension());
        assertEquals(12.2, loaded.x());
        assertTrue(loaded.hasPosition());
        assertEquals("already_exists", loaded.tryAssign(UUID.randomUUID().toString(), "Second", "minecraft:overworld"));
    }

    @Test
    void oldSavedFieldsWithoutAMemberStayUnbound() {
        Map<String, String> fields = new LinkedHashMap<>();
        UUID id = UUID.fromString("12345678-1234-1234-1234-123456789abc");
        fields.put("AgentId", id.toString());
        fields.put("Name", "Momo");
        fields.put("Dimension", "minecraft:overworld");
        fields.put("HasPosition", "true");
        fields.put("X", "1");
        fields.put("Y", "64");
        fields.put("Z", "2");
        AgentRecord loaded = new AgentRecord();
        loaded.readFields(fields);
        assertTrue(loaded.legacyUnbound());
        assertEquals("", loaded.agentKey());
        assertTrue(loaded.owns(id));
    }
}
