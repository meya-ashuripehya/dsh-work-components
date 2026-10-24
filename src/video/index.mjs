/**
 * 「多模态」› 视频理解：默认开启。经 Google Gemini 观看视频。密钥只用本组件单独配置的 videoGeminiKey（见 ./key.mjs；
 * 只放在请求头，不进日志与返回值，状态里只给来源与末四位掩码）。哔哩哔哩所需的 yt-dlp 可在设置页按需下载（./ytdlp-install.mjs）。
 *   - 聊天室：每个视频（含 YouTube / 哔哩哔哩链接）自动生成带时间戳的内容描述、watch_video、成员的「视频输入」（见 ../chatroom）。
 *   - 会话：启用后在子插件里注册 describe_video / watch_video（本机视频文件或公开链接），关闭时卸下。
 *     两个工具都不在 Telegram OPEN_TOOLS 中：会把本机文件上传给 Google，只有授权用户（所有者）触发的回合可用。
 * 旧版设置键 chatroomVideoEnabled / chatroomVideoModel（原在聊天室「附件与语音」中）仍会读取，并在启动时迁移到本组件的键。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { VIDEO_MODEL } from '../chatroom/video.mjs'
import { createYtdlp } from '../chatroom/ytdlp.mjs'
import { createVideoTools } from './tools.mjs'
import { videoKeyStatus } from './key.mjs'
import { createYtdlpInstaller, ytdlpAsset } from './ytdlp-install.mjs'
import { getAccessToken, removeServiceAccountFile, saveServiceAccountJson, readServiceAccountMeta, videoCredentialSource, videoVertexLocation } from './credential.mjs'
import { checkBucketAccess, runCleanupSweep, validateBucketPrefix, videoBucketSettings } from './bucket.mjs'

export { resolveVideoKey, videoKeyStatus, VIDEO_KEY_MISSING, VIDEO_KEY_SETTING } from './key.mjs'

export const VIDEO_KEYS = ['videoEnabled', 'videoCredentialSource', 'videoGeminiKey', 'videoServiceAccountFile', 'videoVertexLocation', 'videoBucket', 'videoBucketPrefix', 'videoMaxHeight', 'videoBaseUrl', 'videoModel', 'videoYoutube', 'videoBilibili', 'videoYtdlpPath']
export const LEGACY_VIDEO_KEYS = ['chatroomVideoEnabled', 'chatroomVideoModel']
export { VIDEO_MODEL }

const str = (v) => String(v ?? '').trim()

/** Google AI Studio 的 Gemini API 默认地址。 */
export const VIDEO_BASE_URL_DEFAULT = 'https://generativelanguage.googleapis.com'

/** videoBaseUrl：留空或无效（非 http/https）时用默认地址；去掉末尾的斜杠。 */
export function videoBaseUrl(raw) {
  const s = str(raw).replace(/\/+$/, '')
  if (!s) return VIDEO_BASE_URL_DEFAULT
  try {
    const u = new URL(s)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host || u.username || u.password || u.search || u.hash) return VIDEO_BASE_URL_DEFAULT
  } catch { return VIDEO_BASE_URL_DEFAULT }
  return s
}

/** 本组件的设置（兼容读取旧版聊天室键：旧键关闭 = 关闭；旧键里改过的模型在新键仍为默认值时沿用）。 */
export function videoSettings(cfg) {
  const c = cfg || {}
  const model = str(c.videoModel)
  const legacyModel = str(c.chatroomVideoModel)
  return {
    enabled: c.videoEnabled !== false && c.chatroomVideoEnabled !== false,
    model: model && (model !== VIDEO_MODEL || !legacyModel) ? model : (legacyModel || VIDEO_MODEL),
    youtube: c.videoYoutube !== false,
    bilibili: c.videoBilibili !== false,
    baseUrl: videoBaseUrl(c.videoBaseUrl),
    credentialSource: videoCredentialSource(c),
    vertexLocation: videoVertexLocation(c),
    serviceAccountFile: str(c.videoServiceAccountFile),
    ...(() => {
      const b = videoBucketSettings(c)
      return { videoBucket: b.bucket, videoBucketPrefix: b.prefix, videoMaxHeight: String(b.maxHeight), bucketEnabled: b.enabled }
    })(),
  }
}

