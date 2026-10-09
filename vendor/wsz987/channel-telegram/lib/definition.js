import { ControlError } from '@wsz987/channel-control';
import { Config, TELEGRAM_BOT_TOKEN_REF } from './config.js';
import { TelegramAdapter } from './adapter.js';
/** Allowed non-secret nested sub-config keys merged by saveConfig. */
const NESTED_KEYS = ['reconnect', 'dedup', 'streaming', 'typing', 'formatting'];
/** Allowed non-secret top-level scalar keys merged by saveConfig. */
const SCALAR_KEYS = [
    'accountId',
    'baseUrl',
    'timeoutMs',
    'longPollTimeoutMs',
    'maxDownloadBytes',
];
/** Deep-copy a TelegramConfig into an independent mutable snapshot. */
function snapshotOf(config) {
    return {
        ...config,
        reconnect: { ...config.reconnect },
        dedup: { ...config.dedup },
        streaming: { ...config.streaming },
        typing: { ...config.typing },
        formatting: { ...config.formatting },
    };
}
function applyScalarPatch(snapshot, key, value) {
    switch (key) {
        case 'accountId':
            if (typeof value === 'string' && value)
                snapshot.accountId = value;
            return;
        case 'baseUrl':
            if (typeof value === 'string' && value)
                snapshot.baseUrl = value;
            return;
        case 'timeoutMs':
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                snapshot.timeoutMs = Math.floor(value);
            }
            return;
        case 'longPollTimeoutMs':
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                snapshot.longPollTimeoutMs = Math.floor(value);
            }
            return;
        case 'maxDownloadBytes':
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                snapshot.maxDownloadBytes = Math.floor(value);
            }
            return;
    }
}
/**
 * Build the telegram ChannelDefinition for the control plane. Returns a fresh
 * object each call (cheap) so a plugin can register it against any control
 * instance.
 */
export function createTelegramDefinition(options) {
    const credentials = options.credentials;
    const deps = options.deps ?? {};
    // Mutable snapshot: saveConfig merges non-secret patches into this; the same
    // object feeds getConfiguredState + createAdapter so both always agree.
    const state = snapshotOf(options.config);
    const tokenRef = () => state.tokenRef || TELEGRAM_BOT_TOKEN_REF;
    const setup = {
        fields: [
            {
                name: 'token',
                kind: 'secret',
                secret: true,
                configured: false,
                writable: true,
                ref: tokenRef(),
            },
        ],
        authMethods: ['credentials'],
        setupUrl: 'https://t.me/BotFather',
    };
    const configuredState = async () => {
        const described = await credentials.describe(tokenRef());
        return {
            configured: described.configured,
            fields: {
                token: {
                    configured: described.configured,
                    writable: described.writable,
                    source: described.source,
                },
            },
        };
    };
    const saveConfig = async (patch) => {
        for (const key of NESTED_KEYS) {
            const value = patch[key];
            if (value && typeof value === 'object') {
                Object.assign(state[key], value);
            }
        }
        for (const key of SCALAR_KEYS) {
            if (patch[key] !== undefined) {
                applyScalarPatch(state, key, patch[key]);
            }
        }
        if (patch.enabled !== undefined)
            state.enabled = Boolean(patch.enabled);
        // `token` / `tokenRef` are secret fields and are rejected by the control
        // plane before reaching this definition; nothing to persist here.
    };
    const restoreConfig = async (saved) => {
        // Schemastery validates and normalizes the persisted control-plane value.
        const restored = snapshotOf(Config(saved));
        Object.assign(state, restored);
        state.reconnect = restored.reconnect;
        state.dedup = restored.dedup;
        state.streaming = restored.streaming;
        state.typing = restored.typing;
        state.formatting = restored.formatting;
    };
    const createAdapter = async () => {
        const resolved = await credentials.resolve(tokenRef());
        const token = resolved?.value;
        if (!token) {
            throw new ControlError('CONTROL_ERROR', `telegram credential "${tokenRef()}" is not configured`);
        }
        return new TelegramAdapter(state, { ...deps, token });
    };
    return {
        id: 'telegram',
        get enabled() {
            return state.enabled;
        },
        async setEnabled(enabled) {
            state.enabled = enabled;
            await options.persistEnabled?.(enabled);
        },
        setup,
        getConfiguredState: configuredState,
        saveConfig,
        snapshotConfig: () => snapshotOf(state),
        restoreConfig,
        createAdapter,
        autoStart: true,
        // Telegram entities are mapped to a reliable mentionedBot activation fact;
        // new group rules default to requiring an explicit bot mention.
        access: {
            directMessages: true,
            groups: true,
            mentions: true,
            ownerDiscovery: 'claim',
            identityLabels: { user: 'Telegram User ID', group: 'Telegram Chat ID' },
            defaults: { requireMention: true },
        },
    };
}
//# sourceMappingURL=definition.js.map