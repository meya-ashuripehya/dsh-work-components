import { textParts } from '@wsz987/channel-core';
import { z } from 'zod';
const qqMentionsSchema = z.array(z.object({
    is_you: z.boolean().optional(),
}).passthrough());
/**
 * Map one Tencent SDK inbound message into the stable channel event shape.
 *
 * - C2C    → conversation.id = `senderId`, type `dm`
 * - Group  → conversation.id = `groupOpenid`, type `group`
 * Other kinds (`guild`/`dm`) are not formally supported in V1 and are dropped
 * by the `InboundProcessor` before they reach this mapper.
 */
export function mapInbound(msg, meta) {
    const group = msg.kind === 'group';
    return {
        type: 'message.received',
        channel: meta.channel,
        accountId: meta.accountId,
        conversation: {
            id: (group ? msg.groupOpenid : msg.senderId),
            type: group ? 'group' : 'dm',
        },
        sender: {
            id: msg.senderId,
            name: msg.senderName,
        },
        message: {
            id: msg.messageId,
            content: mapMessageParts(msg),
            createdAt: Date.parse(msg.timestamp),
            ...(group
                ? { activation: { mentionedBot: qqMessageMentionedBot(msg) } }
                : {}),
        },
        raw: msg.raw,
    };
}
/**
 * Map an SDK inbound message's text + attachments into structured parts.
 *
 * Text comes from `msg.content`; each attachment is mapped by its
 * `content_type` (image/voice/audio/video/file → typed parts, unknown →
 * unsupported).
 */
export function mapMessageParts(msg) {
    const parts = [];
    const content = normalizeInboundText(msg);
    if (content) {
        parts.push(...textParts(content));
    }
    for (const attachment of msg.attachments ?? []) {
        const part = mapAttachment(attachment);
        if (part)
            parts.push(part);
    }
    // A message with no content and no attachments becomes a single unsupported
    // part so it is never silently empty.
    if (parts.length === 0) {
        parts.push({ type: 'unsupported', reason: 'empty qq message' });
    }
    return parts;
}
/**
 * New QQ group-at events are a reliable activation fact. Their textual body
 * may still start with the platform `<@...>` marker; remove only that leading
 * addressed-bot marker so Harness sees the user's actual answer (`2`, etc.).
 */
export function qqMessageMentionedBot(msg) {
    if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE')
        return true;
    const parsed = qqMentionsSchema.safeParse(msg.mentions);
    return parsed.success && parsed.data.some((mention) => mention.is_you === true);
}
function normalizeInboundText(msg) {
    if (!qqMessageMentionedBot(msg))
        return msg.content;
    return msg.content.replace(/^\s*<@!?[^>]+>\s*/u, '').trimStart();
}
/** Map one SDK inbound attachment to a structured part (or undefined). */
function mapAttachment(attachment) {
    const type = attachment.content_type?.toLowerCase() ?? '';
    if (type.includes('image')) {
        return { type: 'image', url: attachment.url, alt: attachment.filename };
    }
    if (type.includes('voice') || type.includes('audio')) {
        return {
            type: 'audio',
            // QQ exposes a server-converted WAV when available; prefer it.
            url: attachment.voice_wav_url ?? attachment.url,
        };
    }
    if (type.includes('video')) {
        return { type: 'video', url: attachment.url };
    }
    if (type.includes('file')) {
        return {
            type: 'file',
            url: attachment.url,
            name: attachment.filename,
            size: attachment.size,
        };
    }
    return {
        type: 'unsupported',
        reason: `unknown qq attachment type '${attachment.content_type}'`,
    };
}
//# sourceMappingURL=mapper.js.map