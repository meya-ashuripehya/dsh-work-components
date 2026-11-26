/** Host and separately bundled Telegram/QQ runtimes must see the same live gates.
 * Symbol.for keeps one state object across esbuild outputs in this host process.
 * Never put transcripts or credentials here; these are only provider callbacks.
 */
const KEY = Symbol.for('dsh-workbench.cross-session-memory.runtime.v1')
if (!globalThis[KEY]) {
  Object.defineProperty(globalThis, KEY, {
    value: { provider: null, runtime: null }, configurable: false, enumerable: false,
  })
}
export const memoryRuntimeState = globalThis[KEY]
