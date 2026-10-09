import { TelegramApiError } from './api-error.js';
import { RICH_MESSAGE_MAX_UTF8 } from './rich-message.js';
import { truncateGraphemes } from './render/segment.js';
import { sendWithFallback } from './render/index.js';
/** A non-zero integer that identifies this reply stream across draft updates. */
function newDraftId() {
    const value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    return value === 0 ? 1 : value;
}
export class TelegramRichStreamingReply {
    upstream;
    target;
    placeholder;
    options;
    text = '';
    draftId;
    started = false;
    finalized = false;
    draftPending = false;
    finalPending = false;
    cooldownUntil = 0;
    cooldownTimer;
    queue = Promise.resolve();
    constructor(upstream, target, placeholder = '…', options = {}, draftId) {
        this.upstream = upstream;
        this.target = target;
        this.placeholder = placeholder;
        this.options = options;
        this.draftId = draftId ?? newDraftId();
    }
    get activeDraftId() {
        return this.draftId;
    }
    /** Open the temporary draft preview. */
    async start() {
        if (this.started)
            return;
        this.started = true;
        this.draftPending = true;
        await this.flushDraft(this.placeholder);
    }
    append(delta) {
        return this.replace({ text: this.text + delta });
    }
    replace(message) {
        return this.enqueue(async () => {
            if (this.finalized)
                return;
            if (message.text === undefined)
                return;
            this.text = message.text;
            this.draftPending = true;
            await this.flushDraft();
        });
    }
    finish(message) {
        return this.enqueue(async () => {
            if (this.finalized)
                return;
            if (message?.text !== undefined)
                this.text = message.text;
            this.draftPending = false;
            this.finalPending = true;
            await this.flushFinal();
        });
    }
    fail(error) {
        return this.enqueue(async () => {
            if (this.finalized)
                return;
            if (isRateLimit(error))
                return;
            this.finalized = true;
            this.clearCooldown();
            const msg = `Warning: ${messageOf(error)}`;
            try {
                await sendWithFallback(msg, { mode: 'plain' }, (plan) => {
                    const text = plan.kind === 'rich' ? (plan.texts[0] ?? '') : (plan.chunks[0] ?? '');
                    return this.upstream.sendMessage(this.target.conversationId, text);
                });
            }
            catch {
                // Marking failure must not mask the original error.
            }
        });
    }
    /** Re-send the same draft id with the newest partial Markdown preview. */
    async flushDraft(placeholder) {
        if (!this.started || !this.draftPending || this.inCooldown())
            return;
        const source = this.text || placeholder;
        if (!source)
            return;
        try {
            await this.upstream.sendRichMessageDraft(this.target.conversationId, this.draftId, { markdown: truncateGraphemes(source, RICH_MESSAGE_MAX_UTF8) }, targetOptions(this.target));
            this.draftPending = false;
        }
        catch (error) {
            if (!isRateLimit(error))
                throw error;
            this.enterCooldown(error);
        }
    }
    /**
     * Persist the final result. For DM rich mode the final is one (or, when
     * overflowing, several) `sendRichMessage` calls carrying the complete
     * Markdown; a format failure falls back to plain exactly once.
     */
    async flushFinal() {
        if (!this.finalPending || this.inCooldown())
            return;
        try {
            await this.sendFinal();
            this.finalPending = false;
            this.finalized = true;
            this.clearCooldown();
        }
        catch (error) {
            if (!isRateLimit(error))
                throw error;
            this.enterCooldown(error);
        }
    }
    async sendFinal() {
        const options = {
            mode: this.options.formatting?.mode ?? 'auto',
        };
        const source = this.text;
        if (!source)
            return;
        await sendWithFallback(source, options, async (plan) => {
            if (plan.kind === 'rich') {
                for (const text of plan.texts) {
                    await this.upstream.sendRichMessage(this.target.conversationId, { markdown: text }, targetOptions(this.target));
                }
                return;
            }
            // plain fallback path.
            for (const chunk of plan.chunks) {
                await this.upstream.sendMessage(this.target.conversationId, chunk, targetOptions(this.target), plan.parseMode ? { parseMode: plan.parseMode } : undefined);
            }
        });
    }
    enqueue(task) {
        const next = this.queue.then(task, task);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }
    inCooldown() {
        if (Date.now() >= this.cooldownUntil)
            return false;
        this.scheduleCooldown();
        return true;
    }
    /** Keep only the current draft/final state while Telegram asks us to wait. */
    enterCooldown(error) {
        const seconds = error.parameters?.retryAfter;
        const delay = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
            ? Math.ceil(seconds * 1000)
            : 1_000;
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
        this.scheduleCooldown();
    }
    scheduleCooldown() {
        if (this.cooldownTimer || this.finalized)
            return;
        const delay = Math.max(0, this.cooldownUntil - Date.now());
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = undefined;
            void this.enqueue(async () => {
                if (this.finalized)
                    return;
                if (this.finalPending) {
                    await this.flushFinal();
                }
                else {
                    await this.flushDraft();
                }
            });
        }, delay);
    }
    clearCooldown() {
        this.cooldownUntil = 0;
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = undefined;
        }
    }
}
function isRateLimit(error) {
    return error instanceof TelegramApiError || (typeof error === 'object'
        && error !== null
        && 'kind' in error
        && error.kind === 'rate-limit');
}
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
function targetOptions(target) {
    return {
        replyToMessageId: target.replyToMessageId,
        messageThreadId: target.threadId,
    };
}
//# sourceMappingURL=rich-streaming-reply.js.map