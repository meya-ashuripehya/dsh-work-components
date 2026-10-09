/**
 * Derive the outbound `ChannelTarget` for a durable binding.
 * Spreads `threadId` only when present; `conversationType` is always carried
 * because the binding requires it (v3).
 */
export function targetFromBinding(binding) {
    return {
        channelId: binding.channelId,
        accountId: binding.accountId,
        conversationId: binding.conversationId,
        conversationType: binding.conversationType,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
    };
}
//# sourceMappingURL=target.js.map