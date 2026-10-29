/**
 * 「多模态」› 表情包：默认启用。打开时注册 sticker_search / sticker_save / sticker_send；
 * 关闭时卸下工具，库内文件仍保留在数据目录 stickers/。
 * search/send 在 OPEN_TOOLS；save 仅授权用户（与 image_edit 同类）。
 */
import { createStickersTools } from './tools.mjs'
import { loadCatalog } from './store.mjs'

export const STICKERS_KEYS = ['stickersEnabled', 'stickersDefaultPackId']

export function stickersSettings(cfg) {
  const c = cfg || {}
  return {
    enabled: c.stickersEnabled !== false,
    defaultPackId: String(c.stickersDefaultPackId ?? '').trim(),
  }
}

export function createStickersFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0, stats: { packs: 0, stickers: 0 } }
  let disposed = false
  let snapshot = ''

  async function refreshStats() {
    try {
      const cat = await loadCatalog()
      state.stats = cat.stats || { packs: 0, stickers: 0 }
      if (state.status === 'on') {
        state.detail = `已启用 · ${state.stats.packs} 包 · ${state.stats.stickers} 张`
      }
    } catch {
      /* keep last */
    }
  }

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: stickers stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const s = stickersSettings(getConfig())
    const snap = s.enabled ? `on:${s.defaultPackId}` : 'off'
    if (snap === snapshot) {
      if (s.enabled) await refreshStats()
      return
    }
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!s.enabled) {
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
        name: 'dsh-workbench-stickers',
        apply(sub) {
          sub.inject(['tools', 'attachments'], (toolCtx) => {
            const tools = createStickersTools({
              getAttachments: () => toolCtx.get('attachments'),
              getDefaultPackId: () => stickersSettings(getConfig()).defaultPackId,
            })
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
      await refreshStats()
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '表情包工具挂载失败'
      log.warn?.('dsh-workbench: stickers start failed', error?.name || 'error')
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
      return {
        status: state.status,
        detail: state.detail,
        mounted: state.fork != null,
        stats: state.stats,
      }
    },
  }
}

export { handleStickersApi } from './api.mjs'
