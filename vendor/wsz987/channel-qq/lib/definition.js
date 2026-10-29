import { ControlError } from '@wsz987/channel-control';
import { createHash } from 'node:crypto';
import { QQ_APP_SECRET_REF } from './config.js';
import { QQAdapter } from './adapter.js';
/**
 * Non-secret config keys saveConfig() applies onto the internal config snapshot.
 * Mirrors QQConfig but omits `enabled` / `appSecretRef` (the reference is
 * wired at construction and never rewritten via saveConfig). Unknown keys in a
 * patch are ignored — the control plane already rejects secret keys before the
 * definition is reached (SECRET_FIELD_REJECTED).
 */
const SAVABLE_KEYS = [
    'appId',
    'markdownSupport',
    'streaming',
    'dedup',
    'startupTimeoutMs',
    'accountId',
];
/** Deep-ish clone of the mutable top-level config sub-objects. */
function cloneSnapshot(config) {
    return {
        ...config,
        streaming: { ...config.streaming },
        dedup: { ...config.dedup },
    };
}
/**
 * Official QQ bot console — one-step entry straight to the QQ openclaw bot page
 * (not the q.qq.com homepage). When the bot's appId is known the link deep-links
 * to that bot (`?appid=`), mirroring the openclaw-toolkit desktop console.
 */
export const QQ_OPEN_PLATFORM_URL = 'https://q.qq.com/qqbot/openclaw/';
export function qqConsoleUrl(appId) {
    const id = appId?.trim();
    return id ? `${QQ_OPEN_PLATFORM_URL}?appid=${encodeURIComponent(id)}` : QQ_OPEN_PLATFORM_URL;
}
/**
 * Opaque, non-secret directory scope for one QQ AppID. It partitions observed
 * group_openid identities when an operator replaces the Bot AppID while
 * keeping the same local channel account. The value is never sent to the Web
 * and never participates in ACL authorization.
 */
export function qqConversationScopeFingerprint(appId) {
    const normalized = appId.trim();
    if (!normalized)
        return undefined;
    return createHash('sha256').update(`qq-app:${normalized}`).digest('hex');
}
/** Validate + clamp one non-secret patch value onto the snapshot. */
function applyPatch(snapshot, key, value) {
    switch (key) {
        case 'appId':
            if (typeof value === 'string')
                snapshot.appId = value;
            return;
        case 'markdownSupport':
            if (typeof value === 'boolean')
                snapshot.markdownSupport = value;
            return;
        case 'startupTimeoutMs':
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                snapshot.startupTimeoutMs = Math.floor(value);
            }
            return;
        case 'accountId':
            if (typeof value === 'string' && value)
                snapshot.accountId = value;
            return;
        case 'streaming':
            if (typeof value === 'object' && value !== null) {
                const part = value;
                if (typeof part?.enabled === 'boolean')
                    snapshot.streaming.enabled = part.enabled;
                if (typeof part?.throttleMs === 'number' && Number.isFinite(part.throttleMs)) {
                    snapshot.streaming.throttleMs = Math.max(300, Math.floor(part.throttleMs));
                }
            }
            return;
        case 'dedup':
            if (typeof value === 'object' && value !== null) {
                const part = value;
                if (typeof part?.enabled === 'boolean')
                    snapshot.dedup.enabled = part.enabled;
                if (typeof part?.windowMs === 'number' && Number.isFinite(part.windowMs)) {
                    snapshot.dedup.windowMs = Math.max(0, Math.floor(part.windowMs));
                }
            }
            return;
    }
}
/**
 * Build the QQ `ChannelDefinition`. The returned definition reads from a
 * mutable internal config snapshot (updated by saveConfig) so persisted patches
 * are reflected by createAdapter() and getConfiguredState().
 */
