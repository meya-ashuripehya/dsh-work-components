/**
 * Telegram upstream driver — the only module that knows the Bot API.
 *
 * The upstream is SDK-agnostic: it speaks the Telegram Bot API HTTP protocol
 * directly (`/bot<token>/...`), so no SDK dependency is required (manifest
 * strategy 'source'). The token only ever appears in the request path built
 * here; it is never logged and never cached beyond the config value.
 *
 * Long-poll semantics: every getUpdates call carries the acknowledged offset,
 * so Telegram stops redelivering confirmed updates (the offset IS the
 * protocol-level dedup mechanism). The InboundProcessor dedup window is the
 * adapter-level second layer for webhook-style redelivery inside one cycle.
 *
 * ## Structured errors (plan §3.1 / §5.4)
 *
 * Every non-ok / invalid envelope is converted at this boundary into a
 * `TelegramApiError` (see `api-error.ts`) that preserves Telegram's
 * `error_code` / `description` / `parameters` and carries a stable kind. This
 * lets the renderer and reply engine distinguish a formatting parse failure
 * (→ one-shot plain fallback) from 401/403 / 429 / network / 5xx without
 * re-classifying raw numbers.
 */
import { ChannelError, mimeHintFromFilename, normalizeMimeHint, } from '@wsz987/channel-core';
import { z } from 'zod';
import { classifyTelegramError, TelegramApiError } from './api-error.js';
/**
 * Bot API envelope shared by every method: `{ ok, result?, error_code?,
 * description?, parameters? }`. Validated with zod (not hand-rolled casts) at
 * the upstream boundary, matching the official adapters' response-validation
 * pattern.
 */
