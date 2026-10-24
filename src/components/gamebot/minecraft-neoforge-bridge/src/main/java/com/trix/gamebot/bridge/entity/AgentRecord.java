package com.trix.gamebot.bridge.entity;

import net.minecraft.nbt.CompoundTag;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** 一个 NPC 的存档记录。实体 UUID 在 id；成员编码在 agentKey。旧存档没有 agentKey。 */
public final class AgentRecord {
    private String id = "";
    private String agentKey = "";
    private String status = AgentTable.ACTIVE;
    private String name = "";
    private String dimension = "";
    private double x;
    private double y;
    private double z;
    private boolean hasPosition;

    public boolean occupied() {
        return !id.isEmpty();
    }

    public String id() {
        return id;
    }

    public String agentKey() {
        return agentKey;
    }

    public String status() {
        return status;
    }

    public boolean legacyUnbound() {
        return AgentTable.LEGACY_UNBOUND.equals(status) || (occupied() && agentKey.isEmpty());
    }

    public void setAgentKey(String agentKey) {
        this.agentKey = agentKey == null ? "" : agentKey;
    }

    public void setStatus(String status) {
        this.status = status == null || status.isBlank() ? AgentTable.ACTIVE : status;
    }

    public void rename(String agentName) {
        name = agentName == null ? "" : agentName;
    }

    public String name() {
        return name;
    }

    public String dimension() {
        return dimension;
    }

    public double x() {
        return x;
    }

    public double y() {
        return y;
    }

    public double z() {
        return z;
    }

    public boolean hasPosition() {
        return hasPosition;
    }

    public boolean owns(UUID uuid) {
        return uuid != null && occupied() && id.equals(uuid.toString());
    }

    /** 成功返回 null。已有 NPC 时返回 already_exists。 */
    public String tryAssign(String agentId, String agentName, String dimensionId) {
        if (agentId == null || agentId.isBlank()) {
            return "invalid";
        }
        if (occupied()) {
            return "already_exists";
        }
        id = agentId;
        name = agentName == null ? "" : agentName;
        dimension = dimensionId == null ? "" : dimensionId;
        hasPosition = false;
        return null;
    }

    public void clear() {
        id = "";
        agentKey = "";
        status = AgentTable.ACTIVE;
        name = "";
        dimension = "";
        x = 0;
        y = 0;
        z = 0;
        hasPosition = false;
    }

    public boolean remember(String dimensionId, double posX, double posY, double posZ) {
        boolean moved = !hasPosition
                || !dimension.equals(dimensionId)
                || Math.abs(x - posX) >= 1.0
                || Math.abs(y - posY) >= 1.0
                || Math.abs(z - posZ) >= 1.0;
        if (!moved) {
            return false;
        }
        dimension = dimensionId == null ? "" : dimensionId;
        x = posX;
        y = posY;
        z = posZ;
        hasPosition = true;
        return true;
    }

    public AgentRecord copy() {
        AgentRecord copy = new AgentRecord();
        copy.readFields(fields());
        return copy;
    }

    public Map<String, String> fields() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put("AgentId", id);
        out.put("AgentKey", agentKey);
        out.put("Status", status);
        out.put("Name", name);
        out.put("Dimension", dimension);
        out.put("HasPosition", Boolean.toString(hasPosition));
        out.put("X", Double.toString(x));
        out.put("Y", Double.toString(y));
        out.put("Z", Double.toString(z));
        return out;
    }

    public void readFields(Map<String, String> fields) {
        id = value(fields, "AgentId");
        name = value(fields, "Name");
        dimension = value(fields, "Dimension");
        hasPosition = Boolean.parseBoolean(value(fields, "HasPosition"));
        x = parseDouble(value(fields, "X"));
        y = parseDouble(value(fields, "Y"));
        z = parseDouble(value(fields, "Z"));
        if (fields.containsKey("AgentKey")) {
            agentKey = value(fields, "AgentKey");
        } else {
            agentKey = "";
        }
        if (fields.containsKey("Status")) {
            status = value(fields, "Status");
            if (status.isEmpty()) {
                status = AgentTable.ACTIVE;
            }
        } else {
            status = occupied() && agentKey.isEmpty() ? AgentTable.LEGACY_UNBOUND : AgentTable.ACTIVE;
        }
    }

    public void write(CompoundTag tag) {
        Map<String, String> fields = fields();
        tag.putString("AgentId", fields.get("AgentId"));
        tag.putString("AgentKey", fields.get("AgentKey"));
        tag.putString("Status", fields.get("Status"));
        tag.putString("Name", fields.get("Name"));
        tag.putString("Dimension", fields.get("Dimension"));
        tag.putBoolean("HasPosition", Boolean.parseBoolean(fields.get("HasPosition")));
        tag.putDouble("X", Double.parseDouble(fields.get("X")));
        tag.putDouble("Y", Double.parseDouble(fields.get("Y")));
        tag.putDouble("Z", Double.parseDouble(fields.get("Z")));
    }

    public void read(CompoundTag tag) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("AgentId", tag.getString("AgentId"));
        if (tag.contains("AgentKey")) {
            fields.put("AgentKey", tag.getString("AgentKey"));
        }
        if (tag.contains("Status")) {
            fields.put("Status", tag.getString("Status"));
        }
        fields.put("Name", tag.getString("Name"));
        fields.put("Dimension", tag.getString("Dimension"));
        fields.put("HasPosition", Boolean.toString(tag.getBoolean("HasPosition")));
        fields.put("X", Double.toString(tag.getDouble("X")));
        fields.put("Y", Double.toString(tag.getDouble("Y")));
        fields.put("Z", Double.toString(tag.getDouble("Z")));
        readFields(fields);
    }

    private static String value(Map<String, String> fields, String key) {
        String raw = fields.get(key);
        return raw == null ? "" : raw;
    }

    private static double parseDouble(String raw) {
        if (raw == null || raw.isEmpty()) {
            return 0;
        }
        return Double.parseDouble(raw);
    }
}
