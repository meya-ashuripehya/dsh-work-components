package com.trix.gamebot.bridge.entity;

import com.trix.gamebot.bridge.protocol.AgentMessages;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 一个存档里的 NPC 记录。每个 agent 一条；另有一个未绑定的旧单 NPC 槽。
 * 不猜测旧记录属于哪个成员。
 */
public final class AgentTable {
    public static final String ACTIVE = "active";
    public static final String LEGACY_UNBOUND = "legacy_unbound";
    public static final int DEFAULT_MAX = 8;

    private final LinkedHashMap<String, AgentRecord> agents = new LinkedHashMap<>();
    private AgentRecord legacy;
    private boolean legacyImported;

    public AgentRecord find(String agentId) {
        if (agentId == null) {
            return null;
        }
        return agents.get(agentId);
    }

    public AgentRecord findByEntity(UUID uuid) {
        if (uuid == null) {
            return null;
        }
        for (AgentRecord record : agents.values()) {
            if (record.owns(uuid)) {
                return record;
            }
        }
        if (legacy != null && legacy.owns(uuid)) {
            return legacy;
        }
        return null;
    }

    public AgentRecord legacy() {
        return legacy;
    }

    public boolean legacyImported() {
        return legacyImported;
    }

    public void markLegacyImported() {
        legacyImported = true;
    }

    public int size() {
        return agents.size();
    }

    public Collection<AgentRecord> records() {
        return List.copyOf(agents.values());
    }

    public boolean ownsEntity(UUID uuid) {
        return findByEntity(uuid) != null;
    }

    /**
     * 成功或同一个实体的重复登记返回 null。已有另一个实体、超出上限、编码非法时返回原因。
     */
    public String assign(String agentId, String entityId, String name, String dimension, int max) {
        if (!AgentMessages.validAgentId(agentId)) {
            return "invalid";
        }
        if (entityId == null || entityId.isBlank()) {
            return "invalid";
        }
        AgentRecord existing = agents.get(agentId);
        if (existing != null) {
            if (existing.id().equals(entityId)) {
                if (name != null && !name.isBlank()) {
                    existing.rename(name);
                }
                return null;
            }
            return "already_exists";
        }
        if (findByEntity(parse(entityId)) != null) {
            return "already_exists";
        }
        int limit = max <= 0 ? DEFAULT_MAX : max;
        if (agents.size() >= limit) {
            return "limit";
        }
        AgentRecord record = new AgentRecord();
        String error = record.tryAssign(entityId, name, dimension);
        if (error != null) {
            return error;
        }
        record.setAgentKey(agentId);
        record.setStatus(ACTIVE);
        agents.put(agentId, record);
        return null;
    }

    public AgentRecord remove(String agentId) {
        if (agentId == null) {
            return null;
        }
        return agents.remove(agentId);
    }

    /** 把旧的单 NPC 放进未绑定槽。已经导入过或槽里已有记录时不覆盖。 */
    public String importLegacy(AgentRecord record) {
        if (record == null || !record.occupied()) {
            return null;
        }
        if (legacy != null || findByEntity(parse(record.id())) != null) {
            return "already_exists";
        }
        AgentRecord copy = record.copy();
        copy.setAgentKey("");
        copy.setStatus(LEGACY_UNBOUND);
        legacy = copy;
        return null;
    }

    /**
     * 由管理员显式指定成员。成功返回 null。
     * 不会把旧 NPC 自动分给某个成员。
     */
    public String adoptLegacy(String agentId) {
        if (!AgentMessages.validAgentId(agentId)) {
            return "invalid";
        }
        if (legacy == null || !legacy.occupied()) {
            return "no_legacy";
        }
        if (agents.containsKey(agentId)) {
            return "already_exists";
        }
        legacy.setAgentKey(agentId);
        legacy.setStatus(ACTIVE);
        agents.put(agentId, legacy);
        legacy = null;
        return null;
    }

    public List<Map<String, String>> exportAgents() {
        List<Map<String, String>> out = new ArrayList<>();
        for (AgentRecord record : agents.values()) {
            out.add(record.fields());
        }
        return out;
    }

    public Map<String, String> exportLegacy() {
        return legacy == null ? null : legacy.fields();
    }

    public void replace(List<AgentRecord> records, AgentRecord legacyRecord, boolean imported) {
        agents.clear();
        legacy = null;
        if (records != null) {
            for (AgentRecord record : records) {
                if (record == null || !record.occupied() || !AgentMessages.validAgentId(record.agentKey())) {
                    continue;
                }
                if (agents.containsKey(record.agentKey())) {
                    continue;
                }
                agents.put(record.agentKey(), record);
            }
        }
        if (legacyRecord != null && legacyRecord.occupied() && legacyRecord.agentKey().isEmpty()) {
            legacyRecord.setStatus(LEGACY_UNBOUND);
            legacy = legacyRecord;
        }
        legacyImported = imported;
    }

    private static UUID parse(String id) {
        if (id == null || id.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
