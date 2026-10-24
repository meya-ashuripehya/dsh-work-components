package com.trix.gamebot.bridge.compat.api;

import com.trix.gamebot.bridge.action.ActionOutcome;

/** 模组交互适配器。缺失的模组不得在 supports 之外加载对方的类。 */
public interface AgentInteractionAdapter {
    String id();

    default String requiredMod() {
        return null;
    }

    default int priority() {
        return 0;
    }

    boolean supports(AgentActionContext context);

    ActionOutcome execute(AgentActionContext context);
}
