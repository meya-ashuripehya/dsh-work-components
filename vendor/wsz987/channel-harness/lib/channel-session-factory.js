import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { stableSafeAccountKey } from './channel-label.js';
import { toLoggableError } from './loggable-error.js';
import { bindingKey, SESSION_BINDING_SCHEMA_VERSION, } from './session-router.js';
/**
 * Owns the Channel Session lifecycle as one rollback-aware transaction:
 *
 * - `create` mints a fresh session id for a conversation without a binding;
 * - `recreate` brings an EXISTING binding's session back for explicitly
 *   EPHEMERAL bindings — the only caller is the bridge's ephemeral policy
 *   branch (re-running the workspaceResolver so the recreated session lands
 *   on the SAME channel Workspace cwd a first creation would have used, then
 *   re-attaching the workspace and keeping the durable binding). A live agent
 *   is borrowed as-is. A durable session that is MISSING behind a binding is
 *   NOT recreated here: the bridge fails loud with `SessionNotFoundError`
 *   (`/new` is the explicit repair path).
 *
 * cwd / workspace / binding are SESSION LIFECYCLE concerns, so both paths
 * live here — never in the generic AgentManager.
 */
export class ChannelSessionFactory {
    options;
    constructor(options) {
        this.options = options;
    }
    async create(conversation, route) {
        const sessionId = `ch-${randomUUID()}`;
        const resolved = await this.options.workspaceResolver.resolve(conversation);
        const cwd = this.effectiveCwd(resolved);
        this.options.logger.debug('[channel-harness] creating fresh session', {
            sessionId,
            channelId: conversation.channelId,
            cwd,
            workspaceId: resolved.workspace?.id,
        });
        const agentRef = await this.options.agentManager.create(sessionId, route, this.options.commandSetup, { cwd });
        const attachedWorkspace = await this.publishSession(sessionId, resolved, cwd, 'fresh');
        const now = Date.now();
        const binding = {
            channelId: conversation.channelId,
            accountId: conversation.accountId,
            conversationId: conversation.conversationId,
            // v3: stable conversation identity. The bridge populates this from the
            // event; when a caller omits it we fall back to the legacy dm default.
            conversationType: conversation.conversationType ?? 'dm',
            ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
            ...(conversation.senderId ? { senderId: conversation.senderId } : {}),
            sessionId,
            durability: this.options.agentManager.canResume() ? 'durable' : 'ephemeral',
            route,
            schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now,
        };
        await this.commitBinding(binding, attachedWorkspace);
        this.options.agentManager.registerBinding(binding);
        this.options.logger.info('[channel-harness] fresh channel session created', {
            sessionId,
            channelId: conversation.channelId,
            accountIdHash: stableSafeAccountKey(conversation.accountId),
            workspaceId: attachedWorkspace?.id,
            cwd,
            bindingKey: bindingKey(binding),
        });
        return { binding, agentRef };
    }
    /**
     * Recreate the session behind an EXISTING explicitly EPHEMERAL binding —
     * the "existing binding -> missing persistence -> recreate" case after a
     * process restart.
     *
     * A live agent in this process is borrowed as-is (nothing to recreate). On a
     * miss, the SAME session id is recreated exactly like a first creation:
     * workspaceResolver re-run (so `header.cwd` lands back on the channel
     * Workspace, never on the host cwd), workspace re-attached, and the durable
     * binding kept (only `updatedAt` refreshed, route snapshot reconciled).
     *
     * This is NEVER called for a durable session that is missing behind a
     * binding — that is a durability inconsistency the bridge fails loud on
     * (`SessionNotFoundError`; `/new` is the explicit repair).
     */
    async recreate(binding, route) {
        const sessionId = binding.sessionId;
        // Live agent loaded in this process -> borrow it, no state change.
        const live = await this.options.agentManager.borrowIfLive(sessionId, route, this.options.commandSetup);
        if (live) {
            this.options.logger.debug('[channel-harness] reused live session for existing binding', { sessionId, bindingKey: bindingKey(binding) });
            return { binding, agentRef: live };
        }
        const resolved = await this.options.workspaceResolver.resolve(this.conversationOf(binding));
        const cwd = this.effectiveCwd(resolved);
        this.options.logger.debug('[channel-harness] recreating session for existing binding', {
            sessionId,
            channelId: binding.channelId,
            cwd,
            workspaceId: resolved.workspace?.id,
        });
        const agentRef = await this.options.agentManager.create(sessionId, route, this.options.commandSetup, { cwd });
        const attachedWorkspace = await this.publishSession(sessionId, resolved, cwd, 'recreated');
        const now = Date.now();
        const refreshed = { ...binding, route, updatedAt: now };
        await this.commitBinding(refreshed, attachedWorkspace);
        this.options.agentManager.registerBinding(refreshed);
        this.options.logger.info('[channel-harness] channel session recreated (binding kept)', {
            sessionId,
            channelId: binding.channelId,
            accountIdHash: stableSafeAccountKey(binding.accountId),
            workspaceId: attachedWorkspace?.id,
            cwd,
            bindingKey: bindingKey(binding),
        });
        return { binding: refreshed, agentRef };
    }
    /** Rebuild the bindable conversation identity from a durable binding. */
    conversationOf(binding) {
        return {
            channelId: binding.channelId,
            accountId: binding.accountId,
            conversationId: binding.conversationId,
            conversationType: binding.conversationType,
            ...(binding.senderId ? { senderId: binding.senderId } : {}),
            ...(binding.threadId ? { threadId: binding.threadId } : {}),
        };
    }
    /** Resolved cwd with the same fallback chain used by fresh creation. */
    effectiveCwd(resolved) {
        return resolved.workspace?.path ?? resolved.cwd ?? this.options.cwd ?? process.cwd();
    }
    /**
     * Publish transaction tail shared by create/recreate: verify the created
     * agent reached `ctx.sessions` (dispose + throw when it did not), then
     * soft-attach the session to the resolved channel workspace (attach failure
     * is NON-FATAL — the session stays alive, grouped as ungrouped).
     */
    async publishSession(sessionId, resolved, cwd, kind) {
        const sessions = this.options.ctx.get('sessions');
        const liveSession = sessions?.get(SessionId(sessionId));
        if (sessions && !liveSession) {
            await this.options.agentManager.disposeSession(sessionId);
            throw new Error(`ctx.agents.create resolved but session '${sessionId}' is absent from ctx.sessions`);
        }
        this.options.logger.debug(`[channel-harness] ${kind} session published`, {
            sessionId,
            requestedCwd: cwd,
            sessionCwd: liveSession?.header.cwd,
            workspacePath: resolved.workspace?.path,
        });
        let attachedWorkspace;
        if (resolved.workspace) {
            try {
                await resolved.workspace.attachSession(SessionId(sessionId));
                attachedWorkspace = resolved.workspace;
                this.options.logger.debug('[channel-harness] workspace attached', {
                    sessionId,
                    workspaceId: resolved.workspace.id,
                });
            }
            catch (error) {
                this.options.logger.error('[channel-harness] workspace attach failed; keeping session alive', {
                    sessionId,
                    requestedCwd: cwd,
                    sessionCwd: liveSession?.header.cwd,
                    workspaceId: resolved.workspace.id,
                    workspacePath: resolved.workspace.path,
                    error: toLoggableError(error),
                });
            }
        }
        return attachedWorkspace;
    }
    /**
     * Persist the binding; on failure roll the transaction back (detach the
     * workspace, dispose the freshly created/recreated agent) and rethrow.
     */
    async commitBinding(binding, attachedWorkspace) {
        try {
            await this.options.bindingStore.put(binding);
        }
        catch (error) {
            await attachedWorkspace?.detachSession(SessionId(binding.sessionId)).catch(() => { });
            await this.options.agentManager.disposeSession(binding.sessionId);
            throw error;
        }
    }
}
//# sourceMappingURL=channel-session-factory.js.map