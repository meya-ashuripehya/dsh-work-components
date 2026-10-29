/**
 * DSH SDK port — the thin seam between the QQ adapter and the Tencent SDK.
 *
 * The adapter never touches `QQBot` directly; everything flows through
 * `QQSdkClient`. Production wraps the real `QQBot` (`TencentQQSdkClient`);
 * tests inject a `FakeQQSdkClient` so the entire adapter contract suite runs
 * fully offline (no network, no real credentials).
 */
import { MediaFileType, QQBot, } from '@tencent-connect/qqbot-nodejs';
import { ChannelSendError } from '@wsz987/channel-core';
/**
 * QQ Gateway intents the adapter actually consumes today (minimal-intent
 * principle): `GROUP_AND_C2C` covers the C2C/group message events this adapter
 * processes inbound, and `INTERACTION` covers the button `INTERACTION_CREATE`
 * callbacks that drive `interaction.received`. The SDK defaults to
 * `FULL_INTENTS` (guilids + members + guild messages + dm + group/c2c +
 * interaction); requesting only what we use avoids `4914 INSUFFICIENT_INTENTS`
 * / `4915 DISALLOWED_INTENTS` gateway rejections for privileges the bridge
 * never exercises, and keeps the permission surface minimal. Bit values are
 * verified from the pinned SDK (`dist/protocol/gateway/constants.js`):
 * `GROUP_AND_C2C = 1 << 25`, `INTERACTION = 1 << 26`.
 */
export const QQ_MINIMAL_INTENTS = (1 << 25) | (1 << 26); // GROUP_AND_C2C | INTERACTION
/** QQ inline-keyboard callback action (emits `INTERACTION_CREATE`). */
export const QQ_BUTTON_ACTION_TYPE = 1;
/** QQ inline-keyboard permission: any user may press. */
export const QQ_BUTTON_PERMISSION_TYPE = 2;
/** QQ button render style for the `primary` DSH action style. */
export const QQ_BUTTON_STYLE_PRIMARY = 1;
/** QQ button render style default. */
export const QQ_BUTTON_STYLE_DEFAULT = 0;
/** Bridge a DSH `ChannelLogger` (variadic) to the SDK `Logger` shape. */
export function adaptLogger(logger) {
    return {
        info: (msg, meta) => logger.info(msg, meta),
        error: (msg, meta) => logger.error(msg, meta),
        warn: (msg, meta) => logger.warn(msg, meta),
        debug: (msg, meta) => logger.debug(msg, meta),
    };
}
/** Production `QQSdkClient`: wraps a real `QQBot` built from config. */
export class TencentQQSdkClient {
    bot;
    constructor(config, logger, appSecret) {
        this.bot = new QQBot({
            appId: config.appId,
            appSecret,
            accountId: config.accountId,
            markdownSupport: config.markdownSupport,
            transport: 'websocket',
            tokenPrefetch: 'sync',
            // Minimal intent mask (GROUP_AND_C2C | INTERACTION) — never rely on the
            // SDK `FULL_INTENTS` default (skill §6.2, P1). See QQ_MINIMAL_INTENTS.
            intents: QQ_MINIMAL_INTENTS,
            logger: adaptLogger(logger),
        });
    }
    onReady(handler) {
        this.bot.on('ready', () => handler());
    }
    onResumed(handler) {
        this.bot.on('resumed', () => handler());
    }
    onError(handler) {
        this.bot.on('error', (error) => handler(error));
    }
    onMessage(handler) {
        this.bot.on('message', (_ctx, message) => handler(message));
    }
    onInteraction(handler) {
        // The SDK dispatches the raw `InteractionEvent` as the second argument;
        // the handler only sees the port slice the adapter needs.
        this.bot.on('interaction', (_ctx, event) => handler(event));
    }
    start(signal) {
        return this.bot.start(signal);
    }
    stop() {
        this.bot.stop();
    }
    sendText(target, text) {
        return this.bot.sendText(target, text);
    }
    sendMarkdownWithKeyboard(target, text, keyboard) {
        // New QQ interactive messages are explicit Markdown messages. Do not use
        // sendTextWithKeyboard(): that helper follows `markdownSupport` and emits
        // msg_type=0 when the legacy config flag is false, in which case current
        // QQ clients do not render the keyboard.
        return this.bot.sendMarkdown(toSdkReplyTarget(target), text, { keyboard });
    }
    acknowledgeInteraction(id, code, data) {
        return this.bot.acknowledgeInteraction(id, code, data);
    }
    async sendMedia(target, message) {
        return this.bot.sendMedia({ target: toSdkReplyTarget(target), ...mediaOpts(message) });
    }
    openStream(target, options) {
        return this.bot.openStream({
            target: toSdkReplyTarget(target),
            throttleMs: options.throttleMs,
        });
    }
}
/** Port `QQReplyTarget`/`QQStreamTarget` is structurally identical to the SDK
 * `ReplyTarget`; narrow explicitly so the SDK methods accept it. */
