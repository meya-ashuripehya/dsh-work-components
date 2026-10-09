/** Compare two routes structurally (used to detect binding route drift). */
export function routesEqual(a, b) {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    return (a.preset === b.preset &&
        a.provider === b.provider &&
        a.model === b.model &&
        a.maxTokens === b.maxTokens);
}
export class AgentRouter {
    config;
    constructor(config) {
        this.config = config;
    }
    resolve(input) {
        const overrides = this.config.routing.overrides;
        if (overrides) {
            const conversationAgent = overrides.conversation?.[input.conversationId];
            if (conversationAgent)
                return conversationAgent;
            const accountAgent = overrides.account?.[input.accountId];
            if (accountAgent)
                return accountAgent;
            const channelAgent = overrides.channel?.[input.channelId];
            if (channelAgent)
                return channelAgent;
        }
        return this.config.agent.default;
    }
}
//# sourceMappingURL=agent-router.js.map