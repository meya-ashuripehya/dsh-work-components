import { ChannelError } from '@wsz987/channel-core';
import { FetchTransport } from './transport.js';
import { HttpTelegramUpstream, } from './upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { TelegramStreamingReply } from './streaming-reply.js';
import { TelegramRichStreamingReply } from './rich-streaming-reply.js';
import { actionsToReplyMarkup } from './outbound.js';
import { manifest as telegramManifest } from './manifest.js';
import { resolveMode } from './render/index.js';
export class TelegramAdapter {
    config;
    id = 'telegram';
    /** Upstream compatibility manifest (read structurally by `channels doctor`). */
    manifest = telegramManifest;
    capabilities = {
        text: true,
        image: true,
        file: true,
        audio: true,
        video: true,
        // Rich Markdown (Bot API 10.1/10.2 sendRichMessage / HTML / MarkdownV2) is
        // genuinely rendered, not just parse_mode in a body (plan §Phase 3).
        markdown: true,
        cards: false,
        reactions: false,
        threads: true,
        // Inline buttons + callback_query interactions are supported (plan §5).
        interactiveActions: true,
        // Telegram can edit sent messages with editMessageText and can stream rich
        // drafts natively for DMs; `resolveStreamingMode` picks per target.
        streaming: 'edit',
        maxTextLength: 4096,
        // Directional media precision. Inbound:
        // every binary kind is hydrated to real bytes (`resourceRef` -> getFile ->
        // /file/bot... -> localData) before emit. Outbound: sendPhoto /
        // sendDocument / sendAudio / sendVideo all accept byte uploads
        // (multipart) or references, so every kind can send real bytes.
        // Platform-level size limits (e.g. Bot API cloud upload caps) are a
        // separate concern from this directional declaration.
        media: {
            inbound: {
                image: 'bytes',
                file: 'bytes',
                audio: 'bytes',
                video: 'bytes',
            },
            outbound: {
                image: 'bytes',
                file: 'bytes',
                audio: 'bytes',
                video: 'bytes',
            },
        },
    };
    outboxCapabilities = { proactiveText: true, proactiveMedia: true };
    ctx;
    upstream;
    inbound;
    outbound;
    started = false;
    stopped = false;
    receiveLoop;
    receiveAbort;
    removeContextAbortListener;
    /** [dsh-telegram-temp patch] background auth/webhook/receive supervisor. */
    supervisor;
    /** [dsh-telegram-temp patch] abort controller of the CURRENT receive-loop generation. */
    loopAbort;
    /** [dsh-telegram-temp patch] watchdog interval handle + last poll progress timestamp. */
    watchdogTimer;
    lastPollProgressAt = 0;
    /** One start/refresh lifecycle per chat/topic target, including in-flight starts. */
    typingStates = new Map();
    connected = false;
    authState = 'unauthenticated';
    /** Public bot identity used only for reliable inbound mention activation. */
    botIdentity;
    /** getUpdates acknowledgement cursor, shared with the driver across retries. */
    cursor = { offset: 0 };
    now;
    /** Resolved token used by the upstream driver (deps credential wins over legacy config). */
    token;
    /** Resolved once so outbound, streaming and explicit edits use one policy. */
    formattingMode;
    constructor(config, deps = {}) {
        this.config = config;
        this.now = deps.now ?? Date.now;
        const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
        const token = deps.token ?? config.token;
        this.upstream = new HttpTelegramUpstream({
            transport,
            token,
            longPollTimeoutMs: config.longPollTimeoutMs,
        });
        this.token = token;
        this.formattingMode = resolveMode(config.formatting.mode);
    }
    async start(ctx) {
        if (this.started)
            return;
        this.ctx = ctx;
        this.stopped = false;
        this.connected = false;
        this.botIdentity = undefined;
        this.cursor.offset = 0;
        this.inbound = this.createInboundProcessor();
        this.receiveAbort = new AbortController();
        const abortReceive = () => this.receiveAbort?.abort();
        if (ctx.signal.aborted)
            abortReceive();
        else {
            ctx.signal.addEventListener('abort', abortReceive, { once: true });
            this.removeContextAbortListener = () => ctx.signal.removeEventListener('abort', abortReceive);
        }
        this.outbound = new OutboundSender(this.upstream, ctx.logger, {
            formatting: { ...this.config.formatting, mode: this.formattingMode },
        });
        if (this.token) {
            // [dsh-telegram-temp patch] getMe / deleteWebhook failures no longer
            // disable receiving permanently: a background supervisor retries both
            // with capped backoff, then starts the receive loop + watchdog.
            this.started = true;
            const supervisor = this.runSupervisor(this.receiveAbort.signal).catch((error) => {
                this.ctx?.logger.error('[channel-telegram] supervisor crashed', error instanceof Error ? error.message : error);
            });
            this.supervisor = supervisor;
            return;
        }
        else {
            this.authState = 'unauthenticated';
            this.emitAuth('unknown');
        }
        this.started = true;
    }
    createInboundProcessor() {
        return new InboundProcessor({
            ctx: this.ctx,
            meta: {
                channel: this.id,
                accountId: this.config.accountId,
                ...(this.botIdentity ? { bot: this.botIdentity } : {}),
            },
            dedupEnabled: this.config.dedup.enabled,
            dedupWindowMs: this.config.dedup.windowMs,
            files: this.upstream,
            maxDownloadBytes: this.config.maxDownloadBytes,
            now: this.now,
            // Best-effort callback ACK (clears the button spinner; never blocks on
            // agent resolution — plan §12.2).
            ackCallback: (callbackId) => this.upstream.answerCallbackQuery({ callback_query_id: callbackId }),
        });
    }
    async stop() {
        if (!this.started || this.stopped)
            return;
        this.stopped = true;
        this.started = false;
        this.connected = false;
        this.clearTypingStates();
        this.stopWatchdog();
        this.receiveAbort?.abort();
        this.receiveAbort = undefined;
        this.loopAbort?.abort();
        this.loopAbort = undefined;
        this.removeContextAbortListener?.();
        this.removeContextAbortListener = undefined;
        const loop = this.receiveLoop;
        const supervisor = this.supervisor;
        this.receiveLoop = undefined;
        this.supervisor = undefined;
        // [dsh-telegram-temp patch] bounded wait: a handler still running in the
        // background must not block teardown forever.
        const pending = [loop, supervisor].filter(Boolean).map((p) => p.catch(() => undefined));
        if (pending.length > 0) {
            await Promise.race([Promise.all(pending), delay(5000)]);
        }
        this.emitConnection('closed');
    }
    async send(target, message) {
        if (!this.started || !this.outbound) {
            throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
        }
        return this.outbound.send(target, message);
    }
    /** Start Telegram's transient typing indicator and refresh it per chat/topic. */
    async startTypingForTarget(target) {
        if (!this.started || this.stopped || !this.config.typing.enabled)
            return;
        const key = typingKey(target);
        if (this.typingStates.has(key))
            return;
        const state = {};
        this.typingStates.set(key, state);
        // Let the lifecycle caller decide how to handle an immediate failure. Do
        // not create a refresh timer unless Telegram accepted the initial action.
        try {
            await this.sendTyping(target);
            if (!this.started || this.stopped || this.typingStates.get(key) !== state)
                return;
            state.timer = setInterval(() => {
                // Refresh failures are isolated from the timer; the harness owns the
                // best-effort boundary for the immediate action below.
                void this.sendTyping(target).catch((error) => {
                    this.ctx?.logger.debug('[channel-telegram] typing refresh failed', error instanceof Error ? error.message : error);
                });
            }, this.config.typing.refreshMs);
        }
        catch (error) {
            if (this.typingStates.get(key) === state)
                this.typingStates.delete(key);
            throw error;
        }
    }
    /** Telegram has no explicit stop action; clearing refresh lets it expire. */
    async stopTypingForTarget(target) {
        const key = typingKey(target);
        const state = this.typingStates.get(key);
        if (!state)
            return;
        this.typingStates.delete(key);
        if (state.timer)
            clearInterval(state.timer);
    }
    async sendTyping(target) {
        await this.upstream.sendChatAction(target.conversationId, 'typing', {
            ...(target.threadId ? { messageThreadId: target.threadId } : {}),
        });
    }
    clearTypingStates() {
        for (const state of this.typingStates.values()) {
            if (state.timer)
                clearInterval(state.timer);
        }
        this.typingStates.clear();
    }
    resolveStreamingMode(target) {
        // `streaming.enabled: false` is a hard off-switch: it forces the buffered
        // send-once strategy even though streaming is available.
        if (!this.config.streaming.enabled)
            return 'buffered';
        // Private DMs with rich output use the native sendRichMessageDraft flow.
        const rich = this.formattingMode === 'rich-markdown';
        if (rich && target.conversationType === 'dm')
            return 'native';
        // [dsh-workbench patch] html/auto/plain and draft mode still use createReply (edit or sendMessageDraft).
        return 'edit';
    }
    async createReply(target, options = {}) {
        if (!this.started || !this.ctx) {
            throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
        }
        const mode = this.formattingMode;
        const rich = mode === 'rich-markdown';
        const kind = options.kind === 'process' ? 'process' : 'text';
        const streamMode = this.config.streaming.mode || 'auto';
        // Native rich draft streaming for private DMs (plan §6.1) — text segments only.
        if (rich && target.conversationType === 'dm' && kind === 'text') {
            const reply = new TelegramRichStreamingReply(this.upstream, target, this.config.streaming.placeholder, { formatting: { mode }, kind });
            await reply.start();
            return reply;
        }
        // [dsh-workbench patch] edit / sendMessageDraft with HTML incremental rendering and rate limits.
        const reply = new TelegramStreamingReply(this.upstream, target, this.config.streaming.placeholder, {
            formatting: { mode },
            richFinal: rich && target.conversationType !== 'dm',
            kind,
            streamMode,
        });
        await reply.start();
        return reply;
    }
    /**
     * Optional in-place edit of an already-sent message (plan §15.3): either
     * update the interactive keyboard (`editMessageReplyMarkup`) or the text
     * (`editMessageText`).
     */
    async edit(target, messageId, message) {
        if (!this.started) {
            throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
        }
        if (message.text !== undefined) {
            const markup = message.actions === undefined
                ? undefined
                : actionsToReplyMarkup(message.actions) ?? { inline_keyboard: [] };
            const mode = this.formattingMode;
            const raw = mode === 'rich-markdown'
                ? await this.upstream.editMessageRich(target.conversationId, messageId, { markdown: message.text }, markup)
                : await this.upstream.editMessageText(target.conversationId, messageId, message.text, markup ? { replyMarkup: markup } : undefined);
            return { delivered: true, raw };
        }
        if (message.actions !== undefined) {
            const markup = actionsToReplyMarkup(message.actions) ?? { inline_keyboard: [] };
            const raw = await this.upstream.editMessageReplyMarkup(target.conversationId, messageId, markup);
            return { delivered: true, raw };
        }
        return { delivered: true };
    }
    async getHealth() {
        if (!this.started) {
            return { status: 'down', detail: 'telegram adapter is not started', authenticated: false };
        }
        if (this.authState === 'authenticated' && this.connected) {
            return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
        }
        if (this.authState === 'authenticated') {
            return {
                status: 'down',
                detail: 'authenticated but receive loop down',
                connection: 'disconnected',
                authenticated: true,
            };
        }
        if (this.authState === 'failed') {
            return { status: 'down', detail: 'authentication failed', authenticated: false };
        }
        return { status: 'down', detail: 'not configured: no bot token', authenticated: false };
    }
    /**
     * [dsh-telegram-temp patch] Capped exponential backoff (never gives up).
     * Ceiling: config.reconnect.maxDelayMs, hard-capped at 60 s.
     */
    backoffDelay(attempt) {
        const base = Math.max(1, this.config.reconnect?.baseDelayMs ?? 1000);
        const cap = Math.min(Math.max(base, this.config.reconnect?.maxDelayMs ?? MAX_BACKOFF_MS), MAX_BACKOFF_MS);
        return Math.min(base * 2 ** Math.min(Math.max(attempt - 1, 0), 16), cap);
    }
    /**
     * [dsh-telegram-temp patch] Background startup: getMe (retry forever with
     * capped backoff) -> deleteWebhook (retry forever) -> receive loop + watchdog.
     */
    async runSupervisor(signal) {
        const log = this.ctx.logger;
        let attempt = 0;
        let reportedFailure = false;
        while (!this.stopped && !signal.aborted) {
            try {
                const bot = await this.upstream.getMe();
                this.botIdentity = {
                    id: bot.id,
                    ...(bot.username ? { username: bot.username } : {}),
                };
                // Polling starts only after getMe, so replace the pre-auth processor
                // with one carrying the trusted identity used by mention detection.
                this.inbound = this.createInboundProcessor();
                this.authState = 'authenticated';
                this.emitAuth('authenticated');
                if (attempt > 0)
                    log.info(`[channel-telegram] auth check succeeded after ${attempt} failed attempt(s)`);
                break;
            }
            catch (error) {
                if (this.stopped || signal.aborted)
                    return;
                attempt += 1;
                this.authState = 'failed';
                if (!reportedFailure) {
                    reportedFailure = true;
                    this.emitAuth('failed');
                }
                const wait = this.backoffDelay(attempt);
                log.warn(`[channel-telegram] auth check failed (attempt ${attempt}); retry in ${wait}ms`, error instanceof Error ? error.message : error);
                await sleep(wait, signal);
            }
        }
        attempt = 0;
        while (!this.stopped && !signal.aborted) {
            try {
                // getUpdates and webhooks are mutually exclusive. Preserve queued
                // updates while switching this bot to the local polling transport.
                await this.upstream.deleteWebhook();
                if (attempt > 0)
                    log.info(`[channel-telegram] deleteWebhook succeeded after ${attempt} failed attempt(s)`);
                break;
            }
            catch (error) {
                if (this.stopped || signal.aborted)
                    return;
                attempt += 1;
                const wait = this.backoffDelay(attempt);
                log.warn(`[channel-telegram] polling setup (deleteWebhook) failed (attempt ${attempt}); retry in ${wait}ms`, error instanceof Error ? error.message : error);
                await sleep(wait, signal);
            }
        }
        if (this.stopped || signal.aborted)
            return;
        this.emitConnection('connecting');
        this.startReceiveLoop();
        this.startWatchdog();
    }
    /** Long-poll receive loop with exponential backoff on failure. */
    startReceiveLoop() {
        if (this.receiveLoop)
            return;
        const parent = this.receiveAbort?.signal;
        if (!parent || parent.aborted || this.stopped)
            return;
        // [dsh-telegram-temp patch] each loop generation has its own abort
        // controller (linked to the adapter's) so the watchdog can replace it.
        const loopAbort = new AbortController();
        const onParentAbort = () => loopAbort.abort();
        parent.addEventListener('abort', onParentAbort, { once: true });
        this.loopAbort = loopAbort;
        this.lastPollProgressAt = this.now();
        const loop = this.runReceiveLoop(loopAbort.signal).finally(() => {
            parent.removeEventListener('abort', onParentAbort);
        });
        this.receiveLoop = loop;
        void loop.finally(() => {
            if (this.receiveLoop === loop)
                this.receiveLoop = undefined;
        }).catch(() => undefined);
    }
    /** [dsh-telegram-temp patch] Abandon the current loop generation and start a fresh one. */
    restartReceiveLoop(reason) {
        if (this.stopped || !this.receiveAbort || this.receiveAbort.signal.aborted)
            return;
        this.ctx?.logger.warn(`[channel-telegram] watchdog: ${reason}; restarting receive loop`);
        this.loopAbort?.abort();
        this.loopAbort = undefined;
        this.receiveLoop = undefined;
        if (this.connected) {
            this.connected = false;
        }
        this.emitConnection('reconnecting');
        this.startReceiveLoop();
    }
    /** [dsh-telegram-temp patch] Restart polling when no getUpdates completed for watchdogStallMs. */
    startWatchdog() {
        if (this.watchdogTimer || this.stopped)
            return;
        const stallMs = Math.max(60000, this.config.watchdogStallMs ?? DEFAULT_WATCHDOG_STALL_MS);
        const timer = setInterval(() => {
            if (this.stopped)
                return;
            const idle = this.now() - this.lastPollProgressAt;
            if (!this.receiveLoop) {
                this.restartReceiveLoop('receive loop is not running');
                return;
            }
            if (idle > stallMs) {
                this.restartReceiveLoop(`no getUpdates call completed for ${Math.round(idle / 1000)}s`);
            }
        }, WATCHDOG_INTERVAL_MS);
        timer.unref?.();
        this.watchdogTimer = timer;
    }
    stopWatchdog() {
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.watchdogTimer = undefined;
    }
    /**
     * [dsh-telegram-temp patch] Hand one update to the inbound processor with
     * a time budget. On timeout the update is marked read (offset advances in
     * the driver) and polling continues; the handler keeps running in the
     * background so a late agent reply is still delivered.
     */
    async handleUpdateBounded(raw, signal) {
        const timeoutMs = Math.max(1000, this.config.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS);
        const updateId = raw?.update_id;
        const handling = Promise.resolve().then(() => this.inbound.handle(raw));
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        let outcome;
        try {
            outcome = await Promise.race([handling, timedOut]);
        }
        finally {
            clearTimeout(timer);
        }
        if (outcome === TIMED_OUT) {
            this.ctx?.logger.warn(`[channel-telegram] update ${updateId} handling exceeded ${timeoutMs}ms; marking it read and continuing to poll (handler continues in background)`);
            handling.then(() => {
                this.ctx?.logger.info(`[channel-telegram] update ${updateId} handling finished after timeout`);
            }, (error) => {
                this.ctx?.logger.warn(`[channel-telegram] update ${updateId} handling failed after timeout`, error instanceof Error ? error.message : error);
            });
        }
        if (!signal.aborted)
            this.lastPollProgressAt = this.now();
    }
    async runReceiveLoop(signal) {
        let attempt = 0;
        if (!signal)
            return;
        const isCurrent = () => this.loopAbort?.signal === signal;
        // [dsh-telegram-temp patch] poison-update guard: an update whose handler
        // throws repeatedly is skipped after MAX_UPDATE_FAILURES attempts so it
        // cannot stall the (now never-ending) retry loop forever.
        let failingUpdateId;
        let failingCount = 0;
        while (!this.stopped && !signal.aborted) {
            try {
                await this.upstream.getUpdates(this.cursor, signal, async (raw) => {
                    try {
                        await this.handleUpdateBounded(raw, signal);
                        if (failingUpdateId === raw?.update_id) {
                            failingUpdateId = undefined;
                            failingCount = 0;
                        }
                    }
                    catch (error) {
                        // Reset transient processor state before retrying the unacked
                        // update after the receive loop reconnects.
                        this.inbound = this.createInboundProcessor();
                        if (failingUpdateId === raw?.update_id)
                            failingCount += 1;
                        else {
                            failingUpdateId = raw?.update_id;
                            failingCount = 1;
                        }
                        if (failingCount >= MAX_UPDATE_FAILURES) {
                            this.ctx.logger.error(`[channel-telegram] update ${raw?.update_id} failed ${failingCount} times; skipping it`, error instanceof Error ? error.message : error);
                            failingUpdateId = undefined;
                            failingCount = 0;
                            return;
                        }
                        throw error;
                    }
                }, () => {
                    if (signal.aborted || !isCurrent())
                        return;
                    this.lastPollProgressAt = this.now();
                    if (!this.connected) {
                        this.connected = true;
                        this.emitConnection('connected');
                    }
                });
                attempt = 0;
            }
            catch (error) {
                if (this.stopped || signal.aborted)
                    break;
                // A failed getUpdates still counts as a completed call for the watchdog.
                this.lastPollProgressAt = this.now();
                attempt += 1;
                if (this.connected) {
                    this.connected = false;
                }
                this.emitConnection('reconnecting');
                // [dsh-telegram-temp patch] never give up permanently; keep
                // retrying with capped backoff (log escalates past maxRetries).
                const wait = this.backoffDelay(attempt);
                const level = attempt > (this.config.reconnect?.maxRetries ?? 10) ? 'error' : 'warn';
                this.ctx.logger[level](`[channel-telegram] receive loop error (attempt ${attempt}); retry in ${wait}ms`, error instanceof Error ? error.message : error);
                await sleep(wait, signal);
            }
        }
        if (isCurrent()) {
            this.connected = false;
            if (!this.stopped && !signal.aborted) {
                this.emitConnection('disconnected');
            }
        }
    }
    emitAuth(state) {
        if (!this.ctx)
            return;
        void this.ctx
            .emit({
            type: 'auth.changed',
            channel: this.id,
            accountId: this.config.accountId,
            state,
        })
            .catch(() => undefined);
    }
    emitConnection(state) {
        if (!this.ctx)
            return;
        void this.ctx
            .emit({
            type: 'connection.changed',
            channel: this.id,
            accountId: this.config.accountId,
            state,
        })
            .catch(() => undefined);
    }
}
/** [dsh-telegram-temp patch] tunables (overridable via config fields of the same purpose). */
const MAX_BACKOFF_MS = 60000;
const DEFAULT_UPDATE_TIMEOUT_MS = 90000;
const DEFAULT_WATCHDOG_STALL_MS = 180000;
const WATCHDOG_INTERVAL_MS = 30000;
const MAX_UPDATE_FAILURES = 5;
const TIMED_OUT = Symbol('telegram-update-timeout');
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function typingKey(target) {
    return JSON.stringify([target.conversationId, target.threadId ?? null]);
}
//# sourceMappingURL=adapter.js.map