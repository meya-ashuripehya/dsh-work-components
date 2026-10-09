/**
 * `ChannelService` — the Cordis Service mounted at `ctx.channels`.
 *
 * Registry + typed event subscription for the whole channel runtime.
 * Per architecture §20, v1 keeps channel events inside the service (typed
 * listeners) instead of registering every platform behavior as a global
 * Cordis event; `channels/event` + `channels/status` global surfaces can be
 * added later when third-party observation is needed.
 */
import { Service } from '@deepseek-ai/cordis';
import { AdapterRegistry } from './registry.js';
import { conversationKey } from './account.js';
import { MemorySecretStore } from './secrets.js';
import { MemoryStorage } from './storage.js';
import { channelEventEnvelopeSchema } from './schema.js';
export class ChannelService extends Service {
    /** Stable registry of live adapters. */
    registry = new AdapterRegistry();
    /** Durable SecretStore + ChannelStorage shared by every mounted adapter. */
    resources;
    listeners = new Set();
    constructor(ctx, options = {}) {
        super(ctx, 'channels');
        this.resources = {
            secrets: options.resources?.secrets ?? new MemorySecretStore(),
            storage: options.resources?.storage ?? new MemoryStorage(),
        };
    }
    /**
     * Build a complete ChannelAdapterContext bound to this service's shared
     * resources. Adapters use this instead of hand-rolling emit/logger/secrets/
     * storage/signal so every platform mounts against the same durable backend.
     */
    createAdapterContext(options) {
        const loggerName = options.channelId ? 'channel-' + options.channelId : 'channels';
        return {
            emit: (event) => this.emit(event),
            logger: this.ctx.logger(loggerName),
            secrets: this.resources.secrets,
            storage: this.resources.storage,
            signal: options.signal,
        };
    }
    /** Register an adapter; returns an unregister disposer. */
    register(adapter) {
        return this.registry.register(adapter);
    }
    get(id) {
        return this.registry.get(id);
    }
    list() {
        return this.registry.list();
    }
    /**
     * Subscribe to adapter events. The returned disposer removes the listener;
     * the listener set is also cleared when this service fiber unloads.
     */
    on(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Deliver one adapter event to every registered listener. Async listeners
     * are awaited; a sync throw or rejected promise never blocks the other
     * listeners, but every rejection is logged and the first one is rethrown
     * so the error surfaces to the caller instead of being lost.
     */
    async emit(event) {
        const results = await Promise.allSettled([...this.listeners].map((listener) => Promise.resolve().then(() => listener(event))));
        let firstError;
        for (const result of results) {
            if (result.status !== 'rejected')
                continue;
            try {
                this.ctx.logger('channels').error('[channels] listener failed while emitting an event', result.reason);
            }
            catch {
                console.error('[channels] listener failed while emitting an event', result.reason);
            }
            if (firstError === undefined)
                firstError = result.reason;
        }
        if (firstError !== undefined)
            throw firstError;
    }
    /** Resolve the canonical conversation key (shared with the bridge). */
    key(conversation) {
        return conversationKey(conversation);
    }
}
/** Runtime type guard for events entering the service. */
export function isChannelEvent(value) {
    return channelEventEnvelopeSchema.safeParse(value).success;
}
//# sourceMappingURL=service.js.map