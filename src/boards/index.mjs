/**
 * 棋类：默认关闭。启用时挂上 board_* 工具，关闭时卸下并结束当前棋局；已下载的仓库仍留在数据目录。
 */
import { closeSession } from './session.mjs'
import { createBoardsTools } from './tools.mjs'

export function createBoardsFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  async function stop() {
    const fork = state.fork
    state.fork = null
    closeSession()
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: boards stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = cfg.boardsEnabled === true
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
        name: 'dsh-workbench-boards',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            for (const tool of createBoardsTools({ getConfig })) toolCtx.tools.register(tool)
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
      state.detail = '棋类工具挂载失败'
      log.warn?.('dsh-workbench: boards start failed', error?.name || 'error')
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
