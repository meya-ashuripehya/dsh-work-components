/**
 * 「多模态」› 视频理解的会话工具：describe_video / watch_video。
 * - 来源：本机视频、YouTube 直链、哔哩哔哩（yt-dlp）、TikTok / 抖音（Chrome 取媒体后流式下载）。
 *   长视频默认按 600 秒切段、重叠 5 秒，最多同时 2 路 Gemini。原始文件默认不超过 4 GiB；上传分段仍守各入口上限。
 * - 经 ../chatroom/video.mjs 的 Gemini 路由：≤ 14 MB 内联，更大的经 Files API 上传（48 小时内复用，过期 / 404 重新上传一次）。
 * - API 密钥不进参数、不进返回值、不进日志。
 * - Telegram 授权闸门：两个工具都不在 OPEN_TOOLS 中，只有授权用户（所有者）触发的回合可用（会把本机文件上传给 Google）。
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { askVideo, describeVideo, youtubeLink, bilibiliLink, findVideoLinks, videoLinkLabel, rangeLabel, watchKey, parseOffset, normalizeVideoMime } from '../chatroom/video.mjs'
import { YTDLP_MISSING } from '../chatroom/ytdlp.mjs'
import { VIDEO_KEY_MISSING, resolveVideoKey, videoAuthReady } from './key.mjs'
import { videoGenerateAuth } from './credential.mjs'
import { videoBucketSettings } from './bucket.mjs'
import { assessRemoteVideoSize, SA_NO_BUCKET_ERROR, sessionDownloadMaxBytes } from './download-guard.mjs'
import { SA_INLINE_MAX_BYTES } from './credential.mjs'
import { analyzeMedia, credentialMaterialOf, uploadLimitBytes } from './segment.mjs'

export const SESSION_MAX_BYTES = 200 * 1024 * 1024
export const BILIBILI_MAX_BYTES = 25 * 1024 * 1024
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.avi', '.flv', '.mpg', '.mpeg', '.wmv', '.3gp'])

export class VideoToolError extends Error {
  constructor(message) { super(message); this.name = 'VideoToolError' }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    model: { type: 'string', required: true },
    text: { type: 'string', required: true },
    range: { type: 'string' },
    cached: { type: 'boolean' },
  },
}

const shanghaiDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * @param {{ getSettings: () => ReturnType<import('./index.mjs').videoSettings>, getGemini: () => any, ytdlp, videosRoot: () => string }} o
 */
