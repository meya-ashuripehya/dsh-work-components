package com.trix.gamebot.bridge.compat;

import com.trix.gamebot.bridge.compat.api.AdapterSelector;
import com.trix.gamebot.bridge.compat.api.AgentActionContext;
import com.trix.gamebot.bridge.compat.api.AgentInteractionAdapter;
import com.trix.gamebot.bridge.compat.api.RegisterAgentAdaptersEvent;
import com.trix.gamebot.bridge.compat.farmersdelight.FarmersDelightAdapter;
import com.trix.gamebot.bridge.compat.vanilla.VanillaAdapter;
import net.neoforged.fml.ModList;
import net.neoforged.neoforge.common.NeoForge;

import java.util.ArrayList;
import java.util.List;

public final class AgentAdapterRegistry {
    private static final List<AgentInteractionAdapter> ADAPTERS = new ArrayList<>();
    private static boolean booted;

    private AgentAdapterRegistry() {
    }

    public static void bootstrap() {
        if (booted) {
            return;
        }
        booted = true;
        register(new VanillaAdapter());
        register(new FarmersDelightAdapter());
        NeoForge.EVENT_BUS.post(new RegisterAgentAdaptersEvent(AgentAdapterRegistry::register));
    }

    public static void register(AgentInteractionAdapter adapter) {
        if (adapter == null || adapter.id() == null || adapter.id().isBlank()) {
            return;
        }
        ADAPTERS.removeIf(existing -> existing.id().equals(adapter.id()));
        ADAPTERS.add(adapter);
    }

    public static AgentInteractionAdapter resolve(AgentActionContext context) {
        return AdapterSelector.select(
                List.copyOf(ADAPTERS),
                AgentAdapterRegistry::loaded,
                AgentInteractionAdapter::priority,
                adapter -> adapter.supports(context),
                AgentInteractionAdapter::id
        );
    }

    public static boolean loaded(AgentInteractionAdapter adapter) {
        String modId = adapter.requiredMod();
        if (modId == null || modId.isBlank()) {
            return true;
        }
        return ModList.get().isLoaded(modId);
    }

    static void resetForTests() {
        ADAPTERS.clear();
        booted = false;
    }
}
