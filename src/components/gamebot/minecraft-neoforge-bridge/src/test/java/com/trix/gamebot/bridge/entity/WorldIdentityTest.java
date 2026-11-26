package com.trix.gamebot.bridge.entity;

import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class WorldIdentityTest {
    @Test
    void identityPersistsAcrossSaveAndReloadAndDiffersBetweenWorlds() {
        AgentRegistry first = new AgentRegistry();
        CompoundTag saved = first.save(new CompoundTag(), null);
        AgentRegistry loaded = AgentRegistry.factory().deserializer().apply(saved, null);
        assertEquals(first.worldId(), loaded.worldId());
        assertNotEquals(first.worldId(), new AgentRegistry().worldId());
    }
    @Test
    void legacySaveAcquiresAnIdentityWithoutInventingMembers() {
        AgentRegistry upgraded = AgentRegistry.factory().deserializer().apply(new CompoundTag(), null);
        assertNotNull(upgraded.worldId());
        assertEquals(0, upgraded.table().size());
        assertTrue(upgraded.save(new CompoundTag(), null).hasUUID("WorldId"));
    }
}
