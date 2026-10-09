/**
 * Mount (register + start) a channel adapter under a `ctx` fiber and return
 * an actively-callable `ChannelMountHandle`.
 *
 * `createContext(signal)` is called with the exclusive per-adapter abort
 * signal right before `adapter.start`, so the adapter's `ChannelAdapterContext`
 * is aborted both on a failed start (rollback) and on unload/dispose.
 *
 * The returned handle wraps the disposer returned by `ctx.effect`, so it both
 * supports on-demand disposal and still cleans up automatically when the
 * parent Cordis fiber unloads.
 */
export function mountChannelAdapter(ctx, adapter, createContext) {
    const dispose = ctx.effect(async () => {
        const abort = new AbortController();
        // Registration happens before start; on a start failure we must remove it.
        const unregister = ctx.channels.register(adapter);
        try {
            await adapter.start(createContext(abort.signal));
        }
        catch (error) {
            abort.abort();
            try {
                await adapter.stop();
            }
            catch {
                // Best-effort rollback of the network resources.
            }
            unregister();
            throw error;
        }
        return async () => {
            abort.abort();
            try {
                await adapter.stop();
            }
            finally {
                unregister();
            }
        };
    });
    return { dispose: () => dispose() };
}
//# sourceMappingURL=mount.js.map