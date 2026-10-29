import { SecureRemoteMediaFetcher } from '@wsz987/channel-core';
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
import { mapInbound } from './mapper.js';
import { hydrateMediaParts } from './media-hydrator.js';
export class InboundProcessor {
    options;
    now;
    secureFetch;
    mediaHydration;
    /** messageId -> last-seen timestamp, pruned on every handle. */
    seen = new Map();
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.secureFetch = options.secureFetch ?? new SecureRemoteMediaFetcher();
        this.mediaHydration = options.mediaHydration ?? options.imageHydration ?? {};
    }
    /** Process one SDK inbound message; dedup, hydrate media, then emit. */
    async handle(raw) {
        if (raw.kind !== 'c2c' && raw.kind !== 'group') {
            this.options.ctx.logger.debug(`[channel-qq] dropping unsupported inbound kind '${raw.kind}'`);
            return;
        }
        const key = raw.messageId;
        if (this.options.dedupEnabled) {
            const now = this.now();
            const last = this.seen.get(key);
            if (last !== undefined && now - last < this.options.dedupWindowMs) {
                this.options.ctx.logger.debug(`[channel-qq] dropped duplicate message '${key}'`);
                return;
            }
            this.seen.set(key, now);
            this.prune(now);
        }
        const event = mapInbound(raw, this.options.meta);
        // Hydrate media bytes before emit so the harness attachment paths receive
        // real bytes. Never throws; failures degrade the part.
        await hydrateMediaParts(event.message.content, this.secureFetch, {
            ...this.mediaHydration,
            signal: this.options.ctx.signal,
        });
        // Inbound message log (debug diagnostics): visible in web:debug with
        // DSH_CHANNELS_DEBUG=1, shows mapped parts incl. hydration result.
        this.options.ctx.logger.info(`[channel-qq] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`, { parts: summarizeParts(event.message.content) });
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