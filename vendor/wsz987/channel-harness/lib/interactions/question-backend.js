import { WaterfallQuestionBackend } from './question-waterfall-backend.js';
import { ChannelQuestionPresenter } from './question-presenter.js';
/**
 * Backend selection: the waterfall answerer always exists, because it needs
 * only the ROOT context — `ctx.userQuestions` dispatches the event, and this
 * backend never calls the service. The probe is therefore DIAGNOSTIC ONLY.
 *
 * Treating a missing service as fatal (the pre-waterfall behavior) made a
 * transient startup state permanent: profile rows are composed concurrently
 * and `cordis.patch.yml` layers hot-reload, so a `userQuestions` service that
 * mounts after the bridge used to leave channel question presentation
 * disabled for the whole process — every channel-bound ask silently answered
 * by the Web UI instead. A registered listener with no service is inert, so
 * the answerer is composed unconditionally and the miss is only logged.
 */
export function selectQuestionBackend(probe, deps) {
    if (!probe.getUserQuestions()) {
        deps.logger.warn('[channel-harness] the userQuestions service is not mounted yet; the channel question answerer is registered anyway and claims asks as soon as the service appears');
    }
    return new WaterfallQuestionBackend({ ctx: probe.ctx, logger: deps.logger });
}
/**
 * Assemble the whole question interaction stack: probe the service (diagnostic
 * only), build the waterfall backend, and wire the channel presenter on top.
 */
export function createQuestionInteraction(options) {
    const backend = selectQuestionBackend(options, options);
    return new ChannelQuestionPresenter({
        backend,
        agentManager: options.agentManager,
        replyContexts: options.replyContexts,
        getAdapter: options.getAdapter,
        logger: options.logger,
        timeoutMs: options.timeoutMs,
    });
}
//# sourceMappingURL=question-backend.js.map