package com.trix.gamebot.bridge.entity;

import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.saveddata.SavedData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 主世界 SavedData。成员 NPC 写在 minaret_agents；旧的 minaret_agent 只读进来，不改原文件。 */
public final class AgentRegistry extends SavedData {
    public static final String STORAGE_ID = "minaret_agents";
    public static final String LEGACY_STORAGE_ID = "minaret_agent";
    private static final Logger LOGGER = LoggerFactory.getLogger(AgentRegistry.class);
    private final AgentTable table = new AgentTable();

    public static AgentRegistry get(MinecraftServer server) {
        AgentRegistry registry = server.overworld().getDataStorage().computeIfAbsent(factory(), STORAGE_ID);
        registry.importLegacyOnce(server);
        return registry;
    }

    public static SavedData.Factory<AgentRegistry> factory() {
        return new SavedData.Factory<>(AgentRegistry::new, AgentRegistry::load);
    }

    private static AgentRegistry load(CompoundTag tag, HolderLookup.Provider provider) {
        AgentRegistry registry = new AgentRegistry();
        List<AgentRecord> records = new ArrayList<>();
        ListTag agents = tag.getList("Agents", Tag.TAG_COMPOUND);
        for (Tag raw : agents) {
            if (!(raw instanceof CompoundTag entry)) {
                continue;
            }
            AgentRecord record = new AgentRecord();
            record.read(entry);
            records.add(record);
        }
        AgentRecord legacy = null;
        if (tag.contains("Legacy")) {
            legacy = new AgentRecord();
            legacy.read(tag.getCompound("Legacy"));
        }
        registry.table.replace(records, legacy, tag.getBoolean("LegacyImported"));
        return registry;
    }

    public AgentTable table() {
        return table;
    }

    public AgentRecord find(String agentId) {
        return table.find(agentId);
    }

    public AgentRecord findByEntity(UUID uuid) {
        return table.findByEntity(uuid);
    }

    public AgentRecord legacy() {
        return table.legacy();
    }

    public boolean ownsEntity(UUID uuid) {
        return table.ownsEntity(uuid);
    }

    public int size() {
        return table.size();
    }

    public String assign(String agentId, UUID uuid, String name, String dimension, int max) {
        String error = table.assign(agentId, uuid == null ? "" : uuid.toString(), name, dimension, max);
        if (error == null) {
            setDirty();
        }
        return error;
    }

    public String adoptLegacy(String agentId) {
        String error = table.adoptLegacy(agentId);
        if (error == null) {
            setDirty();
        }
        return error;
    }

    public void remove(String agentId) {
        if (table.remove(agentId) != null) {
            setDirty();
        }
    }

    public void remember(AgentEntity agent) {
        AgentRecord record = table.findByEntity(agent.getUUID());
        if (record == null) {
            return;
        }
        String dimension = agent.level().dimension().location().toString();
        if (record.remember(dimension, agent.getX(), agent.getY(), agent.getZ())) {
            setDirty();
        }
    }

    private void importLegacyOnce(MinecraftServer server) {
        if (table.legacyImported()) {
            return;
        }
        synchronized (this) {
            if (table.legacyImported()) {
                return;
            }
            try {
                LegacyAgentData data = server.overworld().getDataStorage().get(LegacyAgentData.factory(), LEGACY_STORAGE_ID);
                if (data != null && data.record().occupied()) {
                    table.importLegacy(data.record());
                    LOGGER.info("Imported the previous single NPC as legacy_unbound; it stays uncontrolled until /minaret agent adopt");
                }
            } catch (RuntimeException e) {
                LOGGER.warn("Could not read the previous single NPC record: {}", e.toString());
            }
            table.markLegacyImported();
            setDirty();
        }
    }

    @Override
    public CompoundTag save(CompoundTag tag, HolderLookup.Provider provider) {
        ListTag agents = new ListTag();
        for (AgentRecord record : table.records()) {
            CompoundTag entry = new CompoundTag();
            record.write(entry);
            agents.add(entry);
        }
        tag.put("Agents", agents);
        if (table.legacy() != null) {
            CompoundTag legacy = new CompoundTag();
            table.legacy().write(legacy);
            tag.put("Legacy", legacy);
        }
        tag.putBoolean("LegacyImported", table.legacyImported());
        return tag;
    }
}
