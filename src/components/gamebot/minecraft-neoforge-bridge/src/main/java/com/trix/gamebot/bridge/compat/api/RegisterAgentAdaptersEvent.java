package com.trix.gamebot.bridge.compat.api;

import net.neoforged.bus.api.Event;

import java.util.function.Consumer;

/** 附属模组在 NeoForge 事件总线上注册适配器，不必改 Minaret 核心。 */
public final class RegisterAgentAdaptersEvent extends Event {
    private final Consumer<AgentInteractionAdapter> registrar;

    public RegisterAgentAdaptersEvent(Consumer<AgentInteractionAdapter> registrar) {
        this.registrar = registrar;
    }

    public void register(AgentInteractionAdapter adapter) {
        if (adapter != null) {
            registrar.accept(adapter);
        }
    }
}
