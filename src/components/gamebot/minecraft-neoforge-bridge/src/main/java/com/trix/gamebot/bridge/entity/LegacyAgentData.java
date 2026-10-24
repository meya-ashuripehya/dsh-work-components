package com.trix.gamebot.bridge.entity;

import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.saveddata.SavedData;

/** 只读旧的 minaret_agent。不要 setDirty，避免把旧文件改写成新格式。 */
public final class LegacyAgentData extends SavedData {
    private final AgentRecord record = new AgentRecord();

    public static SavedData.Factory<LegacyAgentData> factory() {
        return new SavedData.Factory<>(LegacyAgentData::new, LegacyAgentData::load);
    }

    private static LegacyAgentData load(CompoundTag tag, HolderLookup.Provider provider) {
        LegacyAgentData data = new LegacyAgentData();
        data.record.read(tag);
        if (data.record.occupied() && data.record.agentKey().isEmpty()) {
            data.record.setStatus(AgentTable.LEGACY_UNBOUND);
        }
        return data;
    }

    public AgentRecord record() {
        return record;
    }

    @Override
    public CompoundTag save(CompoundTag tag, HolderLookup.Provider provider) {
        record.write(tag);
        return tag;
    }
}
