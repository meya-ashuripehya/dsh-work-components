import { ChannelError, ChannelSendError } from '@wsz987/channel-core';
import { sendWithFallback } from './render/index.js';
/** Maximum Telegram `callback_data` size (1–64 bytes, plan §11). */
const CALLBACK_DATA_MAX_BYTES = 64;
/** Telegram ForceReply input placeholder length (Bot API 10.2). */
const FORCE_REPLY_PLACEHOLDER_MAX_CHARS = 64;
export class OutboundSender {
    upstream;
    logger;
    formatting;
    constructor(upstream, logger, options = {}) {
        this.upstream = upstream;
        this.logger = logger;
        this.formatting = { mode: 'auto', fallback: 'plain', ...options.formatting };
    }
    async send(target, message) {
        try {
            const replyMarkup = replyMarkupFor(message);
            const media = collectSendableMedia(message.parts);
            if (media.length > 0) {
                let last;
                for (const [index, item] of media.entries()) {
                    // The first attachment carries the textual caption; controls belong
                    // on the last message so SendResult.messageId is the interaction id.
                    last = await this.sendMediaWithFormatting(target, item, index === 0 ? message : { ...message, text: undefined }, index === media.length - 1 ? replyMarkup : undefined);
                }
                if (!last)
                    throw new ChannelSendError('telegram media send produced no message');
                return { delivered: true, messageId: last.messageId, raw: last.raw };
            }
            const text = message.text ?? '';
            if (!text) {
                throw new ChannelSendError('telegram message has no sendable text or media');
            }
            const response = await this.sendTextWithFormatting(target, text, sendOptions(target, message), replyMarkup);
            return { delivered: true, messageId: response.messageId, raw: response.raw };
        }
        catch (error) {
            this.logger.error(`[channel-telegram] send failed to '${target.conversationId}'`, error instanceof Error ? error.message : error);
            // Preserve TelegramApiError fields (kind/errorCode/retryAfter) and
            // adapter-generated ChannelSendError diagnostics for outer policy.
            if (error instanceof ChannelError)
                throw error;
            throw new ChannelSendError(`telegram send failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    /** Send text through the configured renderer with exact-once fallback. */
    async sendTextWithFormatting(target, source, options, replyMarkup) {
        const send = async (plan) => {
            if (plan.kind === 'rich') {
                let last;
                for (const [index, text] of plan.texts.entries()) {
                    last = await this.upstream.sendRichMessage(target.conversationId, { markdown: text }, options, { ...(replyMarkup && index === plan.texts.length - 1 ? { replyMarkup } : {}) });
                }
                if (!last)
                    throw new ChannelSendError('telegram rich send produced no message');
                return last;
            }
            let last;
            for (const [index, chunk] of plan.chunks.entries()) {
                last = await this.upstream.sendMessage(target.conversationId, chunk, options, {
                    ...(plan.parseMode ? { parseMode: plan.parseMode } : {}),
                    ...(replyMarkup && index === plan.chunks.length - 1 ? { replyMarkup } : {}),
                });
            }
            if (!last)
                throw new ChannelSendError('telegram text send produced no message');
            return last;
        };
        return sendWithFallback(source, { mode: this.formatting.mode }, send);
    }
    /** Send media with the text rendered as a ≤1024 caption (plain fallback). */
    async sendMediaWithFormatting(target, media, message, replyMarkup) {
        const sendOptions = {
            replyToMessageId: message.replyTo ?? target.replyToMessageId,
            messageThreadId: target.threadId,
        };
        const sendWithoutCaption = async () => {
            return this.upstream.sendMedia(target.conversationId, media, sendOptions, { ...(replyMarkup ? { replyMarkup } : {}) });
        };
        const caption = message.text ?? '';
        if (!caption)
            return sendWithoutCaption();
        const plainCaption = markdownToPlainCaption(caption);
        // Captions are rendered as plain text (rich/HTML media captions are out of
        // scope); any format error falls back to the stripped caption once.
        try {
            return await this.upstream.sendMedia(target.conversationId, { ...media, caption: truncateCaption(plainCaption) }, sendOptions, { ...(replyMarkup ? { replyMarkup } : {}) });
        }
        catch (error) {
            if (isFormattingFailure(error)) {
                return this.upstream.sendMedia(target.conversationId, { ...media, caption: truncateCaption(markdownToPlainCaption(caption)) }, sendOptions, { ...(replyMarkup ? { replyMarkup } : {}) });
            }
            throw error;
        }
    }
}
/** Whether an error is a formatting failure eligible for plain fallback. */
function isFormattingFailure(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.kind === 'format');
}
/** Plain caption text (stripped of markdown) for the fallback path. */
function markdownToPlainCaption(source) {
    return source
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}
/** Caption cap: 1024 grapheme clusters (plan §7.1). */
const CAPTION_MAX_GRAPHEMES = 1024;
/** Truncate a caption to at most 1024 grapheme clusters, never mid-cluster. */
function truncateCaption(text) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const graphemes = [...segmenter.segment(text)].map((s) => s.segment);
    if (graphemes.length <= CAPTION_MAX_GRAPHEMES)
        return text;
    return graphemes.slice(0, CAPTION_MAX_GRAPHEMES).join('');
}
/**
 * Map `OutboundMessage.actions` to a Telegram `InlineKeyboardMarkup`.
 *
 * Each row becomes one inline-keyboard row; each action becomes a button with
 * `text = label`, `callback_data = id` and the mapped style. An action id that
 * exceeds Telegram's 64-byte `callback_data` cap fails closed (we cannot
 * round-trip a truncated id), rather than silently dropping the button.
 */
export function actionsToReplyMarkup(actions) {
    if (!actions || actions.length === 0)
        return undefined;
    const rows = [];
    for (const row of actions) {
        const buttons = [];
        for (const action of row.actions) {
            const idBytes = new TextEncoder().encode(action.id).byteLength;
            if (idBytes > CALLBACK_DATA_MAX_BYTES) {
                throw new ChannelSendError(`telegram action id exceeds ${CALLBACK_DATA_MAX_BYTES}-byte callback_data limit`);
            }
            buttons.push({
                text: action.label,
                callback_data: action.id,
                ...(action.style && action.style !== 'default' ? { style: action.style } : {}),
            });
        }
        if (buttons.length > 0)
            rows.push(buttons);
    }
    if (rows.length === 0)
        return undefined;
    return { inline_keyboard: rows };
}
/**
 * Convert every binary part to media. An unsupported carrier fails before
 * delivery begins, so a message can never silently omit a later attachment.
 */
function collectSendableMedia(parts) {
    const media = [];
    for (const part of parts ?? []) {
        switch (part.type) {
            case 'image':
            case 'file':
            case 'audio':
            case 'video': {
                if (part.localData) {
                    media.push({
                        type: part.type,
                        localData: part.localData,
                        mimeType: part.mimeType,
                        name: part.name,
                    });
                    break;
                }
                const ref = part.url ?? part.resourceRef;
                if (ref) {
                    media.push({ type: part.type, url: ref, mimeType: part.mimeType, name: part.name });
                    break;
                }
                throw new ChannelSendError(`telegram ${part.type} media has no supported localData, url, or resourceRef carrier`);
            }
        }
    }
    return media;
}
/**
 * Telegram does not permit ForceReply and an inline keyboard on the same
 * message. Treat the generic contract as mutually exclusive so a caller never
 * accidentally creates an uncorrelatable custom-answer prompt.
 */
function replyMarkupFor(message) {
    if (message.replyPrompt) {
        if (message.actions?.length) {
            throw new ChannelSendError('telegram replyPrompt cannot be combined with inline actions');
        }
        const placeholder = message.replyPrompt.placeholder;
        if (placeholder && [...placeholder].length > FORCE_REPLY_PLACEHOLDER_MAX_CHARS) {
            throw new ChannelSendError(`telegram replyPrompt placeholder exceeds ${FORCE_REPLY_PLACEHOLDER_MAX_CHARS}-character limit`);
        }
        return {
            force_reply: true,
            ...(placeholder
                ? { input_field_placeholder: placeholder }
                : {}),
        };
    }
    return actionsToReplyMarkup(message.actions);
}
function sendOptions(target, message) {
    return {
        replyToMessageId: message.replyTo ?? target.replyToMessageId,
        messageThreadId: target.threadId,
    };
}
//# sourceMappingURL=outbound.js.map