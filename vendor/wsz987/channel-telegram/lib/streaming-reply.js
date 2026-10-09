/**
 * Telegram streaming reply (edit + sendMessageDraft) with rate limits and incremental HTML.
 * [dsh-workbench patch] draft-stream + process-HTML + finalize-in-place.
 *
 * Finalize contract (one visible bubble):
 * 1. Cancel timers when finish starts; mark finalized early.
 * 2. Await in-flight draft/edit before sendFinal.
 * 3. Never sendMessageDraft after the final send/edit.
 * 4. If a real preview messageId exists, ALWAYS edit it into the final (never send a second message).
 * 5. Draft mode never creates a real preview; only sendMessage at the end (Bot API dismisses the draft).
 * 6. Empty draft text shows "Thinking…" — do not use it as a clear.
 * 7. kind=process text is already Telegram HTML — send/edit with parse_mode=HTML, do not re-escape.
 */
import { TelegramApiError } from './api-error.js';
import { REGULAR_MESSAGE_MAX } from './rich-message.js';
import { truncateGraphemes, visibleLength, splitByGraphemes } from './render/segment.js';
import { sendWithFallback } from './render/index.js';
import { StreamThrottle } from './stream-throttle.js';
import { buildIncrementalHtml, buildFinalHtmlChunks, splitClosedTail } from './incremental-html.js';
import { escapeHtml } from './render/html.js';

const PREVIEW_LIMIT = 3800;
const MIN_DELTA_CHARS = 12;
/** [dsh-workbench patch] live-stream pacing: first bubble early, then ~0.6s edits (DM), 1s+18/min (groups). */
const FIRST_SEND_CHARS = 20;
const FIRST_SEND_DELAY_MS = 350;
const STALE_FLUSH_MS = 1500;
/** Strip streaming placeholders / cursors from finals only. */
const TRAILING_CURSOR = /(?:\s*(?:…|\.\.\.))+\s*$/u; // only our placeholder / streaming ellipsis, not legitimate '..'
let draftSeq = (Date.now() % 1_000_000) * 1000;
function nextDraftId() {
    draftSeq = (draftSeq + 1) % 2_000_000_000;
    return draftSeq || 1;
}

