/**
 * 牌类：默认关闭。启用时挂上 card_* 工具，关闭时卸下并收起当前牌桌；已下载的规则源和各会话存档仍留在数据目录。
 */
import { closeSession } from './session.mjs'
import { installCardsTelegram } from './telegram.mjs'
import { createCardsTools } from './tools.mjs'

export function createCardsFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''
  let offTelegram = null

  async function stop() {
    const fork = state.fork
    state.fork = null
    closeSession()
    if (offTelegram) { try { offTelegram() } catch { /* ignore */ } offTelegram = null }
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: cards stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = cfg.cardsEnabled === true
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
        name: 'dsh-workbench-cards',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            for (const tool of createCardsTools({ getConfig })) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) {
        await stop()
        return
      }
      offTelegram = installCardsTelegram({ logger: log })
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '牌类工具挂载失败'
      log.warn?.('dsh-workbench: cards start failed', error?.name || 'error')
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
