/**
 * Channel Workspace resolver.
 *
 * Maps a channel conversation identity to the Session working directory and
 * (optionally) a Harness `WorkspaceRegistry` member. The default
 * `channel-account` mode gives every channel/account pair its own workspace
 * under `<dsh-home>/workspaces/channels/<channel>/<account-key>`; `host-cwd`
 * keeps the Host's real working directory; `disabled` returns nothing (the
 * bridge falls back to `config.cwd ?? process.cwd()`).
 *
 * This module deliberately uses *structural* types for the official
 * `@deepseek-ai/dsh-workspace` entities and service (`WorkspaceRegistryLike`,
 * `ChannelWorkspaceLike`) instead of importing the package — the harness
 * exposes the service on `ctx` at runtime, and the official package is not a
 * dependency of this repo (see {@link WorkspaceRegistryLike}).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { channelWorkspaceTitle, safeSegment, stableSafeAccountKey } from './channel-label.js';
import { resolveDshHome } from './dsh-home.js';
/**
 * Resolves the channel workspace root. Defaults to
 * `<dsh-home>/workspaces/channels` when `config.root` is not set.
 */
export function resolveChannelWorkspaceRoot(config) {
    return config?.root ?? join(resolveDshHome(), 'workspaces', 'channels');
}
/**
 * Default effective workspace config used when the schema default did not
 * apply (i.e. `config.workspace` validated as `undefined`): group by
 * channel/account with auto-create enabled.
 */
const DEFAULT_WORKSPACE_CONFIG = { mode: 'channel-account', autoCreate: true };
/**
 * Harness-backed resolve implementation grouping by channel + account.
 *
 * `config` may be `undefined` when the schema default did not apply; it is
 * treated as {@link DEFAULT_WORKSPACE_CONFIG}.
 */
export class HarnessChannelWorkspaceResolver {
    ctx;
    config;
    logger;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
    }
    /** Structural access to the official `workspaceRegistry` on `ctx`. */
    registry() {
        return this.ctx.get('workspaceRegistry');
    }
    effectiveConfig() {
        return this.config ?? DEFAULT_WORKSPACE_CONFIG;
    }
    isSessionArchived(sessionId) {
        try {
            return this.registry()?.archivedSessionIds?.some((id) => String(id) === sessionId) ?? false;
        }
        catch (error) {
            this.logger.warn('[channel-harness] failed to inspect archived sessions', error);
            return false;
        }
    }
    async resolve(input) {
        const config = this.effectiveConfig();
        if (config.mode === 'disabled') {
            return {};
        }
        if (config.mode === 'host-cwd') {
            const cwd = process.cwd();
            const workspace = await this.registry()?.resolveByPath(cwd).catch(() => undefined);
            if (workspace) {
                this.logger.debug('[channel-harness] workspace resolved', {
                    cwd,
                    workspaceId: workspace.id,
                    title: workspace.title,
                });
            }
            return workspace ? { cwd, workspace } : { cwd };
        }
        const root = resolveChannelWorkspaceRoot(config);
        const accountKey = stableSafeAccountKey(input.accountId);
        const cwd = join(root, safeSegment(input.channelId), accountKey);
        // The official create() requires an existing directory (it realpaths), so
        // make sure the directory exists before resolving/creating the workspace.
        await mkdir(cwd, { recursive: true });
        const title = channelWorkspaceTitle({ channelId: input.channelId, accountId: input.accountId });
        let workspace = await this.registry()?.resolveByPath(cwd).catch(() => undefined);
        const registry = this.registry();
        if (!workspace && registry && config.autoCreate) {
            workspace = await registry.create(cwd, title);
        }
        this.logger.debug('[channel-harness] workspace resolved', {
            cwd,
            workspaceId: workspace?.id,
            title,
        });
        return { cwd, workspace };
    }
}
//# sourceMappingURL=workspace-resolver.js.map