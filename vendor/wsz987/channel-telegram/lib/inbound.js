import { hydrateTelegramParts } from './media-hydrator.js';
import { dedupKey, isCallbackQueryUpdate, mapCallbackQuery, mapInbound, TelegramInboundValidationError, } from './mapper.js';
/** Compact per-part summary for inbound message logs (debug diagnostics). */
function summarizeParts(parts) {
    return parts.map((part) => {
        switch (part.type) {
            case 'text':
                return { type: 'text', text: part.text.slice(0, 80) };
            case 'image':
                return {
                    type: 'image',
                    url: part.url,
                    resourceRef: part.resourceRef,
                    mimeType: part.mimeType,
                    localDataBytes: part.localData?.byteLength,
                    ingressFailure: part.ingressFailure,
                };
            case 'file':
                return {
                    type: 'file',
                    name: part.name,
                    size: part.size,
                    mimeType: part.mimeType,
                    localDataBytes: part.localData?.byteLength,
                    ingressFailure: part.ingressFailure,
                };
            case 'audio':
                return {
                    type: 'audio',
                    durationMs: part.durationMs,
                    mimeType: part.mimeType,
                    localDataBytes: part.localData?.byteLength,
                    ingressFailure: part.ingressFailure,
                };
            case 'video':
                return {
                    type: 'video',
                    durationMs: part.durationMs,
                    mimeType: part.mimeType,
                    localDataBytes: part.localData?.byteLength,
                    ingressFailure: part.ingressFailure,
                };
            default:
                return { type: part.type };
        }
    });
}
export class InboundProcessor {
    options;
    now;
    /** dedup key -> last-seen timestamp, pruned on every handle. */
    seen = new Map();
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }
    /** Process one raw update from the upstream; dedup, hydrate, then emit. */
    async handle(raw) {
        const key = dedupKey(raw);
        if (this.options.dedupEnabled) {
            const now = this.now();
            const last = this.seen.get(key);
            if (last !== undefined && now - last < this.options.dedupWindowMs) {
                this.options.ctx.logger.debug(`[channel-telegram] dropped duplicate update '${key}'`);
                return;
            }
            this.prune(now);
        }
        if (isCallbackQueryUpdate(raw)) {
            await this.handleCallbackQuery(raw);
            if (this.options.dedupEnabled)
                this.seen.set(key, this.now());
            return;
        }
        try {
            await this.handleMessage(raw);
        }
        catch (error) {
            if (!(error instanceof TelegramInboundValidationError))
                throw error;
            // Invalid identities must not enter the contract or block the polling
            // cursor forever. This is intentionally a silent protocol-level drop.
            this.options.ctx.logger.warn('[channel-telegram] dropped invalid inbound update');
            return;
        }
        if (this.options.dedupEnabled)
            this.seen.set(key, this.now());
    }
    /** Map + ACK + emit a callback_query interaction. */
    async handleCallbackQuery(raw) {
        const event = mapCallbackQuery(raw, this.options.meta);
        // Immediate best-effort ACK (clears the button spinner). It must never
        // block on agent resolution, so any failure is logged, not propagated to
        // the emit.
        if (this.options.ackCallback) {
            void this.options.ackCallback(event.interactionId).catch((error) => {
                this.options.ctx.logger.warn('[channel-telegram] answerCallbackQuery failed', error instanceof Error ? error.message : error);
            });
        }
        this.options.ctx.logger.info(`[channel-telegram] inbound interaction ${event.interactionId} from ${event.sender.id} in ${event.conversation.id}`, { action: event.action.slice(0, 80) });
        await this.options.ctx.emit(event);
    }
    /** Map + hydrate + emit a message update. */
    async handleMessage(raw) {
        const event = mapInbound(raw, this.options.meta);
        if (this.options.files) {
            await hydrateTelegramParts(event.message.content, this.options.files, {
                maxBytes: this.options.maxDownloadBytes ?? 20 * 1024 * 1024,
                signal: this.options.ctx.signal,
                logger: this.options.ctx.logger,
            });
        }
        // Inbound message log (debug diagnostics): visible in web:debug with
        // DSH_CHANNELS_DEBUG=1, shows mapped parts incl. hydration result.
        this.options.ctx.logger.info(`[channel-telegram] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`, { parts: summarizeParts(event.message.content) });
        await this.options.ctx.emit(event);
    }
    prune(now) {
        for (const [key, ts] of this.seen) {
            if (now - ts >= this.options.dedupWindowMs)
                this.seen.delete(key);
        }
    }
}
//# sourceMappingURL=inbound.js.map