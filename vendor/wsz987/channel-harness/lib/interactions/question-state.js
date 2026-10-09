/**
 * Pending-question state machine for channel question interactions.
 *
 * Owns exactly the runtime bookkeeping of an in-flight question batch:
 * the pending registry (by backend correlation key and by channel
 * conversation — one pending question per conversation at a time), the
 * action-button binding table, and the cancel timer. Rendering, channel
 * binding and answer collection live in `question-presenter.ts`; the
 * Harness-side transport lives in the backend modules.
 *
 * Question/answer shapes are the official `dsh-user-questions` types
 * (`AskUserQuestionItem` / `AskUserQuestionAnswerItem`) — every official
 * field (`detail` / `header` / `options` / `multiSelect` / `intent`) is
 * carried verbatim; nothing is stripped or re-encoded here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
/**
 * Mint a short correlation token for a text-presented question (e.g.
 * `Q-A13F7C`). It is a route/typing correlate for group/thread replies only,
 * NEVER an auth credential — Authorization stays with the Access Gate +
 * `allowedSenderId`. Kept short (not a UUID) so it is comfortable to type in
 * group chat.
 */
export function newReplyToken(prefix = 'Q-') {
    const hex = randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}${hex}`;
}
/**
 * Registry + timers for in-flight channel questions. All lookups are
 * synchronous; the class never touches adapters or backends.
 */
export class QuestionStateStore {
    byKey = new Map();
    byConversation = new Map();
    actions = new Map();
    /**
     * Register a freshly built pending question. Returns false (and registers
     * nothing) when either its key was already presented (mux replay of a
     * still-pending question — rpcId is reused verbatim on stream reopen) or
     * its conversation already has a pending question.
     */
    register(pending) {
        if (this.byKey.has(pending.key))
            return false;
        if (this.byConversation.has(pending.conversationKey))
            return false;
        this.byKey.set(pending.key, pending);
        this.byConversation.set(pending.conversationKey, pending);
        return true;
    }
    getByKey(key) {
        return this.byKey.get(key);
    }
    getByConversation(conversationKey) {
        return this.byConversation.get(conversationKey);
    }
    /** Snapshot of every in-flight question (stop()/cancel-all iteration). */
    all() {
        return [...this.byKey.values()];
    }
    /**
     * Mint a bounded, opaque channel-facing action id and bind it. Ids stay
     * within platform callback-payload budgets (e.g. Telegram callback_data).
     */
    bindAction(pending, action) {
        const id = `uq_${randomUUID().replaceAll('-', '')}`;
        pending.actionIds.add(id);
        this.actions.set(id, { pending, action });
        return id;
    }
    findAction(actionId) {
        return this.actions.get(actionId);
    }
    /** Drop every bound action of a pending question (re-render / settle). */
    clearActions(pending) {
        for (const id of pending.actionIds)
            this.actions.delete(id);
        pending.actionIds.clear();
    }
    /** Arm the one-shot cancel timer for a pending question. */
    armTimeout(pending, timeoutMs, onTimeout) {
        this.clearTimer(pending);
        pending.timer = setTimeout(() => onTimeout(pending), timeoutMs);
    }
    clearTimer(pending) {
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.timer = undefined;
    }
    /** Fully unregister a settled question (timer + both indexes). */
    remove(pending) {
        this.clearTimer(pending);
        this.byKey.delete(pending.key);
        if (this.byConversation.get(pending.conversationKey) === pending) {
            this.byConversation.delete(pending.conversationKey);
        }
    }
}
//# sourceMappingURL=question-state.js.map