const apiResponseSchema = z.object({
    ok: z.boolean(),
    result: z.unknown().optional(),
    error_code: z.number().optional(),
    description: z.string().optional(),
    parameters: z.object({
        retry_after: z.number().optional(),
        migrate_to_chat_id: z.number().optional(),
    }).optional(),
}).passthrough();
/** `getMe` result: the bot user. */
const botUserSchema = z.object({
    id: z.number(),
    is_bot: z.boolean(),
    first_name: z.string().optional(),
    username: z.string().optional(),
}).passthrough();
/** `getUpdates` result: a list of raw updates (shape owned by the mapper). */
const getUpdatesResultSchema = z.array(z.object({
    update_id: z.number(),
}).passthrough());
/** `sendMessage` result: the sent message id. */
const sentMessageSchema = z.object({
    message_id: z.number(),
}).passthrough();
/** `getFile` result: file metadata, including the download path. */
const fileSchema = z.object({
    file_id: z.string(),
    file_unique_id: z.string(),
    file_size: z.number().optional(),
    file_path: z.string().optional(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
}).passthrough();
/** HTTP implementation over the Telegram Bot API. */
export class HttpTelegramUpstream {
    options;
    constructor(options) {
        this.options = options;
    }
    path(endpoint) {
        return `/bot${this.options.token ?? ''}/${endpoint}`;
    }
    filePath(filePath) {
        return `/file/bot${this.options.token ?? ''}/${filePath.replace(/^\/+/, '')}`;
    }
    async getMe() {
        const envelope = await this.requestOk('getMe');
        const user = botUserSchema.safeParse(envelope.data.result);
        if (!user.success) {
            throw new ChannelError('CHANNEL_ERROR', 'telegram getMe returned no bot user');
        }
        return user.data;
    }
    async deleteWebhook() {
        const raw = await this.post('deleteWebhook', { drop_pending_updates: false });
        const envelope = this.parseEnvelope('deleteWebhook', raw);
        if (!envelope.data.ok || envelope.data.result !== true) {
            throw this.apiError('deleteWebhook', envelope.data);
        }
    }
    async getUpdates(cursor, signal, onUpdate, onPoll) {
        while (!signal.aborted) {
            let raw;
            try {
                raw = await this.options.transport.request(this.path('getUpdates'), {
                    method: 'POST',
                    body: {
                        offset: cursor.offset,
                        // Telegram's long-poll timeout parameter is in seconds; the
                        // HTTP request timeout must exceed it so the fetch outlives
                        // the poll window.
                        timeout: Math.max(1, Math.floor(this.options.longPollTimeoutMs / 1000)),
                        // Plan §3.4 / §5: subscribe to interactive callback_query updates
                        // in addition to plain messages.
                        allowed_updates: ['message', 'callback_query'],
                    },
                    timeoutMs: this.options.longPollTimeoutMs + 5000,
                }, signal);
            }
            catch (error) {
                // Abort-driven teardown exits gracefully; other failures propagate to
                // the adapter, which owns reconnect/backoff.
                if (signal.aborted)
                    return;
                throw this.networkError('getUpdates', error);
            }
            const envelope = this.parseEnvelope('getUpdates', raw);
            if (!envelope.data.ok) {
                throw this.apiError('getUpdates', envelope.data);
            }
            const result = getUpdatesResultSchema.safeParse(envelope.data.result ?? []);
            if (!result.success) {
                throw new ChannelError('CHANNEL_ERROR', 'telegram getUpdates returned an invalid response');
            }
            onPoll?.();
            for (const update of result.data) {
                if (signal.aborted)
                    return;
                await onUpdate(update);
                // Commit only after dispatch succeeds. The shared cursor survives a
                // thrown handler and is reused by the adapter's reconnect attempt.
                cursor.offset = Math.max(cursor.offset, update.update_id + 1);
            }
        }
    }
    async sendText(chatId, text, options) {
        return this.sendMessage(chatId, text, options);
    }
    async sendMessage(chatId, text, options, format) {
        const envelope = await this.sendMessageRaw(chatId, text, options, format);
        return this.sentMessage('sendMessage', envelope.data);
    }
    /**
     * [dsh-workbench patch] Bot API sendMessageDraft — stream a partial message in a private chat.
     * Same draft_id updates animate; does not create a permanent message until sendMessage.
     */
    async sendMessageDraft(chatId, draftId, text, options) {
        const numericChatId = Number(chatId);
        if (!Number.isSafeInteger(numericChatId)) {
            throw new ChannelError('CHANNEL_ERROR', 'telegram message drafts require a numeric private chat id');
        }
        const body = {
            chat_id: numericChatId,
            draft_id: Number(draftId),
            text: String(text ?? ''),
        };
        if (options?.messageThreadId !== undefined)
            body.message_thread_id = Number(options.messageThreadId);
        if (options?.parseMode !== undefined)
            body.parse_mode = options.parseMode;
        const raw = await this.post('sendMessageDraft', body);
        const envelope = this.parseEnvelope('sendMessageDraft', raw);
        if (!envelope.data.ok) {
            throw this.apiError('sendMessageDraft', envelope.data);
        }
        return envelope.data.result;
    }
    /** Send a formatted text message; returns the parsed, ok-checked envelope. */
    async sendMessageRaw(chatId, text, options, format) {
        const raw = await this.post('sendMessage', this.messageBody(chatId, { text }, options, format));
        const envelope = this.parseEnvelope('sendMessage', raw);
        if (!envelope.data.ok) {
            throw this.apiError('sendMessage', envelope.data);
        }
        return envelope;
    }
    async editMessageText(chatId, messageId, text, format) {
        const body = {
            chat_id: chatId,
            message_id: Number(messageId),
            text,
        };
        this.applyFormatToBody(body, format, false);
        const raw = await this.post('editMessageText', body);
        const envelope = this.parseEnvelope('editMessageText', raw);
        if (!envelope.data.ok) {
            throw this.apiError('editMessageText', envelope.data);
        }
        return envelope.data.result;
    }
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
        const body = {
            chat_id: chatId,
            message_id: Number(messageId),
        };
        if (replyMarkup !== undefined)
            body.reply_markup = replyMarkup;
        const raw = await this.post('editMessageReplyMarkup', body);
        const envelope = this.parseEnvelope('editMessageReplyMarkup', raw);
        if (!envelope.data.ok) {
            throw this.apiError('editMessageReplyMarkup', envelope.data);
        }
        return envelope.data.result;
    }
    async sendRichMessage(chatId, message, options, format) {
        const raw = await this.post('sendRichMessage', this.messageBody(chatId, { rich_message: message }, options, format?.replyMarkup ? { replyMarkup: format.replyMarkup } : undefined));
        const envelope = this.parseEnvelope('sendRichMessage', raw);
        if (!envelope.data.ok) {
            throw this.apiError('sendRichMessage', envelope.data);
        }
        return this.sentMessage('sendRichMessage', envelope.data);
    }
    async sendRichMessageDraft(chatId, draftId, message, options) {
        const numericChatId = Number(chatId);
        if (!Number.isSafeInteger(numericChatId)) {
            throw new ChannelError('CHANNEL_ERROR', 'telegram rich drafts require a numeric private chat id');
        }
        const raw = await this.post('sendRichMessageDraft', {
            chat_id: numericChatId,
            draft_id: draftId,
            rich_message: message,
            ...(options?.messageThreadId ? { message_thread_id: Number(options.messageThreadId) } : {}),
        });
        const envelope = this.parseEnvelope('sendRichMessageDraft', raw);
        if (!envelope.data.ok) {
            throw this.apiError('sendRichMessageDraft', envelope.data);
        }
        return envelope.data.result;
    }
    async editMessageRich(chatId, messageId, message, replyMarkup) {
        const raw = await this.post('editMessageText', {
            chat_id: chatId,
            message_id: Number(messageId),
            rich_message: message,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        const envelope = this.parseEnvelope('editMessageText', raw);
        if (!envelope.data.ok) {
            throw this.apiError('editMessageText', envelope.data);
        }
        return envelope.data.result;
    }
    async answerCallbackQuery(params) {
        const raw = await this.post('answerCallbackQuery', { callback_query_id: params.callback_query_id });
        const envelope = this.parseEnvelope('answerCallbackQuery', raw);
        if (!envelope.data.ok) {
            throw this.apiError('answerCallbackQuery', envelope.data);
        }
    }
    async getFile(fileId) {
        const raw = await this.post('getFile', { file_id: fileId });
        const envelope = this.parseEnvelope('getFile', raw);
        if (!envelope.data.ok) {
            throw this.apiError('getFile', envelope.data);
        }
        const file = fileSchema.safeParse(envelope.data.result);
        if (!file.success) {
            throw new ChannelError('CHANNEL_ERROR', 'telegram getFile returned no file metadata');
        }
        return {
            fileId: file.data.file_id,
            fileUniqueId: file.data.file_unique_id,
            fileSize: file.data.file_size,
            filePath: file.data.file_path,
            mimeType: file.data.mime_type,
            fileName: file.data.file_name,
        };
    }
    async downloadFile(fileId, signal) {
        const file = await this.getFile(fileId);
        if (!file.filePath) {
            throw new ChannelError('CHANNEL_ERROR', 'telegram getFile returned no file_path');
        }
        if (!this.options.transport.requestBinary) {
            throw new ChannelError('CHANNEL_UNSUPPORTED', 'telegram transport does not support binary downloads');
        }
        // Keep the transport receiver intact. FetchTransport.requestBinary uses
        // `this.requestResponse`; extracting the method would lose that binding.
        const response = await this.options.transport.requestBinary(this.filePath(file.filePath), {}, signal);
        const pathName = file.filePath.split('/').pop();
        const name = file.fileName ?? filenameFromDisposition(response.contentDisposition) ?? pathName;
        const mimeType = normalizeMimeHint(file.mimeType)
            ?? normalizeMimeHint(response.contentType)
            ?? mimeHintFromFilename(name);
        return { data: response.data, mimeType, name };
    }
    async sendMedia(chatId, media, options, format) {
        const endpointAndField = {
            image: ['sendPhoto', 'photo'],
            file: ['sendDocument', 'document'],
            audio: ['sendAudio', 'audio'],
            video: ['sendVideo', 'video'],
        };
        const [endpoint, field] = endpointAndField[media.type];
        if (media.localData) {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append(field, new Blob([media.localData], { type: media.mimeType ?? 'application/octet-stream' }), media.name ?? defaultMediaName(media.type));
            if (media.caption !== undefined)
                form.append('caption', media.caption);
            if (format?.parseMode !== undefined)
                form.append('caption_parse_mode', format.parseMode);
            if (format?.captionEntities !== undefined)
                form.append('caption_entities', JSON.stringify(format.captionEntities));
            if (format?.replyMarkup !== undefined)
                form.append('reply_markup', JSON.stringify(format.replyMarkup));
            this.appendSendOptions(form, options);
            return this.sendMediaRequest(endpoint, form);
        }
        if (!media.url) {
            throw new ChannelError('CHANNEL_UNSUPPORTED', 'telegram media requires localData, url, or resourceRef');
        }
        const mediaWithUrl = { ...media, url: media.url };
        switch (media.type) {
            case 'image':
                return this.sendMediaRequest('sendPhoto', this.mediaBody(chatId, mediaWithUrl, 'photo', options, format));
            case 'file':
                return this.sendMediaRequest('sendDocument', this.mediaBody(chatId, mediaWithUrl, 'document', options, format));
            case 'audio':
                return this.sendMediaRequest('sendAudio', this.mediaBody(chatId, mediaWithUrl, 'audio', options, format));
            case 'video':
                return this.sendMediaRequest('sendVideo', this.mediaBody(chatId, mediaWithUrl, 'video', options, format));
            default:
                // Exhaustive over TelegramMedia['type']; kept for safety.
                throw new ChannelError('CHANNEL_UNSUPPORTED', `telegram media type '${String(media.type)}' unsupported`);
        }
    }
    mediaBody(chatId, media, field, options, format) {
        const body = { chat_id: chatId, [field]: media.url };
        if (media.caption !== undefined)
            body.caption = media.caption;
        this.applyFormatToBody(body, format, true);
        return this.messageBody(chatId, body, options);
    }
    async sendChatAction(chatId, action, options) {
        await this.requestOk('sendChatAction', {
            chat_id: chatId,
            action,
            ...(options?.messageThreadId ? { message_thread_id: Number(options.messageThreadId) } : {}),
        });
    }
    async sendMediaRequest(endpoint, body) {
        const raw = await this.post(endpoint, body);
        const envelope = this.parseEnvelope(endpoint, raw);
        if (!envelope.data.ok) {
            throw this.apiError(endpoint, envelope.data);
        }
        return this.sentMessage(endpoint, envelope.data);
    }
    /** Apply formatting fields to a JSON body (caption vs text variants). */
    applyFormatToBody(body, format, caption) {
        if (!format)
            return;
        if (caption) {
            if (format.parseMode !== undefined)
                body.caption_parse_mode = format.parseMode;
            if (format.captionEntities !== undefined)
                body.caption_entities = format.captionEntities;
        }
        else {
            if (format.parseMode !== undefined)
                body.parse_mode = format.parseMode;
            if (format.entities !== undefined)
                body.entities = format.entities;
        }
        if (format.replyMarkup !== undefined)
            body.reply_markup = format.replyMarkup;
    }
    messageBody(chatId, body, options, format) {
        const result = { chat_id: chatId, ...body };
        if (options?.replyToMessageId) {
            result.reply_parameters = { message_id: Number(options.replyToMessageId) };
        }
        if (options?.messageThreadId)
            result.message_thread_id = Number(options.messageThreadId);
        if (format)
            this.applyFormatToBody(result, format, false);
        return result;
    }
    appendSendOptions(form, options) {
        if (options?.replyToMessageId) {
            form.append('reply_parameters', JSON.stringify({ message_id: Number(options.replyToMessageId) }));
        }
        if (options?.messageThreadId)
            form.append('message_thread_id', options.messageThreadId);
    }
    async post(endpoint, body) {
        try {
            return await this.options.transport.request(this.path(endpoint), { method: 'POST', body });
        }
        catch (error) {
            if (error instanceof TelegramApiError)
                throw error;
            throw this.networkError(endpoint, error);
        }
    }
    /**
     * Issue a request and return a parsed, ok-checked envelope — or throw a
     * structured `TelegramApiError`. This is the single envelope boundary: the
     * sendMessage "invalid response" catch-all is replaced here.
     */
    async requestOk(endpoint, body) {
        const raw = await this.post(endpoint, body ?? {});
        const envelope = this.parseEnvelope(endpoint, raw);
        if (!envelope.data.ok) {
            throw this.apiError(endpoint, envelope.data);
        }
        return envelope;
    }
    /**
     * Parse a raw response into the envelope shape; a body that is not a valid
     * Bot API envelope is a network/protocol-level failure, not a format issue.
     */
    parseEnvelope(endpoint, raw) {
        const envelope = apiResponseSchema.safeParse(raw);
        if (!envelope.success) {
            throw new TelegramApiError({
                method: endpoint,
                kind: 'network',
                description: 'invalid Bot API response envelope',
            });
        }
        return envelope;
    }
    /** Validate every Bot API method that returns a Message through one boundary. */
    sentMessage(endpoint, envelope) {
        const sent = sentMessageSchema.safeParse(envelope.result);
        if (!sent.success) {
            throw new ChannelError('CHANNEL_ERROR', `telegram ${endpoint} returned no message_id`);
        }
        return { messageId: String(sent.data.message_id), raw: envelope };
    }
    /** Build a structured `TelegramApiError` from an ok=false envelope. */
    apiError(endpoint, envelope) {
        const params = envelope.parameters
            ? { retryAfter: envelope.parameters.retry_after, migrateToChatId: envelope.parameters.migrate_to_chat_id }
            : undefined;
        const kind = classifyTelegramError(envelope.error_code, envelope.description, params);
        return new TelegramApiError({
            method: endpoint,
            errorCode: envelope.error_code,
            description: envelope.description,
            parameters: params,
            kind,
        });
    }
    /** Wrap a transport/network failure into a structured network-kind error. */
    networkError(endpoint, error) {
        const message = error instanceof Error ? error.message : String(error);
        return new TelegramApiError({
            method: endpoint,
            kind: 'network',
            description: message,
            cause: error,
        });
    }
}
function filenameFromDisposition(value) {
    if (!value)
        return undefined;
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded);
        }
        catch {
            return encoded;
        }
    }
    return /filename="?([^";]+)"?/i.exec(value)?.[1]?.trim();
}
function defaultMediaName(type) {
    return type === 'image' ? 'image' : type === 'file' ? 'file' : type === 'audio' ? 'audio' : 'video';
}
//# sourceMappingURL=upstream.js.map