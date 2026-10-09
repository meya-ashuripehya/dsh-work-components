/**
 * Outbox capability resolution.
 *
 * Proactive (outbound, unsolicited) sends are a distinct capability from the
 * transport flags in `ChannelAdapter.capabilities`. An adapter declares its
 * proactive support via an optional `outboxCapabilities` getter/field (e.g.
 * DingTalk will add it in M7C once its official proactive API is wired). When
 * the adapter exposes none, capability DERIVES from the transport flags.
 *
 * Fail-closed rule (cannot pretend support): `proactiveText` is
 * true for adapters exposing the field; otherwise the conservative default
 * assumes text is available but media is only available when the adapter
 * transports image, file, audio, or video. A capability of `false` means the
 * outbox must refuse the send (fail closed), never fabricate support.
 */
/**
 * Resolve an adapter's proactive outbox capabilities. Uses an
 * explicitly declared `outboxCapabilities` when present; otherwise derives
 * `proactiveText = true` and `proactiveMedia` from the transport
 * image/file/audio/video flags. Capability `false` always means fail closed.
 */
export function resolveOutboxCapabilities(adapter) {
    if (adapter.outboxCapabilities) {
        return {
            proactiveText: adapter.outboxCapabilities.proactiveText,
            proactiveMedia: adapter.outboxCapabilities.proactiveMedia,
        };
    }
    const caps = adapter.capabilities;
    return {
        proactiveText: true,
        proactiveMedia: Boolean(caps?.image || caps?.file || caps?.audio || caps?.video),
    };
}
//# sourceMappingURL=capabilities.js.map