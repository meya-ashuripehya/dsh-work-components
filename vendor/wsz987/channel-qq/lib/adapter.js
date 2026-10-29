import { ChannelError, SecureRemoteMediaFetcher } from '@wsz987/channel-core';
import { InboundProcessor } from './inbound.js';
import { mapInteraction } from './interaction-mapper.js';
import { OutboundSender } from './outbound.js';
import { TencentQQSdkClient } from './sdk-client.js';
import { QQStreamingReply } from './streaming-reply.js';
import { manifest as qqManifest } from './manifest.js';
export class QQAdapter {
    config;
    id = 'qq';
    /** Upstream compatibility manifest (read structurally by `channels doctor`). */
    manifest = qqManifest;
    capabilities;
    /**
     * Test-only accessor exposing the injected `appSecret` so unit tests can
     * assert the resolved credential reached the adapter without triggering the
     * real Tencent client build. Produces no value in any production path.
     */
    get testAppSecret() {
        return this.deps.appSecret;
    }
    ctx;
    deps;
    now;
    client;
    inbound;
    outbound;
    started = false;
    connected = false;
    error;
    runPromise;
    constructor(config, deps = {}) {
        this.config = config;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.capabilities = {
            text: true,
            image: true,
            file: true,
            audio: true,
            video: true,
            markdown: config.markdownSupport,
            cards: false,
            reactions: false,
            threads: false,
            // Native inline keyboard round-trip (P1): `OutboundMessage.actions` →
            // QQ inline keyboard, button presses → `interaction.received`.
            interactiveActions: true,
            // Directional, per-kind media precision:
            // inbound 'bytes' — the inbound path hydrates every binary kind through
            // `SecureRemoteMediaFetcher` before emit (image/file/audio/video);
            // outbound 'bytes' — `sendMedia` uploads `localData` bytes via the SDK
            // `fileData` carrier for every kind (IMAGE / VOICE / VIDEO / FILE).
            media: {
                inbound: { image: 'bytes', file: 'bytes', audio: 'bytes', video: 'bytes' },
                outbound: { image: 'bytes', file: 'bytes', audio: 'bytes', video: 'bytes' },
            },
            // Conservative default; `resolveStreamingMode` upgrades C2C+msgId to
            // native streaming.
            streaming: 'buffered',
        };
    }
    resolveStreamingMode(target) {
        // `streaming.enabled: false` is a hard off-switch: it forces the buffered
        // send-once strategy even for a C2C target with a reply message id.
        if (!this.config.streaming.enabled) {
            return 'buffered';
        }
        if (target.conversationType === 'dm' && target.replyToMessageId) {
            return 'native';
        }
        return 'buffered';
    }
    async start(ctx) {
        if (this.started)
            return;
        this.ctx = ctx;
        this.connected = false;
        this.error = undefined;
        const ready = createDeferred();
        this.client =
            this.deps.sdkClient ??
                new TencentQQSdkClient(this.config, ctx.logger, requireAppSecret(this.deps.appSecret, this.config));
        this.inbound = new InboundProcessor({
            ctx,
            meta: { channel: this.id, accountId: this.config.accountId },
            dedupEnabled: this.config.dedup.enabled,
            dedupWindowMs: this.config.dedup.windowMs,
            secureFetch: this.deps.secureFetch,
            now: this.now,
        });
        this.outbound = new OutboundSender(this.client, ctx.logger);
        this.client.onReady(() => {
            this.connected = true;
            void this.emitAuth('authenticated');
            void this.emitConnection('connected');
            ready.resolve();
        });
        this.client.onResumed(() => {
            this.connected = true;
            void this.emitConnection('connected');
        });
        this.client.onError((error) => {
            this.handleSdkError(error);
        });
        this.client.onMessage((message) => {
            void this.handleInbound(message);
        });
        this.client.onInteraction((event) => {
            void this.handleInteraction(event);
        });
        // Never `await bot.start()` inline — it resolves only on stop/abort and
        // would block the Cordis plugin init. Track the raw promise and surface
        // failures through `handleSdkError`.
        this.runPromise = this.client.start(ctx.signal);
        // Fail-fast (QQ-R14): `tokenPrefetch: 'sync'` makes the SDK reject on bad
        // credentials before `ready`. Propagate that rejection to the startup
        // deferred instead of letting it hang until the timeout, and still record
        // the error for health/event reporting.
        this.runPromise.catch((error) => {
            this.handleSdkError(error);
            ready.reject(error);
        });
        try {
            await withTimeout(ready.promise, this.config.startupTimeoutMs);
            this.started = true;
        }
        catch (error) {
            // Rollback: stop the (possibly half-started) SDK client and settle the
            // run promise so a failed start never leaks a live client behind a
            // `started === false` adapter.
            this.client.stop();
            await this.runPromise?.catch(() => undefined);
            this.runPromise = undefined;
            throw error;
        }
    }
    async stop() {
        if (!this.started && this.runPromise === undefined)
            return;
        this.started = false;
        this.connected = false;
        this.client.stop();
        await this.runPromise?.catch(() => undefined);
        this.runPromise = undefined;
        void this.emitConnection('closed');
    }
    async send(target, message) {
        if (!this.started || !this.outbound) {
            throw new ChannelError('CHANNEL_NOT_STARTED', 'qq adapter is not started');
        }
        return this.outbound.send(target, message);
    }
    async createReply(target) {
        if (target.conversationType !== 'dm' || !target.replyToMessageId) {
            throw new ChannelError('CHANNEL_ERROR', 'QQ native streaming requires a C2C reply target with message id');
        }
        const stream = this.client.openStream({ scope: 'c2c', targetId: target.conversationId, msgId: target.replyToMessageId }, { throttleMs: this.config.streaming.throttleMs });
        return new QQStreamingReply(stream);
    }
    async getHealth() {
        if (!this.started) {
            return { status: 'down', detail: 'qq adapter is not started', authenticated: false };
        }
        if (this.error) {
            return {
                status: 'degraded',
                detail: 'sdk error',
                connection: this.connected ? 'connected' : 'disconnected',
                authenticated: this.connected,
                error: this.error.message,
            };
        }
        if (this.connected) {
            return {
                status: 'ok',
                detail: 'connected',
                connection: 'connected',
                authenticated: true,
            };
        }
        return {
            status: 'degraded',
            detail: 'sdk not ready',
            connection: 'disconnected',
            authenticated: false,
        };
    }
    handleSdkError(error) {
        this.error = error;
        this.connected = false;
        this.ctx?.logger.error('[channel-qq] sdk error', error);
        void this.emitConnection('disconnected');
    }
    async handleInbound(message) {
        if (message.kind === 'c2c' && message.senderId) {
            await this.deps.onOwnerDiscovered?.(message.senderId);
        }
        await this.inbound.handle(message);
    }
    async handleInteraction(event) {
        // QQ requires an interaction ACK within ~5s; ACK fire-and-forget first so
        // the platform is satisfied regardless of how long Harness answer
        // resolution takes. Never awaits Harness resolution before ACKing.
        if (event.id) {
            void this.client
                .acknowledgeInteraction(event.id, 0)
                .catch((error) => this.ctx?.logger.debug('[channel-qq] interaction ACK failed', {
                interactionId: event.id,
                error: error instanceof Error ? error.message : error,
            }));
        }
        const result = mapInteraction(event, {
            channel: this.id,
            accountId: this.config.accountId,
        });
        if (!result.ok) {
            // Fail closed: never emit a guessed event (security doc). Drop with a
            // debug note — no raw payload dump.
            this.ctx?.logger.debug('[channel-qq] dropped interaction', { reason: result.reason });
            return;
        }
        const ev = result.event;
        // Inbound summary (project rule): no raw payload dump.
        this.ctx?.logger.info(`[channel-qq] interaction from ${ev.sender.id} in ${ev.conversation.id}`, {
            channel: this.id,
            accountId: this.config.accountId,
            conversationType: ev.conversation.type,
            interactionId: ev.interactionId,
        });
        // Adapter only emits the canonical event; the Harness Access Gate
        // authorizes (never implement ACL here).
        if (this.ctx) {
            await this.ctx.emit(ev);
        }
    }
    emitAuth(state) {
        if (!this.ctx)
            return Promise.resolve();
        return this.ctx
            .emit({
            type: 'auth.changed',
            channel: this.id,
            accountId: this.config.accountId,
            state,
        })
            .then(() => undefined);
    }
    emitConnection(state) {
        if (!this.ctx)
            return Promise.resolve();
        return this.ctx
            .emit({
            type: 'connection.changed',
            channel: this.id,
            accountId: this.config.accountId,
            state,
        })
            .then(() => undefined);
    }
}
/** Minimal deferred primitive. */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
/** Resolve a promise or reject after `timeoutMs`. */
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new ChannelError('CHANNEL_START_FAILED', 'qq adapter startup timed out')), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * Fail loudly when the resolved QQ AppSecret credential is missing/empty —
 * the adapter must not construct a real Tencent client with an empty secret
 * (v1.1 QQ-R5). The Fake client path never reaches this helper.
 */
function requireAppSecret(appSecret, config) {
    if (!appSecret) {
        throw new ChannelError('CHANNEL_ERROR', `QQ credential "${config.appSecretRef}" is not configured`);
    }
    return appSecret;
}
//# sourceMappingURL=adapter.js.map