export function createQQDefinition(options) {
    // Internal mutable config snapshot; saveConfig mutates it, createAdapter reads it.
    const snapshot = cloneSnapshot(options.config);
    const appSecretRef = snapshot.appSecretRef || QQ_APP_SECRET_REF;
    // Static setup surface. The appSecret field's configured/writable flags are
    // best-effort here (a synchronous property cannot await describe()); the
    // authoritative dynamic state is reported by getConfiguredState().
    const fields = [
        {
            name: 'appId',
            kind: 'text',
            secret: false,
            configured: Boolean(snapshot.appId),
            writable: true,
        },
        {
            name: 'appSecret',
            kind: 'secret',
            secret: true,
            configured: false,
            writable: true,
            ref: appSecretRef,
        },
    ];
    const setup = {
        fields,
        authMethods: ['credentials'],
        setupUrl: qqConsoleUrl(snapshot.appId),
    };
    const refreshSetup = () => {
        setup.fields[0].configured = Boolean(snapshot.appId);
        setup.setupUrl = qqConsoleUrl(snapshot.appId);
    };
    return {
        id: 'qq',
        get enabled() {
            return snapshot.enabled;
        },
        async setEnabled(enabled) {
            snapshot.enabled = enabled;
            await options.persistEnabled?.(enabled);
        },
        setup,
        autoStart: true,
        // QQ platform restricts C2C private messages to the bot creator. The
        // control plane materializes that narrow private grant; groups stay closed
        // until the operator explicitly configures them.
        access: {
            directMessages: true,
            groups: true,
            // New QQ gateway distinguishes GROUP_AT_MESSAGE_CREATE from ordinary
            // GROUP_MESSAGE_CREATE; the mapper publishes this as a strict boolean
            // activation fact.
            mentions: true,
            // QQ platform restricts C2C to the bot creator, so the owner never
            // claims locally; the control plane materializes that private grant.
            ownerDiscovery: 'platform',
            // QQ only exposes the canonical group_openid reliably. The Web lists
            // group OpenIDs discovered from inbound events; it never asks operators
            // to type a QQ group number or guesses an identity from one.
            identityLabels: { user: 'QQ', group: 'QQ群' },
            identity: {
                conversation: {
                    conversationDiscoverable: true,
                },
            },
            defaults: { requireMention: true },
        },
        async getConfiguredState() {
            const appId = Boolean(snapshot.appId);
            let appSecret = {
                configured: false,
                writable: false,
            };
            if (appSecretRef) {
                const described = await options.credentials.describe(appSecretRef);
                appSecret = {
                    configured: described.configured,
                    writable: described.writable,
                    source: described.source,
                };
            }
            return {
                configured: appId && appSecret.configured,
                fields: {
                    appId: { configured: appId, writable: true, value: snapshot.appId },
                    appSecret: {
                        configured: appSecret.configured,
                        writable: appSecret.writable,
                        source: appSecret.source,
                    },
                },
            };
        },
        async saveConfig(patch) {
            for (const key of Object.keys(patch)) {
                if (SAVABLE_KEYS.includes(key)) {
                    applyPatch(snapshot, key, patch[key]);
                }
                // Unknown (incl. secret) keys are ignored; the control plane already
                // rejects secret field names before reaching the definition.
            }
            refreshSetup();
            if (patch.appId !== undefined)
                await options.persistSetup?.({ appId: snapshot.appId });
        },
        conversationScopeFingerprint: () => qqConversationScopeFingerprint(snapshot.appId),
        snapshotConfig: () => cloneSnapshot(snapshot),
        async restoreConfig(saved) {
            const restored = cloneSnapshot(saved);
            Object.assign(snapshot, restored);
            snapshot.streaming = restored.streaming;
            snapshot.dedup = restored.dedup;
            refreshSetup();
            await options.persistSetup?.({ appId: snapshot.appId });
        },
        async createAdapter() {
            const credential = appSecretRef !== undefined ? await options.credentials.resolve(appSecretRef) : undefined;
            if (!credential) {
                // Stable machine-readable error; never echoes the secret, only the ref.
                throw new ControlError('CONTROL_ERROR', `QQ credential "${appSecretRef}" is not configured`);
            }
            return new QQAdapter(snapshot, {
                ...options.deps,
                appSecret: credential.value,
                onOwnerDiscovered: (ownerId) => options.persistOwnerIdentity?.(ownerId, snapshot.accountId, snapshot.appId),
            });
        },
        resolveOwnerIdentity: async (accountId) => options.resolveOwnerIdentity?.(accountId, snapshot.appId),
    };
}
//# sourceMappingURL=definition.js.map