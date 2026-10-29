import { z } from 'zod';
/**
 * Zod schema for the interaction payload slice the adapter consumes. Unknown
 * fields are stripped by default (never read by this mapper), so no
 * `passthrough`/`loose` is needed; the fields that matter for identity and
 * round-trip are strictly typed.
 */
const qqInteractionSchema = z.object({
    id: z.string().min(1),
    chat_type: z.number().optional(),
    user_openid: z.string().min(1).optional(),
    group_openid: z.string().min(1).optional(),
    group_member_openid: z.string().min(1).optional(),
    data: z
        .object({
        resolved: z
            .object({
            button_id: z.string().min(1).optional(),
            button_data: z.string().min(1).optional(),
        })
            .optional(),
    })
        .optional(),
});
/**
 * Map a QQ `InteractionEvent` (untrusted) to a canonical `InteractionReceived`,
 * or a fail-closed drop reason.
 *
 * Conversation derivation mirrors the message mapper conventions:
 * - C2C   → `user_openid` present (and no group ids) → conversation.id =
 *   `user_openid`, type `dm`, sender = `user_openid`;
 * - Group → `group_openid` + `group_member_openid` present →
 *   conversation.id = `group_openid`, type `group`, sender =
 *   `group_member_openid`.
 *
 * Anything else (no openids, or a mix that cannot be pinned to one
 * conversation) fails closed — never guess a conversation (security doc:
 * unidentified sender / invalid conversation → DENY).
 *
 * The action id is recovered from `data.resolved.button_data` (the verbatim
 * echo of the outbound button's `action.data`) with `button_id` as fallback;
 * a press that carries neither cannot be correlated and is dropped.
 */
export function mapInteraction(raw, meta) {
    const parsed = qqInteractionSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, reason: 'invalid-payload' };
    }
    const interaction = parsed.data;
    const userOpenid = interaction.user_openid;
    const groupOpenid = interaction.group_openid;
    const groupMemberOpenid = interaction.group_member_openid;
    let conversationId;
    let conversationType;
    let senderId;
    if (userOpenid !== undefined && groupOpenid === undefined && groupMemberOpenid === undefined) {
        conversationId = userOpenid;
        conversationType = 'dm';
        senderId = userOpenid;
    }
    else if (groupOpenid !== undefined && groupMemberOpenid !== undefined) {
        conversationId = groupOpenid;
        conversationType = 'group';
        senderId = groupMemberOpenid;
    }
    else {
        return { ok: false, reason: 'ambiguous-conversation' };
    }
    const resolved = interaction.data?.resolved;
    const action = resolved?.button_data ?? resolved?.button_id;
    if (action === undefined) {
        return { ok: false, reason: 'missing-action' };
    }
    return {
        ok: true,
        event: {
            type: 'interaction.received',
            channel: meta.channel,
            accountId: meta.accountId,
            conversation: { id: conversationId, type: conversationType },
            sender: { id: senderId },
            interactionId: interaction.id,
            // The recovered `uq_*` action id rides verbatim; the adapter never
            // parses it into Harness question semantics (red line 5).
            action,
            // Debug-only raw payload (core/bridge never depend on its shape).
            raw,
        },
    };
}
//# sourceMappingURL=interaction-mapper.js.map