export class TelegramStreamingReply {
    upstream;
    target;
    placeholder;
    options;
    text = '';
    sentPreview;
    messageId;
    draftId;
    useDraft;
    draftFailed = false;
    finalized = false;
    queue = Promise.resolve();
    pendingPreview;
    finishing = false;
    throttle;
    lastHtml = '';
    kind;
    _timer;
    _inflight = Promise.resolve();
    constructor(upstream, target, placeholder = '…', options = {}) {
        this.upstream = upstream;
        this.target = target;
        this.placeholder = placeholder;
        this.options = options;
        this.kind = options.kind === 'process' ? 'process' : 'text';
        // 'auto' and 'edit' → editMessageText (one bubble). Draft is opt-in only.
        const preferDraft = options.streamMode === 'draft'
            && this.kind === 'text'
            && typeof upstream.sendMessageDraft === 'function';
        this.useDraft = preferDraft;
        const isDm = target.conversationType === 'dm';
        const minInterval = this.kind === 'process' ? 1000 : (isDm ? 600 : 1000);
        this.throttle = new StreamThrottle({
            isGroup: target.conversationType !== 'dm',
            minIntervalMs: minInterval,
        });
        if (this.useDraft) this.draftId = options.draftId ?? nextDraftId();
    }
    async start() {
        if (this.messageId || this.finalized || this.finishing) return;
        if (this.useDraft && !this.draftFailed) {
            try {
                await this.trackInflight(this.upstream.sendMessageDraft(
                    this.target.conversationId, this.draftId, this.placeholder || '…', targetOptions(this.target)));
                if (this.finalized || this.finishing) return;
                this.sentPreview = this.placeholder || '…';
                this.throttle.mark();
                return;
            }
            catch (error) {
                this.useDraft = false;
                this.draftFailed = true;
                this.options.onDraftFallback?.(error);
            }
        }
        // Edit path: no "…" placeholder. The first real content is sent as the bubble
        // (within ~350ms / 20 chars of the first delta), then edited in place.
    }
    append(delta) {
        return this.replace({ text: this.text + delta });
    }
    replace(message) {
        return this.enqueue(async () => {
            if (this.finalized || this.finishing) return;
            if (message.text === undefined) return;
            this.text = message.text;
            this.pendingPreview = this.text;
            await this.sync(false);
        });
    }
    finish(message) {
        this.finishing = true;
        this.cancelTimer();
        this.pendingPreview = undefined;
        return this.enqueue(async () => {
            if (this.finalized) return;
            this.finalized = true;
            if (message?.text !== undefined) this.text = message.text;
            await this._inflight.catch(() => { });
            await this.waitReady();
            await this.sendFinal();
        });
    }
    fail(error) {
        this.finishing = true;
        this.cancelTimer();
        return this.enqueue(async () => {
            if (this.finalized) return;
            this.finalized = true;
            await this._inflight.catch(() => { });
            if (isRateLimitError(error)) return;
            if (!this.messageId) return;
            const text = truncateGraphemes(`Warning: ${messageOf(error)}`, REGULAR_MESSAGE_MAX);
            try {
                await this.upstream.editMessageText(this.target.conversationId, this.messageId, text);
            }
            catch { /* ignore */ }
        });
    }
    /** Build preview/final payload. Process kind is already Telegram HTML. */
    buildPayload(plain, { final }) {
        if (this.kind === 'process') {
            return { payloadText: String(plain ?? ''), parseMode: 'HTML', plain: String(plain ?? '') };
        }
        const mode = this.options.formatting?.mode ?? 'auto';
        let source = String(plain ?? '');
        if (final) source = source.replace(TRAILING_CURSOR, '');
        if (mode === 'html' || mode === 'auto') {
            if (final) {
                const chunks = buildFinalHtmlChunks(source);
                return { payloadText: chunks[0] ?? '', parseMode: 'HTML', plain: source, chunks };
            }
            const built = buildIncrementalHtml(source, PREVIEW_LIMIT);
            return { payloadText: built.html, parseMode: 'HTML', plain: source, built };
        }
        if (final) {
            const chunks = splitByGraphemes(source, REGULAR_MESSAGE_MAX);
            return { payloadText: chunks[0] ?? '', plain: source, chunks };
        }
        let payloadText = source;
        if (visibleLength(source) > PREVIEW_LIMIT)
            payloadText = `…${source.slice(-(PREVIEW_LIMIT - 1))}`;
        return { payloadText, plain: source };
    }
    async sync(final) {
        if (!final && (this.finishing || this.finalized)) return;
        if (!this.text && !final) return;
        if (final) {
            await this.sendFinal();
            return;
        }
        const wait = this.throttle.waitMs();
        if (wait > 0) {
            this.schedule(wait);
            return;
        }
        const plain = this.pendingPreview ?? this.text;
        if (!plain) return;
        if (this.kind === 'text' && !this.messageId && !this.useDraft) {
            this.firstTextAt ??= Date.now();
            const age = Date.now() - this.firstTextAt;
            if (plain.length < FIRST_SEND_CHARS && age < FIRST_SEND_DELAY_MS) {
                this.pendingPreview = plain;
                this.schedule(FIRST_SEND_DELAY_MS - age);
                return;
            }
        }
        else if (this.kind === 'text' && this.sentPreviewPlain != null) {
            const grew = plain.length - String(this.sentPreviewPlain ?? '').length;
            const stale = Date.now() - (this.lastSentAt || 0) >= STALE_FLUSH_MS;
            if (grew >= 0 && grew < MIN_DELTA_CHARS && !/\n$/.test(plain) && !stale) {
                this.pendingPreview = plain;
                this.schedule(this.throttle.minIntervalMs);
                return;
            }
        }
        const built = this.buildPayload(plain, { final: false });
        if (this.kind !== 'process' && built.built && built.payloadText === this.lastHtml) return;
        if (built.payloadText === this.sentPreview) return;
        if (this.finishing || this.finalized) return;
        const { payloadText, parseMode } = built;
        if (this.kind !== 'process' && built.built) this.lastHtml = built.payloadText;
        try {
            if (this.useDraft && !this.draftFailed) {
                await this.trackInflight(this.upstream.sendMessageDraft(
                    this.target.conversationId, this.draftId, payloadText.slice(0, 4096), {
                        ...targetOptions(this.target),
                        ...(parseMode ? { parseMode } : {}),
                    }));
            }
            else {
                if (!this.messageId) {
                    // First bubble carries real content (and the reply quote); record its id even if
                    // finish started meanwhile so the final edits it instead of sending a second one.
                    const sent = await this.trackInflight(this.upstream.sendMessage(
                        this.target.conversationId, payloadText.slice(0, 4096), targetOptions(this.target),
                        parseMode ? { parseMode } : undefined));
                    this.messageId = sent.messageId;
                }
                else {
                    await this.trackInflight(this.upstream.editMessageText(
                        this.target.conversationId, this.messageId, payloadText.slice(0, 4096),
                        parseMode ? { parseMode } : undefined));
                }
            }
            if (this.finishing || this.finalized) return;
            this.sentPreview = payloadText;
            this.sentPreviewPlain = plain;
            this.lastSentAt = Date.now();
            this.pendingPreview = undefined;
            this.throttle.mark();
            // More text arrived while the request was in flight: keep the stream moving.
            if (this.text && this.text !== plain) {
                this.pendingPreview = this.text;
                this.schedule(this.throttle.waitMs());
            }
        }
        catch (error) {
            if (this.finishing || this.finalized) return;
            if (this.useDraft && !this.draftFailed) {
                this.useDraft = false;
                this.draftFailed = true;
                this.options.onDraftFallback?.(error);
                if (this.finishing || this.finalized) return;
                this.pendingPreview = plain;
                await this.sync(false);
                return;
            }
            if (isRateLimitError(error)) {
                this.pendingPreview = plain;
                this.throttle.onRateLimit(error.parameters?.retryAfter);
                this.schedule(this.throttle.waitMs());
                return;
            }
            if (isFormatError(error) && parseMode && this.kind !== 'process') {
                try {
                    const escaped = escapeHtml(plain).slice(0, 4096);
                    if (this.messageId && !(this.finishing || this.finalized)) {
                        await this.trackInflight(this.upstream.editMessageText(
                            this.target.conversationId, this.messageId, escaped));
                    }
                    else if (!this.messageId && !this.useDraft) {
                        const sent = await this.trackInflight(this.upstream.sendMessage(
                            this.target.conversationId, escaped, targetOptions(this.target)));
                        this.messageId = sent.messageId;
                    }
                    if (this.finishing || this.finalized) return;
                    this.sentPreview = escaped;
                    this.sentPreviewPlain = plain;
                    this.pendingPreview = undefined;
                    this.throttle.mark();
                    return;
                }
                catch (inner) {
                    if (isRateLimitError(inner)) {
                        this.pendingPreview = plain;
                        this.throttle.onRateLimit(inner.parameters?.retryAfter);
                        this.schedule(this.throttle.waitMs());
                        return;
                    }
                    throw inner;
                }
            }
            throw error;
        }
        if (this.finishing || this.finalized) return;
        if (this.kind === 'text' && plain.length >= PREVIEW_LIMIT) {
            const { closed, tail, overflow } = splitClosedTail(plain, PREVIEW_LIMIT);
            if (overflow && tail) await this.sealAndContinue(closed, tail);
        }
    }
    async sealAndContinue(closed, tail) {
        if (this.finishing || this.finalized) return;
        // Finalize current preview in place (edit) or as a committed message (draft→send).
        this.text = closed;
        await this.sendFinalChunkOnly();
        if (this.finishing || this.finalized) return;
        this.messageId = undefined;
        this.draftId = this.useDraft ? nextDraftId() : undefined;
        this.sentPreview = undefined;
        this.sentPreviewPlain = undefined;
        this.lastHtml = '';
        this.text = tail;
        this.pendingPreview = tail;
        if (this.useDraft && !this.draftFailed) {
            try {
                await this.trackInflight(this.upstream.sendMessageDraft(
                    this.target.conversationId, this.draftId, '…', targetOptions(this.target)));
            }
            catch {
                this.useDraft = false;
                this.draftFailed = true;
            }
        }
        this.firstTextAt = undefined;
        if (this.finishing || this.finalized) return;
        await this.sync(false);
    }
    async startAsEdit() {
        if (this.messageId || this.finalized || this.finishing) return;
        const sent = await this.trackInflight(this.upstream.sendMessage(
            this.target.conversationId, this.placeholder || '…', targetOptions(this.target)));
        this.messageId = sent.messageId;
        if (this.finalized || this.finishing) return;
        this.sentPreview = this.placeholder || '…';
        this.throttle.mark();
    }
    async sendFinal() {
        const source = this.text || '';
        if (!source) {
            // Empty process/text: leave or drop the placeholder quietly (no second bubble).
            return;
        }
        if (this.kind === 'process') {
            await this.deliverHtml(source);
            return;
        }
        const mode = this.options.formatting?.mode ?? 'html';
        if (mode === 'html' || mode === 'auto') {
            const cleaned = source.replace(TRAILING_CURSOR, '');
            const chunks = buildFinalHtmlChunks(cleaned);
            await this.deliverHtmlChunks(chunks, cleaned);
            return;
        }
        if (this.options.richFinal && mode !== 'plain') {
            await this.sendRichFinal();
            return;
        }
        const cleaned = source.replace(TRAILING_CURSOR, '');
        const chunks = splitByGraphemes(cleaned, REGULAR_MESSAGE_MAX);
        await this.deliverPlainChunks(chunks);
    }
    /** Used by sealAndContinue: commit current text without flipping finalized flags. */
    async sendFinalChunkOnly() {
        const source = this.text || '';
        if (!source) return;
        if (this.kind === 'process') {
            await this.deliverHtml(source);
            return;
        }
        const mode = this.options.formatting?.mode ?? 'html';
        if (mode === 'html' || mode === 'auto') {
            const chunks = buildFinalHtmlChunks(source.replace(TRAILING_CURSOR, ''));
            await this.deliverHtmlChunks(chunks, source, { allowContinue: true });
            return;
        }
        const chunks = splitByGraphemes(source.replace(TRAILING_CURSOR, ''), REGULAR_MESSAGE_MAX);
        await this.deliverPlainChunks(chunks, { allowContinue: true });
    }
    /**
     * Deliver HTML: edit preview in place when messageId exists; otherwise one sendMessage.
     * Never send a second top-level message when a preview bubble already exists.
     */
    async deliverHtml(html) {
        if (this.messageId) {
            try {
                await this.editFinal(html, 'HTML');
            }
            catch (error) {
                if (isFormatError(error)) {
                    await this.editFinal(escapeHtml(html).slice(0, 4096));
                    return;
                }
                throw error;
            }
            this.useDraft = false;
            return;
        }
        // Pure draft path (or no preview yet): one real message dismisses the draft.
        const sent = await this.upstream.sendMessage(
            this.target.conversationId, html, targetOptions(this.target), { parseMode: 'HTML' });
        this.messageId = sent.messageId;
        this.useDraft = false;
    }
    async deliverHtmlChunks(chunks, source, { allowContinue = false } = {}) {
        const first = chunks[0] ?? '';
        if (this.messageId) {
            try {
                await this.editFinal(first, 'HTML');
            }
            catch (error) {
                if (isFormatError(error)) {
                    await this.editFinal(escapeHtml(source).slice(0, 4096));
                    this.useDraft = false;
                    return;
                }
                throw error;
            }
            this.useDraft = false;
        }
        else {
            const sent = await this.upstream.sendMessage(
                this.target.conversationId, first, targetOptions(this.target), { parseMode: 'HTML' });
            this.messageId = sent.messageId;
            this.useDraft = false;
        }
        // Overflow chunks are additional messages (no reply_to) — only for true length overflow.
        for (const chunk of chunks.slice(1)) {
            await this.upstream.sendMessage(
                this.target.conversationId, chunk, { messageThreadId: this.target.threadId }, { parseMode: 'HTML' });
        }
        if (allowContinue) {
            // Caller will start a fresh preview for the tail; clear id so the next bubble is new.
            this.messageId = undefined;
        }
    }
    async deliverPlainChunks(chunks, { allowContinue = false } = {}) {
        if (this.messageId) {
            if (this.sentPreview !== chunks[0]) await this.editFinal(chunks[0] ?? '');
            this.useDraft = false;
        }
        else {
            const sent = await this.upstream.sendMessage(
                this.target.conversationId, chunks[0] ?? '', targetOptions(this.target));
            this.messageId = sent.messageId;
            this.useDraft = false;
        }
        for (const chunk of chunks.slice(1)) {
            await this.upstream.sendMessage(
                this.target.conversationId, chunk, { messageThreadId: this.target.threadId });
        }
        if (allowContinue) this.messageId = undefined;
    }
    async sendRichFinal() {
        const source = (this.text || '').replace(TRAILING_CURSOR, '');
        if (!source) return;
        await sendWithFallback(source, { mode: 'rich-markdown' }, async (plan) => {
            if (plan.kind === 'rich') {
                if (this.messageId) await this.editFinalRich({ markdown: plan.texts[0] ?? '' });
                else {
                    // No rich-send without messageId in this patch path — fall through plain.
                    const sent = await this.upstream.sendMessage(this.target.conversationId, plan.texts[0] ?? '', targetOptions(this.target));
                    this.messageId = sent.messageId;
                }
                for (const text of plan.texts.slice(1)) {
                    await this.upstream.sendRichMessage(this.target.conversationId, { markdown: text });
                }
                return;
            }
            await this.deliverPlainChunks(plan.chunks);
        });
    }
    async editFinal(text, parseMode) {
        while (true) {
            await this.waitReady();
            try {
                await this.upstream.editMessageText(this.target.conversationId, this.messageId, text, parseMode ? { parseMode } : undefined);
                return;
            }
            catch (error) {
                if (!isRateLimitError(error)) throw error;
                this.throttle.onRateLimit(error.parameters?.retryAfter);
            }
        }
    }
    async editFinalRich(message) {
        while (true) {
            await this.waitReady();
            try {
                await this.upstream.editMessageRich(this.target.conversationId, this.messageId, message);
                return;
            }
            catch (error) {
                if (!isRateLimitError(error)) throw error;
                this.throttle.onRateLimit(error.parameters?.retryAfter);
            }
        }
    }
    cancelTimer() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
    }
    schedule(waitMs) {
        if (this.finishing || this.finalized || this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = undefined;
            if (this.finishing || this.finalized) return;
            void this.enqueue(() => this.sync(false)).catch(() => { });
        }, Math.max(1, waitMs));
    }
    async waitReady() {
        for (;;) {
            const w = this.throttle.waitMs();
            if (w <= 0) return;
            await new Promise((r) => setTimeout(r, w));
        }
    }
    trackInflight(promise) {
        const p = Promise.resolve(promise);
        this._inflight = p.then(() => undefined, () => undefined);
        return p;
    }
    enqueue(task) {
        const next = this.queue.then(task, task);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }
}

export function makePreview(text, limit) {
    if (visibleLength(text) <= limit) return text;
    return `…${text.slice(-(limit - 1))}`;
}

function messageOf(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}
function isRateLimitError(error) {
    return error instanceof TelegramApiError && error.kind === 'rate-limit';
}
function isFormatError(error) {
    return error instanceof TelegramApiError && error.kind === 'format';
}
function targetOptions(target) {
    return {
        replyToMessageId: target.replyToMessageId,
        messageThreadId: target.threadId,
    };
}