/**
 * 「多模态」› GPT Image 2 生图：默认关闭。打开「启用」且已保存 API Key 后，在子插件里注册
 * image_generate / image_edit；关闭或清掉 Key 时卸下。Key 只保存在插件设置（role secret）里，不读环境变量。
 * 图片保存在插件数据目录 images/<YYYY-MM-DD>/。
 * 授权闸门：两个工具都不在 Telegram OPEN_TOOLS 中，群聊 / 私聊里只有授权用户（所有者）触发的回合可用。
 */
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_SEC, GptImageError, normalizeBaseUrl, testConnection } from './client.mjs'
import { createGptImageTools } from './tools.mjs'

export const GPT_IMAGE_KEYS = ['gptImageEnabled', 'gptImageApiKey', 'gptImageBaseUrl', 'gptImageModel', 'gptImageSize', 'gptImageQuality', 'gptImageTimeoutSec']

export function gptImageSettings(cfg) {
  const c = cfg || {}
  const t = Number(c.gptImageTimeoutSec)
  return {
    enabled: c.gptImageEnabled === true,
    apiKey: String(c.gptImageApiKey ?? '').trim(),
    baseUrl: String(c.gptImageBaseUrl ?? '').trim() || DEFAULT_BASE_URL,
    model: String(c.gptImageModel ?? '').trim() || DEFAULT_MODEL,
    size: String(c.gptImageSize ?? '').trim() || 'auto',
    quality: String(c.gptImageQuality ?? '').trim() || 'auto',
    timeoutSec: Number.isFinite(t) && t >= 30 && t <= 900 ? t : DEFAULT_TIMEOUT_SEC,
  }
}

export function gptImagesRoot(root) {
  return join(root || dataDir(), 'images')
}

export function createGptImageFeature(ctx, getConfig, { fetchImpl, imagesRoot } = {}) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: gpt-image stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const s = gptImageSettings(getConfig())
    // 快照只需区分「是否挂载」；Key 等参数每次调用时现读，无需重挂。
    const snap = s.enabled && s.apiKey ? 'on' : (s.enabled ? 'nokey' : 'off')
    if (snap === snapshot) return
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!s.enabled) { snapshot = snap; state.status = 'off'; state.detail = '未启用'; return }
    if (!s.apiKey) { snapshot = snap; state.status = 'disconnected'; state.detail = '未配置 API Key'; return }
    if (typeof ctx.plugin !== 'function') {
      snapshot = ''
      state.status = 'error'
      state.detail = '宿主不支持挂载子插件（ctx.plugin）'
      return
    }
    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-gpt-image',
        apply(sub) {
          sub.inject(['tools', 'attachments'], (toolCtx) => {
            const tools = createGptImageTools({
              getSettings: () => gptImageSettings(getConfig()),
              getAttachments: () => toolCtx.get('attachments'),
              imagesRoot: () => imagesRoot?.() || gptImagesRoot(),
              fetchImpl,
            })
            for (const tool of tools) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) { await stop(); return }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '生图工具挂载失败'
      log.warn?.('dsh-workbench: gpt-image start failed', error?.name || 'error')
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

/**
 * 设置页 API：
 *   GET  /gpt-image/status → { ok, status, detail, mounted, configured }
 *   POST /gpt-image/test   → GET {base}/models 测试连接（不出图）。返回值不含 Key。
 */
export async function handleGptImageApi(req, res, sub, { sendJson, getConfig, feature, fetchImpl }) {
  if (sub === '/gpt-image/status' && req.method === 'GET') {
    const s = gptImageSettings(getConfig())
    return sendJson(res, 200, { ok: true, ...(feature?.state?.() || {}), configured: Boolean(s.apiKey) })
  }
  if (sub === '/gpt-image/test' && req.method === 'POST') {
    if (req.headers?.['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    const s = gptImageSettings(getConfig())
    if (!s.apiKey) return sendJson(res, 200, { ok: false, status: 'disconnected', error: '未连接：尚未配置 API Key。请填写 API Key 并保存后再测试。' })
    try {
      normalizeBaseUrl(s.baseUrl)
      const r = await testConnection({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, fetchImpl })
      return sendJson(res, 200, { ok: true, ...r, model: s.model })
    } catch (error) {
      const msg = error instanceof GptImageError ? error.message : '测试连接失败。'
      return sendJson(res, 200, { ok: false, status: 'error', ...(error?.status ? { httpStatus: error.status } : {}), error: msg })
    }
  }
  return false
}
