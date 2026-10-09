/**
 * Schemastery configuration for the channel-harness bridge.
 *
 * All deployment-related parameters are configurable here; defaults match the
 * v2 behavior (global default route, file-backed binding store with restart
 * recovery, throttled reply previews, bounded gateway concurrency).
 *
 * v2 routing (doc §30): the old `defaultAgentId` and top-level
 * `agentOptions` are gone. Agent selection resolves to an `AgentRouteSpec`
 * (preset / provider / model / maxTokens), with `agent.default` as the global
 * fallback and optional per-channel / per-account / per-conversation overrides.
 */
import Schema from '@deepseek-ai/schemastery';
const routeSchema = Schema.object({
    preset: Schema.string(),
    provider: Schema.string(),
    model: Schema.string(),
    maxTokens: Schema.natural(),
});
export const Config = Schema.object({
    agent: Schema.object({
        default: routeSchema,
    }),
    cwd: Schema.string().description('Working directory for new channel sessions (default: process.cwd())'),
    routing: Schema.object({
        mode: Schema.union(['global', 'channel', 'account', 'conversation']).default('global'),
        overrides: Schema.object({
            channel: Schema.dict(routeSchema),
            account: Schema.dict(routeSchema),
            conversation: Schema.dict(routeSchema),
        }),
    }),
    bindingStore: Schema.object({
        // File-backed by default so session bindings survive restarts; the file
        // path is resolved at runtime (`<channel-data-dir>/bindings.json`) so
        // bindings no longer depend on the process cwd.
        type: Schema.union(['memory', 'file']).default('file'),
        path: Schema.string(),
    }),
    workspace: Schema.object({
        mode: Schema.union(['channel-account', 'host-cwd', 'disabled']).default('channel-account'),
        root: Schema.string(),
        autoCreate: Schema.boolean().default(true),
    }),
    userQuestions: Schema.object({
        enabled: Schema.boolean().default(true),
        timeoutMs: Schema.natural().default(300000),
    }).default({ enabled: true, timeoutMs: 300000 }),
    reply: Schema.object({
        updateIntervalMs: Schema.natural().default(200),
        maxTextLength: Schema.natural(),
        splitParagraphs: Schema.boolean().default(true),
        splitCodeBlocks: Schema.boolean().default(true),
        finalFlush: Schema.boolean().default(true),
        // [dsh-workbench patch] interleaved segments for channels that alternate thinking/tools/text.
        sendReasoning: Schema.boolean().default(false),
        showToolCalls: Schema.boolean().default(true),
        reasoningMaxChars: Schema.natural().default(1500),
    }),
    maxConcurrency: Schema.natural().default(4),
    drainTimeoutMs: Schema.natural().default(5000),
    includeMetadataPrefix: Schema.boolean().default(false),
    inboundPreempt: Schema.boolean().default(false),
});
//# sourceMappingURL=config.js.map