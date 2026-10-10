/**
 * 日历能力：默认开启。关闭时卸掉工具。天气城市在每次调用时读取，不写进日志。
 */
import { createCalendarTools } from './tools.mjs'

export function createCalendarFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: calendar stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = cfg.calendarEnabled !== false
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
        name: 'dsh-workbench-calendar',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            const tools = createCalendarTools({ getConfig })
            for (const tool of tools) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) {
        await stop()
        return
      }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '日历工具挂载失败'
      log.warn?.('dsh-workbench: calendar start failed', error?.name || 'error')
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
