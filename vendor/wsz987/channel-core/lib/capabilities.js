/**
 * Channel capability negotiation.
 *
 * Core and the Harness bridge must negotiate against `adapter.capabilities`
 * instead of branching on `channel === '...'`.
 *
 * ## Two-layer semantics (doc §6)
 *
 * The `text/image/file/audio/video` flags describe the *platform side* of the
 * contract only: whether an ADAPTER can receive and send that kind of media on
 * the messaging platform. They are the channel's inbound/outbound transport
 * capability, NOT a statement that the Harness model already understands the
 * media as a real attachment.
 *
 * Today the Harness projection of an inbound media item is a plain-text
 * placeholder (`[image: …]` / `[audio: …]` / `[file: …]` / `[video: …]`,
 * see `message-converter`). So when `image === true`, that means the adapter
 * can carry images, NOT that a Harness agent has received a real image
 * attachment. A real attachment projection is a later milestone (doc WX5) and
 * must not be inferred from these flags.
 *
 * Capability negotiation for a *reply* uses `streaming` (statically, or
 * target-aware via `adapter.resolveStreamingMode`).
 *
 * ## Directional media
 *
 * The legacy `image/file/audio/video` booleans cannot express directionality
 * (e.g. Weixin: audio inbound yes / outbound no) or byte precision (locator
 * vs real bytes). The optional `media` map adds that per-kind precision.
 * Legacy consumers keep reading the coarse booleans; new consumers (attachment
 * gateway, `channel-verify`) should read `capabilities.media`.
 */
export {};
//# sourceMappingURL=capabilities.js.map