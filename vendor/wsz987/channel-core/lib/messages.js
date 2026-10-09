/**
 * Structured message content shared by inbound (`MessagePart[]`) and
 * outbound (`OutboundMessage`) directions.
 *
 * Adapters MUST NOT collapse platform messages into a bare `text` string —
 * image understanding, ASR, document analysis and rich interaction all build
 * on structured content.
 */
/** Collect plain text from a part list (skipping non-text content). */
export function collectText(parts) {
    return parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
}
/** Build a text-only part list. */
export function textParts(text) {
    return [{ type: 'text', text }];
}
//# sourceMappingURL=messages.js.map