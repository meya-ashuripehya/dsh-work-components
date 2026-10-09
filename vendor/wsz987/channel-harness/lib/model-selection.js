import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
export class ChannelModelSelectionController {
    rootCtx;
    refs = new WeakMap();
    /**
     * The owner strategy is fixed when the Agent scope is installed. The Host
     * service itself is resolved live so HMR can replace its implementation
     * without changing ownership of an existing Agent.
     */
    strategies = new WeakMap();
    constructor(rootCtx) {
        this.rootCtx = rootCtx;
    }
    get mode() {
        return this.hostSessionController() ? 'host' : 'local';
    }
    /** Install only the headless hook; Web Host owns it when sessionController is present. */
    install(agentCtx) {
        const strategy = this.mode;
        this.strategies.set(agentCtx, strategy);
        if (strategy === 'host') {
            return () => {
                if (this.strategies.get(agentCtx) === strategy)
                    this.strategies.delete(agentCtx);
            };
        }
        const ref = { current: undefined, assembled: undefined };
        const dispose = installModelSelection(agentCtx, ref);
        this.refs.set(agentCtx, ref);
        return () => {
            dispose();
            if (this.refs.get(agentCtx) === ref)
                this.refs.delete(agentCtx);
            if (this.strategies.get(agentCtx) === strategy)
                this.strategies.delete(agentCtx);
        };
    }
    async current(agent) {
        return this.readLocal(agent);
    }
    async selectionForStep(agent) {
        if (this.strategyFor(agent) === 'local') {
            const ref = this.refs.get(agent.ctx);
            if (ref?.assembled)
                return ref.assembled;
        }
        return this.current(agent);
    }
    async select(agent, selection) {
        if (this.strategyFor(agent) === 'host') {
            const controller = this.hostSessionController();
            if (!controller) {
                throw new Error('host model selection is unavailable: sessionController is not mounted');
            }
            try {
                await controller.selectModel({
                    sessionId: agent.id,
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
                });
            }
            catch (error) {
                throw new Error(`model selection was rejected: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
        }
        const ref = this.refs.get(agent.ctx);
        if (!ref)
            throw new Error(`model selection is not installed for session '${String(agent.id)}'`);
        ref.current = selection;
        try {
            await this.rootCtx.get('agentDefaultModel')?.saveSelection(selection);
        }
        catch {
            // The current-session switch already holds; default persistence is best effort.
        }
    }
    hostSessionController() {
        return this.rootCtx.get('sessionController');
    }
    /**
     * Agents configured through the bridge always have a recorded strategy.
     * Keep the deployment-wide mode as a compatibility fallback for direct
     * controller callers that have not installed the Agent-scoped hook.
     */
    strategyFor(agent) {
        return this.strategies.get(agent.ctx) ?? this.mode;
    }
    readLocal(agent) {
        const picked = this.refs.get(agent.ctx)?.current;
        if (picked)
            return picked;
        const headerConfig = agent.session.requestHeader?.()?.config;
        if (headerConfig?.provider && headerConfig.model) {
            return {
                provider: headerConfig.provider,
                model: headerConfig.model,
                ...(headerConfig.reasoningEffort ? { reasoningEffort: ReasoningEffortId(String(headerConfig.reasoningEffort)) } : {}),
            };
        }
        const { provider, model } = agent.options;
        if (provider && model)
            return { provider, model };
        const defaults = agent.ctx.get('agentDefaultModel')?.currentSelection();
        if (!defaults?.provider || !defaults.model)
            return undefined;
        return {
            provider: defaults.provider,
            model: defaults.model,
            ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
        };
    }
}
//# sourceMappingURL=model-selection.js.map