/** 旧键 → 新键的一次性迁移补丁（没有需要迁移的内容时返回 null）。旧键在补丁中置为 undefined（清除）。 */
export function migrateVideoKeys(cfg) {
  const c = cfg || {}
  const patch = {}
  if (c.chatroomVideoEnabled === false) { patch.videoEnabled = false; patch.chatroomVideoEnabled = undefined }
  const legacyModel = str(c.chatroomVideoModel)
  if (legacyModel && legacyModel !== VIDEO_MODEL && (!str(c.videoModel) || str(c.videoModel) === VIDEO_MODEL)) { patch.videoModel = legacyModel; patch.chatroomVideoModel = undefined }
  return Object.keys(patch).length ? patch : null
}

const unquote = (s) => str(s).replace(/^"(.*)"$/, '$1').trim()

/**
 * yt-dlp 查找顺序：设置中的路径 → PATH 上的 yt-dlp → 设置页下载到 <数据目录>/bin/ 的副本（存在时）。
 * @param {{ downloaded?: string, exists?: (p: string) => boolean }} [o]
 */
export function ytdlpCandidates(cfg, { downloaded, exists = existsSync } = {}) {
  const out = []
  const custom = unquote(cfg?.videoYtdlpPath)
  if (custom) out.push({ bin: custom, source: 'setting' })
  out.push({ bin: 'yt-dlp', source: 'path' })
  if (downloaded && exists(downloaded)) out.push({ bin: downloaded, source: 'downloaded' })
  return out
}

export function videosRoot(root) {
  return join(root || dataDir(), 'videos')
}

/**
 * @param ctx  Cordis ctx
 * @param getConfig 当前插件设置
 * @param {{ getGemini: () => ({ resolveKey: () => Promise<{ key?: string, ref?: string, via?: string, seat?: string, problem?: string }>, fetch: () => Function } | null), ytdlp?, videosRoot?: () => string }} o
 */
