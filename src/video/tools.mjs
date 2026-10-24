/**
 * 「多模态」› 视频理解的会话工具：describe_video / watch_video。
 * - 来源：本机视频文件的绝对路径（≤ 200 MB）、YouTube 公开链接（不下载），或哔哩哔哩链接（需 PATH 中有 yt-dlp，下载到插件数据目录 videos/<日期>/，≤ 25 MB）。
 * - 经 ../chatroom/video.mjs 的 Gemini 路由：≤ 14 MB 内联，更大的经 Files API 上传（48 小时内复用，过期 / 404 重新上传一次）。
 * - API 密钥不进参数、不进返回值、不进日志。
 * - Telegram 授权闸门：两个工具都不在 OPEN_TOOLS 中，只有授权用户（所有者）触发的回合可用（会把本机文件上传给 Google）。
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { describeVideo, askVideo, youtubeLink, bilibiliLink, rangeLabel, watchKey, parseOffset, normalizeVideoMime } from '../chatroom/video.mjs'
import { YTDLP_MISSING } from '../chatroom/ytdlp.mjs'
import { VIDEO_KEY_MISSING, videoAuthReady } from './key.mjs'
import { videoGenerateAuth } from './credential.mjs'
import { videoBucketSettings } from './bucket.mjs'
import { assessRemoteVideoSize, SA_NO_BUCKET_ERROR, sessionDownloadMaxBytes } from './download-guard.mjs'
import { SA_INLINE_MAX_BYTES } from './credential.mjs'

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
export function createVideoTools({ getSettings, getConfig, getGemini, ytdlp, videosRoot }) {
  const remote = new Map() // 文件指纹 → Gemini 远端文件记录
  const answers = new Map() // 来源 + 问题 + 范围 → 回答
  const downloads = new Map() // 哔哩哔哩链接 → 本地路径

  async function localSource(p, label = p) {
    if (!isAbsolute(p)) throw new VideoToolError(`请使用绝对路径：${p}`)
    const full = resolve(p)
    let st
    try { st = await stat(full) } catch { throw new VideoToolError(`文件不存在：${full}`) }
    if (!st.isFile()) throw new VideoToolError(`不是文件：${full}`)
    if (!VIDEO_EXT.has(extname(full).toLowerCase())) throw new VideoToolError(`不是受支持的视频文件（mp4、mov、webm、mkv、avi、mpeg、wmv、3gp、flv）：${basename(full)}`)
    if (st.size > SESSION_MAX_BYTES) throw new VideoToolError(`视频超过 ${SESSION_MAX_BYTES / 1024 / 1024} MB 上限：${basename(full)}`)
    if (!st.size) throw new VideoToolError(`文件为空：${full}`)
    const id = `${full}\u0000${st.size}\u0000${st.mtimeMs}`
    return {
      id, label,
      meta: { name: basename(full), mediaType: normalizeVideoMime('', full), gemini: remote.get(id) },
      load: () => readFile(full),
      saveRemote: async (g) => { if (g) remote.set(id, g); else remote.delete(id) },
    }
  }

  async function bilibiliSource(link) {
    const cached = downloads.get(link.url)
    if (cached) { try { return await localSource(cached, link.url) } catch { downloads.delete(link.url) } }
    let version = ''
    try { version = await ytdlp?.detect?.() } catch { version = '' }
    if (!version) throw new VideoToolError(YTDLP_MISSING)
    const cfg = getConfig?.() || {}
    const bucket = videoBucketSettings(cfg)
    const cred = getSettings().credentialSource || 'apiKey'
    const saNoBucket = cred === 'serviceAccount' && !bucket.enabled
    if (saNoBucket && typeof ytdlp?.probe === 'function') {
      const meta = await ytdlp.probe(link.url, { signal: AbortSignal.timeout(120000) })
      if (!meta.ok) throw new VideoToolError(meta.error)
      const gate = assessRemoteVideoSize(meta.info)
      if (!gate.ok) throw new VideoToolError(gate.reason)
    }
    const maxBytes = sessionDownloadMaxBytes({ credentialSource: cred, hasBucket: bucket.enabled, apiKeyMax: BILIBILI_MAX_BYTES })
    const maxHeight = cred === 'serviceAccount' ? bucket.maxHeight : 480
    const day = join(videosRoot(), shanghaiDate())
    await mkdir(day, { recursive: true })
    const tmp = await mkdtemp(join(day, '.dl-'))
    try {
      const maxFilesizeM = bucket.enabled ? false : (cred === 'serviceAccount' ? Math.max(1, Math.floor(SA_INLINE_MAX_BYTES / 1024 / 1024)) : Math.max(1, Math.floor(maxBytes / 1024 / 1024)))
      const d = await ytdlp.download(link.url, tmp, {
        maxBytes,
        maxHeight,
        maxFilesizeM,
        signal: AbortSignal.timeout(330000),
      })
      if (!d.ok) throw new VideoToolError(d.error)
      if (saNoBucket && d.bytes > SA_INLINE_MAX_BYTES) {
        try { await rm(d.path, { force: true }) } catch {}
        throw new VideoToolError(SA_NO_BUCKET_ERROR)
      }
      const dest = join(day, basename(d.path))
      await rename(d.path, dest)
      downloads.set(link.url, dest)
      return await localSource(dest, link.url)
    } finally {
      try { await rm(tmp, { recursive: true, force: true }) } catch {}
    }
  }

  async function sourceOf(raw) {
    const s = getSettings()
    const text = String(raw ?? '').trim().replace(/^["']|["']$/g, '')
    if (!text) throw new VideoToolError('source 需要本机视频文件的绝对路径，或 YouTube / 哔哩哔哩链接。')
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
      throw new VideoToolError('只支持本机视频文件、YouTube 公开链接与哔哩哔哩视频链接。')
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

  const SOURCE_PARAM = { type: 'string', required: true, description: 'Absolute local video file path (mp4/mov/webm/mkv/avi/mpeg/wmv/3gp, up to 200 MB), a public YouTube URL, or a Bilibili video URL (needs yt-dlp on PATH).' }

  const describe = defineTool({
    name: 'describe_video',
    description: "Have Google Gemini watch a video and return a timestamped Chinese summary (scenes, on-screen text, speech with times, notable sounds). The source is a local video file, a public YouTube URL (not downloaded), or a Bilibili URL (downloaded with yt-dlp into the plugin data folder videos/<date>/). Local files are sent to Google. The result is Gemini's account of the video, not something you watched yourself.",
    parameters: { source: SOURCE_PARAM },
    output: { schema: OUTPUT_SCHEMA, render: (_args, v) => [{ type: 'text', text: `Gemini watched ${v.source} and describes it (Gemini's view, not something you watched yourself):\n${v.text}` }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const src = await sourceOf(args.source)
      const g = await gemini()
      const r = await describeVideo({ ...g, meta: src.meta, load: src.load, saveRemote: src.saveRemote, signal: AbortSignal.timeout(600000) })
      if (!r.ok) throw new VideoToolError(`视频理解失败：${r.error}`)
      return { source: src.label, model: g.model, text: r.text }
    },
  })

  const watch = defineTool({
    name: 'watch_video',
    description: "Ask Google Gemini a specific question about a video, optionally only for a time range, and get a timestamped answer. The source is a local video file, a public YouTube URL, or a Bilibili URL (needs yt-dlp). Asking the same question about the same range again returns the earlier answer. The answer is Gemini's view, not something you watched yourself.",
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
      const src = await sourceOf(args.source)
      const range = rangeLabel(args)
      const key = watchKey({ target: src.id, question, start: args.start, end: args.end })
      const g = await gemini()
      const hit = answers.get(key)
      if (hit) return { source: src.label, model: g.model, text: hit, ...(range ? { range } : {}), cached: true }
      const r = await askVideo({ ...g, meta: src.meta, load: src.load, saveRemote: src.saveRemote, question, start: args.start, end: args.end, signal: AbortSignal.timeout(600000) })
      if (!r.ok) throw new VideoToolError(`视频理解失败：${r.error}`)
      answers.set(key, r.text)
      if (answers.size > 200) answers.delete(answers.keys().next().value)
      return { source: src.label, model: g.model, text: r.text, ...(range ? { range } : {}) }
    },
  })

  return [describe, watch]
}