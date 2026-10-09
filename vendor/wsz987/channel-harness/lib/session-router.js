/**
 * Session binding: the durable map from a channel conversation to one Harness
 * session (doc H0.3).
 *
 * The canonical key is `channel:account:conversation[:thread]` — one account
 * never collapses into one session. The bridge reuses `@wsz987/channel-core`'s
 * `conversationKey` so both sides agree on the exact string; branded
 * channel-core identity types only appear on the channel side, so this package
 * works with plain strings.
 *
 * v3 (plan \u00a755): the binding carries the FULL stable conversation identity the
 * durable outbox needs — `conversationType: 'dm' | 'group'` (required) and the
 * optional `senderId` of the peer behind a DM. It also keeps `sessionId` (the
 * unique Agent/Session runtime identity — Harness Agent identity IS
 * `SessionId`) plus a `route` snapshot used to keep create/resume parity, an
 * optional stable `durability` policy, and `schemaVersion: 3`.
 *
 * v3 persists ONLY stable identity (plan \u00a756): channel / account /
 * conversation / type / thread / sender / session / durability / route. Transient platform
 * state is NEVER stored here — `sessionWebhook`, `replyToMessageId`,
 * `runId`, `contextToken`, a media URL and an AES key all travel only with the
 * triggering turn (see `reply-context-store`), never in a binding.
 *
 * The old v1 `agentId` field has been removed (migrated to `route.model` by
 * `binding-store`, then v2 -> v3 adds the legacy-default `conversationType`).
 */
import { conversationKey } from '@wsz987/channel-core';
export const SESSION_BINDING_SCHEMA_VERSION = 3;
/** Canonical binding key: `channel:account:conversation[:thread]`. */
export function sessionKey(conversation) {
    const key = {
        channelId: conversation.channelId,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
    };
    if (conversation.threadId) {
        key.threadId = conversation.threadId;
    }
    return conversationKey(key);
}
/** Key under which a binding is stored (derived from its own fields). */
export function bindingKey(binding) {
    return sessionKey(binding);
}
//# sourceMappingURL=session-router.js.map