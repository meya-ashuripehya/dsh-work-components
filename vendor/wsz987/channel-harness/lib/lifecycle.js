import { SessionId } from '@deepseek-ai/dsh-session';
import { createBindingStore } from './binding-store.js';
import { AgentManager, HarnessAgentGateway, resolvePersistedInspection } from './agent-manager.js';
import { confirmBindTarget, resolveBindTarget } from './bind-support.js';
import { AgentRouter } from './agent-router.js';
import { ReplyRouter } from './reply-router.js';
import { ChannelHarnessBridge } from './bridge.js';
import { ChannelOutboxService } from './outbox/service.js';
import { OutboxError } from './outbox/types.js';
import { HarnessChannelWorkspaceResolver } from './workspace-resolver.js';
import { ReplyContextStore } from './reply-context-store.js';
import { installDebugConsoleExporter } from './debug-logger.js';
import { StoredChannelAccessPolicyResolver } from './access/resolver.js';
import { liveAttachmentProvider } from './file-provider.js';
import { createQuestionInteraction } from './interactions/question-backend.js';
export function startBridge(ctx, config, resolvePersistence) {
    installDebugConsoleExporter(ctx);
    const logger = ctx.logger('channel-harness');
    const channels = ctx.get('channels');
    const bindingStore = createBindingStore(config.bindingStore);
    const agentGateway = new HarnessAgentGateway(ctx, resolvePersistence);
    const agentManager = new AgentManager(agentGateway, logger, config.maxConcurrency);
    const agentRouter = new AgentRouter(config);
    const workspaceResolver = new HarnessChannelWorkspaceResolver(ctx, config.workspace, logger);
    const getAdapter = (channelId) => channels.get(channelId);
    const replyContexts = new ReplyContextStore();
    // Question answerer composition: the channel composes ONE PREPENDED answerer
    // on the official `user-questions/request` waterfall — headless it is
    // typically the only answerer; in the Web profile it must win over the
    // official Remote/Web answerer (which registers at boot, before this bridge)
    // or every channel-bound ask would be swallowed by the browser. A declined
    // presentation still delegates via `next()`. Everything lives in
    // interactions/question-backend.ts.
    const questionPresenter = config.userQuestions.enabled
        ? createQuestionInteraction({
            ctx,
            getUserQuestions: () => ctx.get('userQuestions'),
            agentManager,
            replyContexts,
            getAdapter,
            logger,
            timeoutMs: config.userQuestions.timeoutMs,
        })
        : undefined;
    questionPresenter?.start();
    // Optional attachment service -> real image path (WX5). Resolved LIVE at
    // every use, exactly like `sessionPersistence` above: the profile entry group
    // creates every row concurrently (`Promise.allSettled`), so a startup
    // snapshot can precede the service's own fiber. A deployment without an
    // attachment backend keeps today's fallback — the hook throws, `imageBlock`
    // catches, and the converter emits the deterministic text placeholder.
    const saveImage = async (input) => {
        const attachments = ctx.get('attachments');
        if (!attachments) {
            throw new Error('the Harness attachments service is not mounted');
        }
        return attachments.saveImage(input);
    };
    // Optional generic-file extension. Harness currently has a native image
    // service but no generic FileBlock/FileAttachment surface, so deployments
    // may provide this separately without coupling document parsers to the
    // bridge. The provider is resolved LIVE per call (see
    // `liveAttachmentProvider`): the bundle's `channels-files` row loads
    // concurrently with this plugin, and deleting that row must stay supported.
    const resolveFileProvider = () => ctx.get('channelFiles');
    const fileProvider = liveAttachmentProvider(resolveFileProvider);
    // Best-effort typing indicator wiring: a typing API failure must NEVER break
    // the inbound/outbound flow, so every call is fire-and-forget with a swallow.
    const startTyping = (sessionId, context) => {
        const binding = agentManager.bindingFor(sessionId);
        if (!binding)
            return;
        const adapter = getAdapter(binding.channelId);
        if (adapter?.startTypingForTarget && context) {
            void adapter.startTypingForTarget(typingTarget(binding, context)).catch(() => { });
            return;
        }
        if (adapter?.startTyping)
            void adapter.startTyping(binding.conversationId).catch(() => { });
    };
    const stopTyping = (sessionId, context) => {
        const binding = agentManager.bindingFor(sessionId);
        if (!binding)
            return;
        const adapter = getAdapter(binding.channelId);
        if (adapter?.stopTypingForTarget && context) {
            void adapter.stopTypingForTarget(typingTarget(binding, context)).catch(() => { });
            return;
        }
        if (adapter?.stopTyping)
            void adapter.stopTyping(binding.conversationId).catch(() => { });
    };
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const context = replyContexts.claim({
            sessionId: String(agent.session.id),
            messageId: String(message.id),
            turn,
        });
        startTyping(String(agent.session.id), context);
    });
    ctx.on('agent/inbox/discarded', ({ message }) => {
        // Resolve the session id BEFORE dropping the pending entry so we can
        // cancel any typing the (never-claimed) inbound would have triggered.
        const messageId = String(message.id);
        const sessionId = replyContexts.pendingSessionId(messageId);
        const context = replyContexts.pendingContext(messageId);
        replyContexts.discard(messageId);
        if (sessionId)
            stopTyping(sessionId, context);
    });
    const replyRouter = new ReplyRouter({
        config: config.reply,
        getAdapter,
        getBinding: (sessionId) => agentManager.bindingFor(sessionId),
        replyContexts,
        logger,
    });
    const stopListening = replyRouter.attach(ctx);
    // Deferred bridge reference: `commandDeps` routes the /new command backed by
    // the bridge back to the bridge's own fresh-session bootstrap. The arrow only
    // calls `bridge.startNewSession` at runtime (when a command actually runs), by
    // which point the bridge is assigned (definite-assignment assertion below).
    // Durable outbox: the proactive send path. The
    // binding authority is the DURABLE store (never AgentManager's hint cache),
    // and the adapter lookup + asset store are the same ones the reply pipeline
    // uses. Optional: absent -> the send_channel_message tool is not installed.
    const outbox = new ChannelOutboxService({
        bindingStore,
        getAdapter,
        // Live again: the resolver runs per send, so a provider mounted after the
        // bridge started (or an HMR replacement) is picked up instead of leaving
        // the outbox permanently without an attachment resolver (issue #7).
        attachmentResolver: async (attachmentId, sessionId) => {
            const provider = resolveFileProvider();
            if (!provider) {
                throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', 'outbound attachments require a private asset store that is not configured', { sessionId });
            }
            return provider.resolveAttachment(attachmentId, sessionId);
        },
        logger,
    });
    let bridge;
    const commandDeps = {
        startNewSession: (agent) => bridge.startNewSession(agent),
        // /mirror (issue #5): the toggle state lives on the durable binding.
        mirror: {
            get: async (agent) => (await bindingStore.findBySessionId(String(agent.id)))?.mirror === true,
            set: async (agent, on) => {
                const binding = await bindingStore.findBySessionId(String(agent.id));
                if (!binding)
                    throw new Error(`no session binding for '${String(agent.id)}'`);
                await bindingStore.put({ ...binding, mirror: on, updatedAt: Date.now() });
            },
        },
        // /bind (issue #6): fail-closed rebind support over the durable bindings
        // and the persisted session universe.
        bind: {
            resolve: (agent, query) => resolveBindTarget(agentGateway, bindingStore, agent, query),
            confirm: (agent, sessionId) => confirmBindTarget(agentGateway, bindingStore, agent, sessionId),
        },
    };
    // Fail-closed Access Gate: production ALWAYS resolves the
    // policy from the shared ChannelStorage and logs decisions on the
    // `channel-access` namespace. Reads once per inbound — no policy caching (§16).
    const accessResolver = new StoredChannelAccessPolicyResolver(() => channels.resources.storage);
    const accessLogger = ctx.logger('channel-access');
    bridge = new ChannelHarnessBridge({
        config,
        bindingStore,
        agentManager,
        agentRouter,
        getAdapter,
        replyContexts,
        logger,
        accessResolver,
        accessLogger,
        saveImage,
        fileProvider,
        ctx,
        commandDeps,
        workspaceResolver,
        outbox,
        questionPresenter,
    });
    const stopInbound = channels.on((event) => bridge.handleChannelEvent(event));
    let disposed = false;
    async function dispose() {
        if (disposed)
            return;
        disposed = true;
        // 1. Stop new inbound (adapter events no longer reach the bridge).
        stopInbound();
        // Cancel channel-owned question waits before draining the blocked Agent.
        await questionPresenter?.stop();
        // Release this bridge's Agent-scoped commands before a replacement bridge
        // can borrow the same live agents and install fresh handlers.
        await bridge.disposeCommandSetups();
        // 2. Drain active turns with a bounded wait (the session/event listener is
        //    still attached here, but we do NOT depend on it for final-reply
        //    correctness).
        await drainActiveTurns(agentManager, replyRouter, logger, config.drainTimeoutMs);
        // 3. RECONCILE replies from the Session durable log (final text delivery
        //    does NOT rely on the listener still being attached).
        await reconcileReplies(ctx, resolvePersistence, agentManager, replyRouter, logger);
        // 4. Finalize any replies still marked active whose turn/end never arrived.
        await replyRouter.flushAll();
        // 5. Stop listening to session/event.
        stopListening();
        // 6. Dispose owned agent handles (each exactly once).
        await agentManager.disposeAll();
        // 7. Dispose the reply router (clear timers).
        replyRouter.dispose();
    }
    return {
        dispose,
        handleChannelEvent: (event) => bridge.handleChannelEvent(event),
    };
}
function typingTarget(binding, context) {
    return {
        channelId: binding.channelId,
        accountId: binding.accountId,
        conversationId: binding.conversationId,
        threadId: binding.threadId,
        conversationType: context.conversationType,
        replyToMessageId: context.replyToMessageId,
        raw: context.raw,
        runId: context.runId,
    };
}
async function drainActiveTurns(agentManager, replyRouter, logger, drainTimeoutMs) {
    const sessionIds = replyRouter.activeSessions();
    if (sessionIds.length === 0)
        return;
    await Promise.all(sessionIds.map(async (sessionId) => {
        const ref = agentManager.refFor(sessionId);
        if (!ref)
            return;
        const timedOut = await withTimeout(ref.whenIdle(), drainTimeoutMs);
        if (timedOut) {
            logger.warn(`[channel-harness] drain timed out for session '${sessionId}'`);
        }
    }));
}
/**
 * Reconcile every active session's reply from the durable log. Reads the live
 * Session when it is still in the store; otherwise inspects persistence
 * (resolved LIVE at dispose time — the currently mounted backend, whatever
 * the bridge started with). Skips gracefully when neither is available.
 * Final-reply correctness comes from the Session log, not from the
 * still-attached event listener.
 */
async function reconcileReplies(ctx, resolvePersistence, agentManager, replyRouter, logger) {
    const sessionIds = agentManager.activeSessions();
    if (sessionIds.length === 0)
        return;
    const sessions = ctx.get('sessions');
    const persistence = resolvePersistence?.();
    for (const sessionId of sessionIds) {
        try {
            const live = sessions?.get(SessionId(sessionId));
            if (live) {
                await replyRouter.reconcileSession({ id: sessionId, events: live.snapshotEvents() });
                continue;
            }
            if (persistence) {
                // V3 persistence inspection uses the public read handle.
                const inspection = await resolvePersistedInspection(persistence, SessionId(sessionId));
                if (inspection) {
                    await replyRouter.reconcileSession({ id: sessionId, events: inspection.events });
                }
            }
            // else: no live session and no persistence — skip gracefully.
        }
        catch (error) {
            logger.warn(`[channel-harness] reconcile failed for session '${sessionId}'`, error);
        }
    }
}
/** Resolve true when the timeout elapses before the promise settles. */
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled)
                resolve(true);
        }, ms);
        promise.then(() => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(false);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(false);
        });
    });
}
//# sourceMappingURL=lifecycle.js.map