export function createVideoFeature(ctx, getConfig, { getGemini, ytdlp = createYtdlp(), installer = null, videosRoot: rootOf, dataRoot: dataRootOf, fetchImpl = fetch } = {}) {
  const log = ctx?.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let disposed = false
  let snapshot = ''
  const rootDir = () => dataRootOf?.() || dataDir()
  const sweepCleanup = async () => {
    const cfg = getConfig() || {}
    if (videoCredentialSource(cfg) !== 'serviceAccount') return
    const meta = readServiceAccountMeta(cfg, rootDir())
    if (!meta.ok) return
    try {
      await runCleanupSweep({
        fetchImpl,
        getToken: async () => (await getAccessToken({ keyPath: join(rootDir(), meta.relPath.replace(/^[/\\]+/, '')), fetchImpl })).token,
        root: rootDir(),
      })
    } catch (e) { log.warn?.('dsh-workbench: video cleanup sweep failed', e?.name || 'error') }
  }
  void sweepCleanup()

  async function stop() {
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) { log.warn?.('dsh-workbench: video stop failed', error?.name || 'error') }
    }
  }

  async function sync() {
    if (disposed) return
    const s = videoSettings(getConfig())
    const snap = s.enabled ? 'on' : 'off'
    if (snap === snapshot) return
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!s.enabled) { snapshot = snap; state.status = 'off'; state.detail = '未启用'; return }
    if (typeof ctx?.plugin !== 'function') {
      // 宿主不能挂子插件时，聊天室里的视频理解仍可用，只是会话工具不可用
      snapshot = ''
      state.status = 'on'
      state.detail = '已启用（会话工具不可用：宿主不支持挂载子插件）'
      return
    }
    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-video',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            const tools = createVideoTools({
              getSettings: () => videoSettings(getConfig()),
              getConfig: () => getConfig() || {},
              getGemini,
              ytdlp,
              videosRoot: () => rootOf?.() || videosRoot(),
            })
            for (const tool of tools) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) { await stop(); return }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用'
      void sweepCleanup()
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = '视频工具挂载失败'
      log.warn?.('dsh-workbench: video start failed', error?.name || 'error')
    }
  }

  return {
    sync,
    ytdlp,
    installer,
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

/** yt-dlp 状态：当前使用的版本 / 来源、下载副本、下载任务。 */
async function ytdlpState(feature, cfg) {
  let hit = { version: '', source: '' }
  try { hit = (await feature?.ytdlp?.resolve?.()) || { version: (await feature?.ytdlp?.detect?.()) || '', source: '' } } catch {}
  const inst = feature?.installer
  let installed = null
  try { installed = inst?.installed?.() || null } catch {}
  return {
    version: hit.version || '',
    source: hit.version ? hit.source || 'path' : '',
    customPath: Boolean(unquote(cfg?.videoYtdlpPath)),
    downloadable: Boolean(inst) && ytdlpAsset() != null,
    installed: installed ? { version: installed.version, installedAt: installed.installedAt } : null,
    job: inst?.job?.() || null,
  }
}

const crossSite = (req) => req?.headers?.['sec-fetch-site'] === 'cross-site'

/**
 * 设置页 API（只供本机设置页使用，跨站请求一律拒绝）：
 *   GET  /video/status          → { ok, status, detail, mounted, settings, key: { ready, source?, tail?, problem? }, ytdlp: {…} }
 *   POST /video/ytdlp/download  → 后台下载 / 更新 yt-dlp（官方 GitHub 最新版，SHA2-256SUMS 校验），返回同上的 ytdlp 状态
 *   POST /video/credential       → 上传并校验服务账号 JSON，原子落盘并写入 videoServiceAccountFile
 *   DELETE /video/credential     → 删除服务账号文件并清空 videoServiceAccountFile
 *   POST /video/bucket/check     → 检查存储桶读写删权限（探针写入后删除）
 * 密钥只给来源与末四位掩码，不给值。
 */
export async function handleVideoApi(req, res, sub, { sendJson, readBody, getConfig, feature, applyPatch, dataRoot } = {}) {
  const root = dataRoot || dataDir()
  if (sub === '/video/status' && req.method === 'GET') {
    const cfg = getConfig() || {}
    const s = videoSettings(cfg)
    const key = videoKeyStatus(cfg, { root })
    return sendJson(res, 200, { ok: true, ...(feature?.state?.() || {}), settings: s, key, ytdlp: await ytdlpState(feature, cfg) })
  }
  if (sub === '/video/credential' && req.method === 'POST') {
    if (crossSite(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    if (typeof applyPatch !== 'function') return sendJson(res, 500, { ok: false, error: '无法保存设置' })
    let body = {}
    try { body = JSON.parse((await readBody?.(req)) || '{}') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是有效 JSON' }) }
    const saved = saveServiceAccountJson(body.json ?? body.content ?? '', root)
    if (!saved.ok) return sendJson(res, 400, { ok: false, error: saved.problem })
    await applyPatch({ videoServiceAccountFile: saved.file })
    return sendJson(res, 200, { ok: true, file: saved.file, email: saved.email, projectId: saved.projectId })
  }
  if (sub === '/video/credential' && req.method === 'DELETE') {
    if (crossSite(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    if (typeof applyPatch !== 'function') return sendJson(res, 500, { ok: false, error: '无法保存设置' })
    const cfg = getConfig() || {}
    removeServiceAccountFile(cfg, root)
    await applyPatch({ videoServiceAccountFile: '' })
    return sendJson(res, 200, { ok: true })
  }
  if (sub === '/video/bucket/check' && req.method === 'POST') {
    if (crossSite(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    const cfg = getConfig() || {}
    const bucket = str(cfg.videoBucket)
    if (!bucket) return sendJson(res, 400, { ok: false, error: '请先填写存储桶名称' })
    const vp = validateBucketPrefix(cfg.videoBucketPrefix)
    if (!vp.ok) return sendJson(res, 400, { ok: false, error: vp.problem })
    const meta = readServiceAccountMeta(cfg, root)
    if (!meta.ok) return sendJson(res, 400, { ok: false, error: meta.problem || '服务账号未配置' })
    const abs = join(root, meta.relPath.replace(/^[/\\]+/, ''))
    const fetchImpl = globalThis.fetch
    try {
      const token = (await getAccessToken({ keyPath: abs, fetchImpl })).token
      const result = await checkBucketAccess({ fetchImpl, token, bucket, prefix: vp.prefix })
      return sendJson(res, 200, { ok: result.bucket.ok && result.write.ok && result.delete.ok, steps: result, hint: result.hint || '', suggest: result.suggest || '' })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message || e).slice(0, 300) })
    }
  }
  if (sub === '/video/ytdlp/download' && req.method === 'POST') {
    if (crossSite(req)) return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    const inst = feature?.installer
    if (!inst) return sendJson(res, 400, { ok: false, error: '当前环境不支持下载 yt-dlp' })
    if (ytdlpAsset() == null) return sendJson(res, 400, { ok: false, error: `yt-dlp 没有适用于 ${process.platform}-${process.arch} 的官方程序` })
    inst.start().catch(() => {})
    return sendJson(res, 200, { ok: true, ytdlp: await ytdlpState(feature, getConfig() || {}) })
  }
  return false
}

export { createYtdlpInstaller }