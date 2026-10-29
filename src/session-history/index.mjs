/**
 * Pre-compaction history feature: register search_pre_compaction when enabled.
 * Default ON — official compaction otherwise permanently hides raw turns from the model surface.
 *
 * Companion compaction override lives in companion-compaction.mjs (wraps llm.stream for purpose=compaction).
 */
import { createPreCompactionHistoryTools } from './tools.mjs'

export { createCompanionCompactionFeature } from './companion-compaction.mjs'
export { COMPANION_COMPACTION_INSTRUCTION } from './companion-instruction.mjs'

export function createPreCompactionHistoryFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: pre-compaction history stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    // Default ON when key missing (recover official compaction blind spot).
    const enabled = cfg.preCompactionHistoryEnabled !== false
    const snap = enabled ? '1' : '0'
    if (snap === snapshot) return
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!enabled) {
      snapshot = snap
      state.status = 'off'
      state.detail = '未启用'
      return
    }
    if (typeof ctx.plugin !== 'function') {
      snapshot = ''
      state.status = 'error'
      state.detail = '宿主不支持挂载子插件（ctx.plugin）'
      return
    }
    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-pre-compaction-history',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            for (const tool of createPreCompactionHistoryTools()) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) {
        await stop()
        return
      }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用 · search_pre_compaction'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '压缩前历史工具挂载失败'
      log.warn?.('dsh-workbench: pre-compaction history start failed', error?.name || 'error')
    }
  }

  return {
    sync,
    async dispose() {
      disposed = true
      state.gen++
      snapshot = ''
      await stop()
    },
    state() {
      return { status: state.status, detail: state.detail, mounted: state.fork != null }
    },
  }
}
