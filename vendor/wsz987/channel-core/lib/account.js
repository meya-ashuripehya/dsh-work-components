/**
 * Identity types shared by every channel.
 *
 * All identities are branded strings so that a `ConversationId` cannot be
 * silently passed where a `MessageId` is expected. Adapters are responsible
 * for mapping platform-native ids into these types.
 */
/**
 * Canonical string form of a conversation key:
 * `channel:account:conversation[:thread]`.
 *
 * Never allowed to collapse a whole account into one session — each
 * conversation (and optionally thread) is a distinct key.
 */
export function conversationKey(key) {
    return key.threadId
        ? `${key.channelId}:${key.accountId}:${key.conversationId}:${key.threadId}`
        : `${key.channelId}:${key.accountId}:${key.conversationId}`;
}
//# sourceMappingURL=account.js.map