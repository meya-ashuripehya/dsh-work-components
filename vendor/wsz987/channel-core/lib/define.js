import { defineChannelAdapterInputSchema } from './schema.js';
/**
 * Register an adapter built with the authoring helper.
 *
 * The returned value keeps the caller's concrete type (`A`), so a
 * `defineChannelAdapter`-based adapter can carry a `manifest` field and
 * still satisfy `ChannelAdapter`-typed call sites.
 */
export function defineChannelAdapter(adapter) {
    if (process.env.NODE_ENV !== 'production') {
        assertAdapterShape(adapter);
    }
    return adapter;
}
/**
 * Dev-time structural validation. Collects every problem it can find and
 * throws one `TypeError` listing all of them, so a broken adapter is fixed
 * in one pass instead of one error per run.
 *
 * The schema owns the stable problem strings relied on by tests and docs.
 */
function assertAdapterShape(value) {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError('defineChannelAdapter: expected an adapter object with id, capabilities, start, stop and send');
    }
    const parsed = defineChannelAdapterInputSchema.safeParse(value);
    if (parsed.success)
        return;
    const problems = [...new Set(parsed.error.issues.map((issue) => issue.message))];
    if (problems.length === 0) {
        problems.push(parsed.error.issues[0]?.message ?? 'adapter does not satisfy the ChannelAdapter contract');
    }
    const id = typeof value.id === 'string' ? value.id : '<unknown>';
    throw new TypeError(`defineChannelAdapter: invalid adapter '${id}' — ${problems.join('; ')}`);
}
//# sourceMappingURL=define.js.map