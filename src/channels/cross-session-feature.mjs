/**
 * Cross-session memory feature: mount list/search tools when enabled (default on).
 * Also wires person-memory provider for inbound [person-memory] summary inject.
 */
import { createCrossSessionTools } from './cross-session-tools.mjs'
import { DEFAULT_CONFIG, TOOL_NAMES } from './cross-session-memory.mjs'
import { parseAliasMap } from './person-profile.mjs'
import { setPersonMemoryProvider } from './person-memory-inject.mjs'

export function createCrossSessionFeature(ctx, getConfig, options = {}) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  function refreshProvider() {
    setPersonMemoryProvider(() => {
      if (disposed) return { enabled: false }
      const cfg = getConfig() || {}
      const nested = cfg.crossSessionMemory && typeof cfg.crossSessionMemory === 'object'
        ? cfg.crossSessionMemory
        : {}
      const enabled = cfg.crossSessionMemoryEnabled !== false && nested.enabled !== false
      return {
        enabled,
        config: cfg,
        aliases: parseAliasMap(cfg.crossSessionAliases ?? nested.aliasesText ?? ''),
        learnedFile: options.learnedFile,
      }
    })
  }

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: cross-session memory stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    refreshProvider()
    const cfg = getConfig() || {}
    const nested = cfg.crossSessionMemory && typeof cfg.crossSessionMemory === 'object' ? cfg.crossSessionMemory : null
    const enabled = cfg.crossSessionMemoryEnabled !== false && (nested ? nested.enabled !== false : true)
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
        name: 'dsh-workbench-cross-session-memory',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            for (const tool of createCrossSessionTools({
              getConfig,
              bindingsFile: options.bindingsFile,
              findSessionLogPath: options.findSessionLogPath,
              readSessionLog: options.readSessionLog,
            })) {
              toolCtx.tools.register(tool)
            }
          })
        },
      })
      if (gen !== state.gen) {
        await stop()
        return
      }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用（' + TOOL_NAMES.join(', ') + '；入站称呼摘要）'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '跨会话记忆工具挂载失败'
      log.warn?.('dsh-workbench: cross-session memory start failed', error?.name || 'error')
    }
  }

  return {
    sync,
    async dispose() {
      disposed = true
      state.gen++
      snapshot = ''
      setPersonMemoryProvider(null)
      await stop()
    },
    state() {
      return { status: state.status, detail: state.detail, mounted: state.fork != null, defaults: DEFAULT_CONFIG }
    },
  }
}
