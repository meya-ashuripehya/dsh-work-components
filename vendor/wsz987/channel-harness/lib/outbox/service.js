import { resolveBindingForSession } from './binding-resolver.js';
import { targetFromBinding } from './target.js';
import { resolveOutboxCapabilities } from './capabilities.js';
import { OutboxError } from './types.js';
export class ChannelOutboxService {
    bindingStore;
    getAdapter;
    attachmentResolver;
    logger;
    constructor(options) {
        this.bindingStore = options.bindingStore;
        this.getAdapter = options.getAdapter;
        this.attachmentResolver = options.attachmentResolver;
        this.logger = options.logger;
    }
    /**
     * Send a proactive channel message on behalf of `sessionId`. Resolves the
     * durable binding, builds the outbound message, gates on proactive
     * capability (fail closed), and delivers through the adapter. Returns the
     * adapter's `SendResult`.
     */
    async send(sessionId, request, options = {}) {
        const signal = options.signal;
        if (signal?.aborted) {
            const err = new Error('channel outbox send aborted for session ' + sessionId);
            err.name = 'AbortError';
            throw err;
        }
        const binding = await resolveBindingForSession(sessionId, this.bindingStore);
        const target = targetFromBinding(binding);
        const adapter = this.getAdapter(binding.channelId);
        if (!adapter) {
            throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', "no channel adapter for channel '" + binding.channelId + "'", { sessionId });
        }
        const caps = resolveOutboxCapabilities(adapter);
        const hasText = !!request.text;
        const hasAttachment = !!request.attachmentId;
        if (!hasText && !hasAttachment) {
            throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', 'a channel outbound send requires text and/or an attachment', { sessionId });
        }
        if (hasText && !caps.proactiveText) {
            throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', "channel '" + binding.channelId + "' cannot proactively send text (proactiveText=false)", { sessionId });
        }
        if (hasAttachment && !caps.proactiveMedia) {
            throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', "channel '" + binding.channelId + "' cannot proactively send media (proactiveMedia=false)", { sessionId });
        }
        const message = { text: request.text };
        if (hasAttachment) {
            if (!this.attachmentResolver) {
                throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', 'outbound attachments require a private asset store that is not configured', { sessionId });
            }
            const asset = await this.attachmentResolver(request.attachmentId, sessionId);
            if (!adapter.capabilities[asset.kind]) {
                throw new OutboxError('OUTBOX_CAPABILITY_UNAVAILABLE', "channel '" + binding.channelId + "' cannot send " + asset.kind
                    + ' attachments (' + asset.kind + '=false)', { sessionId });
            }
            message.parts = [resolvedAttachmentPart(asset)];
        }
        this.logger.info("[channel-harness] outbox send session='" + sessionId + "' channel='" + binding.channelId
            + "' text=" + hasText + ' attachment=' + hasAttachment);
        const result = await adapter.send(target, message);
        this.logger.debug("[channel-harness] outbox sent session='" + sessionId + "' delivered=" + result.delivered);
        return result;
    }
}
function resolvedAttachmentPart(asset) {
    return {
        type: asset.kind,
        localData: asset.data,
        name: asset.name,
        ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    };
}
//# sourceMappingURL=service.js.map