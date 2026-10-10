/**
 * 地图能力：默认关闭。打开「启用」且设置页已保存高德 Key 之后，
 * 在子插件里注册七个工具；关闭或清掉 Key 时卸掉。不读环境变量。
 * 路线结果附带手机可打开的分享链接与导航深链，不写入高德账号收藏夹。
 */
import { createMapTools } from './tools.mjs'

export function createMapFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: map stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = cfg.mapEnabled === true
    const apiKey = String(cfg.gaodeApiKey ?? '').trim()
    const bypassProxy = cfg.mapBypassProxy !== false
    const snap = enabled ? (bypassProxy ? '1:' : '0:') + apiKey : '0'
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
    if (!apiKey) {
      snapshot = snap
      state.status = 'disconnected'
      state.detail = '未配置高德 Key'
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
        name: 'dsh-workbench-map',
        apply(sub) {
          sub.inject(['tools', 'attachments'], (toolCtx) => {
            const tools = createMapTools({
              apiKey,
              bypassProxy,
              getAttachments: () => toolCtx.get('attachments'),
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
      state.detail = '已启用'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '地图工具挂载失败'
      log.warn?.('dsh-workbench: map start failed', error?.name || 'error')
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