function toSdkReplyTarget(target) {
    return { scope: target.scope, targetId: target.targetId, msgId: target.msgId };
}
export function mediaOpts(message) {
    for (const part of message.parts ?? []) {
        switch (part.type) {
            case 'image':
                if (part.url || part.dataUri || part.localData !== undefined) {
                    return {
                        fileType: MediaFileType.IMAGE,
                        ...mediaSource(part),
                        content: message.text,
                    };
                }
                break;
            case 'audio':
                if (part.url || part.dataUri || part.localData !== undefined) {
                    return { fileType: MediaFileType.VOICE, ...mediaSource(part) };
                }
                break;
            case 'video':
                if (part.url || part.dataUri || part.localData !== undefined) {
                    return { fileType: MediaFileType.VIDEO, ...mediaSource(part) };
                }
                break;
            case 'file':
                if (part.url || part.dataUri || part.localData !== undefined) {
                    return {
                        fileType: MediaFileType.FILE,
                        ...mediaSource(part),
                        fileName: part.name,
                        content: message.text,
                    };
                }
                break;
            default:
                break;
        }
    }
    // No resolvable media part — fall back to a FILE with no source (caller
    // guarantees a media part; this branch is defensive only).
    return { fileType: MediaFileType.FILE, content: message.text };
}
/**
 * Resolve a media part to the SDK's single-source shape (`url` or `fileData`).
 *
 * Carrier precedence: trusted bytes in hand win, then an
 * inline data URI, then a genuine `http(s)` `url`. `localData` /
 * `dataUri` are both base64-encoded for the QQ `uploadMedia` `fileData`
 * field — never sent as `url` (the QQ upload API fetches `url` over HTTP and
 * cannot resolve inline/raw bytes). Only a real `http(s)` `url` is passed
 * through as `url`.
 */
function mediaSource(part) {
    if (part.localData !== undefined) {
        return { fileData: Buffer.from(part.localData).toString('base64') };
    }
    if (part.dataUri) {
        return { fileData: decodeDataUri(part.dataUri) };
    }
    return { url: part.url };
}
/**
 * Decode a `data:<mime>;base64,<payload>` URI into the raw base64 payload the
 * Tencent `uploadMedia` `fileData` field expects. Rejects non-base64 data URIs
 * (the QQ upload API ingests raw base64, not arbitrary URL-encoded payloads).
 */
export function decodeDataUri(dataUri) {
    const match = /^data:[^;,]*;base64,([\s\S]+)$/.exec(dataUri);
    const payload = match?.[1];
    if (!payload) {
        throw new ChannelSendError('unsupported media data URI');
    }
    return payload;
}
/** Offline fake SDK client: records calls and exposes controllable emits. */
export class FakeQQSdkClient {
    readyHandlers = [];
    resumedHandlers = [];
    errorHandlers = [];
    messageHandlers = [];
    interactionHandlers = [];
    started = false;
    stopped = false;
    /** If set, `start()` throws this error (never resolves). */
    startError;
    /** If true, `start()` resolves only when the signal aborts. */
    hangStart = false;
    /** If true, `start()` emits `ready` (then still resolves immediately). */
    autoReady = false;
    /** Last signal passed to `start()`. */
    lastSignal;
    textCalls = [];
    keyboardCalls = [];
    mediaCalls = [];
    acknowledgeCalls = [];
    streamCalls = [];
    /** The live stream sessions opened so far (same order as `streamCalls`). */
    streams = [];
    /** If set, `sendText`/`sendMedia` reject with this error. */
    sendError;
    onReady(handler) {
        this.readyHandlers.push(handler);
    }
    onResumed(handler) {
        this.resumedHandlers.push(handler);
    }
    onError(handler) {
        this.errorHandlers.push(handler);
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onInteraction(handler) {
        this.interactionHandlers.push(handler);
    }
    async start(signal) {
        this.started = true;
        this.lastSignal = signal;
        if (this.startError)
            throw this.startError;
        if (this.autoReady)
            this.emitReady();
        if (this.hangStart) {
            await new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return;
        }
    }
    stop() {
        this.stopped = true;
        // Mirror the real SDK teardown: once stopped, no more events are
        // dispatched to registered handlers.
        this.readyHandlers = [];
        this.resumedHandlers = [];
        this.errorHandlers = [];
        this.messageHandlers = [];
        this.interactionHandlers = [];
    }
    async sendText(target, text) {
        if (this.sendError)
            throw this.sendError;
        this.textCalls.push({ target, text });
        return { id: `out-${this.textCalls.length}` };
    }
    async sendMarkdownWithKeyboard(target, text, keyboard) {
        if (this.sendError)
            throw this.sendError;
        this.keyboardCalls.push({ target, text, keyboard, format: 'markdown' });
        return { id: `out-kbd-${this.keyboardCalls.length}` };
    }
    async sendMedia(target, message) {
        if (this.sendError)
            throw this.sendError;
        this.mediaCalls.push({ target, message });
        return { upload: {}, message: { id: `out-media-${this.mediaCalls.length}` } };
    }
    async acknowledgeInteraction(id, code, data) {
        this.acknowledgeCalls.push({ id, code, data });
        return undefined;
    }
    openStream(target, options) {
        this.streamCalls.push({ target, options });
        const session = new FakeStreamSession();
        this.streams.push(session);
        return session;
    }
    // —— controllable emit helpers (tests) ——
    emitReady() {
        for (const h of this.readyHandlers)
            h();
    }
    emitResumed() {
        for (const h of this.resumedHandlers)
            h();
    }
    emitError(error) {
        for (const h of this.errorHandlers)
            h(error);
    }
    emitMessage(message) {
        for (const h of this.messageHandlers)
            h(message);
    }
    emitInteraction(event) {
        for (const h of this.interactionHandlers)
            h(event);
    }
}
/** Minimal offline `QQStreamSession` double for fake-client tests. */
export class FakeStreamSession {
    updates = [];
    completed = false;
    cancelled = false;
    async update(fullText) {
        this.updates.push(fullText);
    }
    async complete() {
        this.completed = true;
        return { id: 'stream-final', timestamp: Date.now() };
    }
    cancel() {
        this.cancelled = true;
    }
}
//# sourceMappingURL=sdk-client.js.map