export function createVideoTools({ getSettings, getConfig, getGemini, ytdlp, browserVideo, videosRoot }) {
  const remote = new Map() // 文件指纹 → Gemini 远端文件记录
  const answers = new Map() // 来源 + 问题 + 范围 → 回答
  const downloads = new Map() // 哔哩哔哩链接 → 本地路径

  function limits(entry) {
    const settings = getSettings()
    const cfg = getConfig?.() || {}
    const bucket = videoBucketSettings(cfg)
    const uploadMax = uploadLimitBytes({ entry, credentialSource: settings.credentialSource, hasBucket: bucket.enabled })
    const segmented = settings.autoSegment !== false
    const fallback = entry === 'bilibili' ? BILIBILI_MAX_BYTES : SESSION_MAX_BYTES
    const downloadMax = segmented
      ? settings.downloadMaxBytes
      : sessionDownloadMaxBytes({ credentialSource: settings.credentialSource, hasBucket: bucket.enabled, apiKeyMax: fallback })
    return { settings, cfg, bucket, uploadMax, downloadMax, segmented, cred: settings.credentialSource || 'apiKey' }
  }

  async function localSource(p, label = p, entry = 'session') {
    if (!isAbsolute(p)) throw new VideoToolError(`请使用绝对路径：${p}`)
    const full = resolve(p)
    let st
    try { st = await stat(full) } catch { throw new VideoToolError(`文件不存在：${full}`) }
    if (!st.isFile()) throw new VideoToolError(`不是文件：${full}`)
    if (!VIDEO_EXT.has(extname(full).toLowerCase())) throw new VideoToolError(`不是受支持的视频文件（mp4、mov、webm、mkv、avi、mpeg、wmv、3gp、flv）：${basename(full)}`)
    const { uploadMax, downloadMax, segmented } = limits(entry)
    const ceiling = segmented ? downloadMax : uploadMax
    if (st.size > ceiling) {
      const mb = Math.max(1, Math.round(ceiling / 1024 / 1024))
      throw new VideoToolError(segmented ? `视频超过 ${mb} MB 的原始文件上限：${basename(full)}` : `视频超过 ${mb} MB 上限：${basename(full)}`)
    }
    if (!st.size) throw new VideoToolError(`文件为空：${full}`)
    const id = `${full}\u0000${st.size}\u0000${st.mtimeMs}`
    return {
      id, label, path: full, bytes: st.size, uploadMaxBytes: uploadMax, entry,
      meta: { name: basename(full), mediaType: normalizeVideoMime('', full), gemini: remote.get(id) },
      load: () => readFile(full),
      saveRemote: async (g) => { if (g) remote.set(id, g); else remote.delete(id) },
    }
  }

  async function bilibiliSource(link) {
    const cached = downloads.get(link.url)
    if (cached) { try { return await localSource(cached, link.url, 'bilibili') } catch { downloads.delete(link.url) } }
    let version = ''
    try { version = await ytdlp?.detect?.() } catch { version = '' }
    if (!version) throw new VideoToolError(YTDLP_MISSING)
    const { bucket, cred, segmented, downloadMax } = limits('bilibili')
    const saNoBucket = cred === 'serviceAccount' && !bucket.enabled
    if (!segmented && saNoBucket && typeof ytdlp?.probe === 'function') {
      const meta = await ytdlp.probe(link.url, { signal: AbortSignal.timeout(120000) })
      if (!meta.ok) throw new VideoToolError(meta.error)
      const gate = assessRemoteVideoSize(meta.info)
      if (!gate.ok) throw new VideoToolError(gate.reason)
    }
    const maxBytes = downloadMax
    const maxHeight = cred === 'serviceAccount' ? bucket.maxHeight : 480
    const day = join(videosRoot(), shanghaiDate())
    await mkdir(day, { recursive: true })
    const tmp = await mkdtemp(join(day, '.dl-'))
    try {
      const maxFilesizeM = bucket.enabled ? false : (segmented ? Math.max(1, Math.floor(maxBytes / 1024 / 1024)) : (cred === 'serviceAccount' ? Math.max(1, Math.floor(SA_INLINE_MAX_BYTES / 1024 / 1024)) : Math.max(1, Math.floor(maxBytes / 1024 / 1024))))
      const d = await ytdlp.download(link.url, tmp, {
        maxBytes,
        maxHeight,
        maxFilesizeM,
        signal: AbortSignal.timeout(330000),
      })
      if (!d.ok) throw new VideoToolError(d.error)
      if (!segmented && saNoBucket && d.bytes > SA_INLINE_MAX_BYTES) {
        try { await rm(d.path, { force: true }) } catch {}
        throw new VideoToolError(SA_NO_BUCKET_ERROR)
      }
      const dest = join(day, basename(d.path))
      await rename(d.path, dest)
      downloads.set(link.url, dest)
      return await localSource(dest, link.url, 'bilibili')
    } finally {
      try { await rm(tmp, { recursive: true, force: true }) } catch {}
    }
  }

  const browserJobs = new Map()
  async function browserSource(link) {
    if (!browserVideo) throw new VideoToolError('请启用并连接「工作组件 › Chrome」。')
    const cached = downloads.get(link.url)
    if (cached) { try { return await localSource(cached, link.url, 'session') } catch { downloads.delete(link.url) } }
    if (browserJobs.has(link.url)) return browserJobs.get(link.url)
    const job = (async () => {
      const { downloadMax } = limits('session')
      const day = join(videosRoot(), shanghaiDate())
      await mkdir(day, { recursive: true })
      const tmp = await mkdtemp(join(day, '.browser-'))
      try {
        const d = await browserVideo.download(link.url, tmp, { maxBytes: downloadMax, signal: AbortSignal.timeout(600000) })
        if (!d.ok) throw new VideoToolError(d.error)
        const dest = join(day, basename(d.path))
        await rename(d.path, dest)
        downloads.set(link.url, dest)
        return await localSource(dest, link.url, 'session')
      } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
    })()
    browserJobs.set(link.url, job)
    try { return await job } finally { browserJobs.delete(link.url) }
  }

  async function sourceOf(raw) {
    const s = getSettings()
    const text = String(raw ?? '').trim().replace(/^["']|["']$/g, '')
    if (!text) throw new VideoToolError('source 需要本机视频文件的绝对路径，或 YouTube / 哔哩哔哩 / TikTok / 抖音链接。')
    const sv = findVideoLinks(text).find((x) => x.kind === 'tiktok' || x.kind === 'douyin')
    if (sv) {
      if (s[sv.kind] === false) throw new VideoToolError(`「多模态 › 视频理解」中已关闭${videoLinkLabel(sv.kind)}链接。`)
      return browserSource(sv)
    }
    if (/^https?:\/\//i.test(text)) {
      const yt = youtubeLink(text)
      if (yt) {
        if (!s.youtube) throw new VideoToolError('「多模态 › 视频理解」中已关闭 YouTube 链接。')
        return { id: yt.url, label: yt.url, meta: { link: yt.url, linkKind: 'youtube', name: `YouTube ${yt.id}` }, load: async () => null, saveRemote: async () => {} }
      }
      const bl = bilibiliLink(text)
      if (bl) {
        if (!s.bilibili) throw new VideoToolError('「多模态 › 视频理解」中已关闭哔哩哔哩链接。')
        return bilibiliSource(bl)
      }
      throw new VideoToolError('只支持本机视频文件、YouTube、哔哩哔哩、TikTok 与抖音视频链接。')
    }
    let p = text
    if (/^file:/i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1) } catch {} }
    return localSource(p)
  }

  async function gemini() {
    const s = getSettings()
    if (!s.enabled) throw new VideoToolError('「多模态 › 视频理解」未启用。')
    const g = getGemini?.()
    if (!g) throw new VideoToolError('Gemini 路由不可用。')
    const k = await g.resolveKey()
    if (!videoAuthReady(k)) throw new VideoToolError(k?.problem || VIDEO_KEY_MISSING)
    const auth = await videoGenerateAuth(getConfig?.() || {}, g.fetch())
    if (auth.error) throw new VideoToolError(auth.error)
    return auth
  }

  async function analyze(auth, src, { purpose, question, start, end, signal }) {
    if (src.meta?.linkKind === 'youtube' || !src.path) {
      const call = purpose === 'watch' ? askVideo : describeVideo
      return call({ ...auth, meta: src.meta, load: src.load, saveRemote: src.saveRemote, question, start, end, signal })
    }
    const cfg = getConfig?.() || {}
    const keyInfo = resolveVideoKey(cfg)
    return analyzeMedia({
      filePath: src.path,
      bytes: src.bytes,
      purpose,
      question,
      start,
      end,
      uploadMaxBytes: src.uploadMaxBytes,
      settings: getSettings(),
      model: auth.model,
      credentialMaterial: credentialMaterialOf(auth, { clientEmail: keyInfo.clientEmail, videoCredentialSource: keyInfo.credentialSource }),
      auth,
      cacheRoot: join(videosRoot(), 'segments'),
      signal,
      meta: src.meta,
      load: src.load,
      saveRemote: src.saveRemote,
      cfg,
    })
  }

  const SOURCE_PARAM = { type: 'string', required: true, description: 'Absolute local video path, a public YouTube URL (passed through, not downloaded), a Bilibili URL (yt-dlp), or a TikTok / Douyin URL or share text (Chrome, then direct download). Long videos are split automatically (default 10 minutes, 5 second overlap). The original file may be up to the download limit (default 4 GiB). Each uploaded piece still respects the entry limit (session 200 MB, Bilibili 25 MB, 20 MB without a storage bucket).' }

  const describe = defineTool({
    name: 'describe_video',
    description: "Have Google Gemini watch a video and return a timestamped Chinese summary (scenes, on-screen text, speech with times, notable sounds). Long videos are split (default 10 minutes, 5 second overlap, at most 2 Gemini requests at once) and the pieces are merged back onto the original timeline. YouTube URLs are not downloaded. Files are sent to Google. The result is Gemini's account of the video, not something you watched yourself.",
    parameters: { source: SOURCE_PARAM },
    output: { schema: OUTPUT_SCHEMA, render: (_args, v) => [{ type: 'text', text: `Gemini watched ${v.source} and describes it (Gemini's view, not something you watched yourself):\n${v.text}` }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const g = await gemini()
      const src = await sourceOf(args.source)
      const r = await analyze(g, src, { purpose: 'describe', signal: AbortSignal.timeout(600000) })
      if (!r.ok) throw new VideoToolError(`视频理解失败：${r.error}`)
      return { source: src.label, model: g.model, text: r.text }
    },
  })

  const watch = defineTool({
    name: 'watch_video',
    description: "Ask Google Gemini a specific question about a video, optionally only for a time range, and get a timestamped answer. A time range uploads only the covering pieces, mapped back to the original timeline. Asking the same question about the same range again returns the earlier answer. The answer is Gemini's view, not something you watched yourself.",
    parameters: {
      source: SOURCE_PARAM,
      question: { type: 'string', required: true, description: 'What you need to know about the video (any language; the answer uses the same language).' },
      start: { type: 'string', description: 'Optional start of the range, e.g. "1:05" or "65" (seconds).' },
      end: { type: 'string', description: 'Optional end of the range, e.g. "1:30" or "90" (seconds).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, v) => [{ type: 'text', text: `Gemini watched ${v.source}${v.range ? ` (${v.range})` : ''}${v.cached ? ' (same question as before)' : ''} and answers (Gemini's view, not something you watched yourself):\n${v.text}` }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const question = String(args.question ?? '').trim()
      if (!question) throw new VideoToolError('watch_video 需要 question。')
      for (const [k, v] of [['start', args.start], ['end', args.end]]) if (v !== undefined && v !== null && v !== '' && parseOffset(v) === null) throw new VideoToolError(`${k} 不是有效的时间：${String(v).slice(0, 40)}（例如 1:05 或 65）`)
      const s0 = parseOffset(args.start)
      const e0 = parseOffset(args.end)
      if (s0 !== null && e0 !== null && e0 <= s0) throw new VideoToolError('end 必须晚于 start。')
      const g = await gemini()
      const src = await sourceOf(args.source)
      const range = rangeLabel(args)
      const key = watchKey({ target: src.id, question, start: args.start, end: args.end })
      const hit = answers.get(key)
      if (hit) return { source: src.label, model: g.model, text: hit, ...(range ? { range } : {}), cached: true }
      const r = await analyze(g, src, { purpose: 'watch', question, start: args.start, end: args.end, signal: AbortSignal.timeout(600000) })
      if (!r.ok) throw new VideoToolError(`视频理解失败：${r.error}`)
      if (!r.partial) answers.set(key, r.text)
      if (answers.size > 200) answers.delete(answers.keys().next().value)
      return { source: src.label, model: g.model, text: r.text, ...(range ? { range } : {}) }
    },
  })

  return [describe, watch]
}
