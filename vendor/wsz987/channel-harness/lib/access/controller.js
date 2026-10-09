export class InboundAccessController {
    authorize(input) {
        if (input.conversationType === 'dm') {
            return this.authorizeDm(input);
        }
        return this.authorizeGroup(input);
    }
    authorizeDm(input) {
        const { policy, senderId } = input;
        if (policy.dmPolicy === 'disabled') {
            return { authorized: false, activated: false, reason: 'dm_disabled' };
        }
        if (policy.dmPolicy === 'open') {
            return { authorized: true, activated: true, reason: 'allowed' };
        }
        // policy.dmPolicy === 'allowlist' (incl. allowFrom = []).
        if (policy.allowFrom.includes(senderId)) {
            return { authorized: true, activated: true, reason: 'allowed' };
        }
        return { authorized: false, activated: false, reason: 'user_not_allowed' };
    }
    authorizeGroup(input) {
        const { policy, senderId, conversationId, mentionedBot } = input;
        if (policy.groupPolicy === 'disabled') {
            return { authorized: false, activated: false, reason: 'group_disabled' };
        }
        const rule = policy.groupPolicy === 'open'
            ? policy.defaultGroupRule
            : policy.groups[conversationId];
        if (!rule) {
            return { authorized: false, activated: false, reason: 'group_not_allowed' };
        }
        if (rule.enabled !== true) {
            return { authorized: false, activated: false, reason: 'group_disabled' };
        }
        // Sender gate.
        if (rule.senderPolicy === 'allowlist') {
            if (!rule.allowFrom.includes(senderId)) {
                return { authorized: false, activated: false, reason: 'group_user_not_allowed' };
            }
        }
        // senderPolicy === 'open' -> any sender in this NAMED group is authorized.
        // Activation gate (§14): requireMention without a reliable mention is NOT
        // activated (undefined !== true, never fail-open).
        if (rule.requireMention && mentionedBot !== true) {
            return { authorized: true, activated: false, reason: 'mention_required' };
        }
        return { authorized: true, activated: true, reason: 'allowed' };
    }
}
//# sourceMappingURL=controller.js.map