/**
 * 长视频自动分段：ffprobe 读时长，ffmpeg 按时间切到磁盘，再逐段交给 Gemini。
 * 外部程序一律 execFile 参数数组 + windowsHide，不经过 shell。
 * 原始文件只做指纹（头尾各 64KB）和 ffmpeg 输入；分析时最多同时读 2 个分段进内存。
 * 缓存只写分段参数、模型名和凭据哈希，不写密钥明文。
 */
import { execFile as execFileCb } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { which } from '../tools.mjs'
import { SA_INLINE_MAX_BYTES } from './credential.mjs'
import { ATTACH_MAX_BYTES } from '../chatroom/attachments.mjs'
import { describeVideo, askVideo, DESCRIBE_VIDEO_PROMPT, parseOffset } from '../chatroom/video.mjs'

export const DEFAULT_SEGMENT_SECONDS = 600
export const DEFAULT_OVERLAP_SECONDS = 5
export const DEFAULT_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_PARALLEL = 2
export const PROBE_MIN_BYTES = 8 * 1024 * 1024
export const MIN_SEGMENT_SECONDS = 8
/** 切片算法版本。精确重编码，不用流复制；写入缓存键，避免复用旧的越界切片。 */
export const CUT_ALGO = 2
const DURATION_SLACK_SEC = 1.5
export const HEIGHTS = [0, 480, 360, 240, 144]
export const SESSION_UPLOAD_MAX = 200 * 1024 * 1024
export const BILIBILI_UPLOAD_MAX = 25 * 1024 * 1024
export const FFMPEG_MISSING = '未检测到 FFmpeg / ffprobe。长视频自动分段需要这两个程序：请安装后加入 PATH，或在「工作组件 › FFmpeg」填写 FFmpeg 路径（ffprobe 需在同一目录）。'

const SAMPLE = 64 * 1024

const round3 = (n) => Math.round(Number(n) * 1000) / 1000

export function formatStamp(sec) {
  const total = Math.max(0, Math.round((Number(sec) || 0) * 1000))
  const h = Math.floor(total / 3600000)
  const m = Math.floor((total % 3600000) / 60000)
  const s = (total % 60000) / 1000
  const secStr = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`
}

export function uploadLimitBytes({ entry = 'session', credentialSource, hasBucket } = {}) {
  const table = { session: SESSION_UPLOAD_MAX, bilibili: BILIBILI_UPLOAD_MAX, chatroom: ATTACH_MAX_BYTES }
  const cap = table[entry] || SESSION_UPLOAD_MAX
  if (credentialSource === 'serviceAccount' && !hasBucket) return Math.min(cap, SA_INLINE_MAX_BYTES)
  return cap
}

export function credentialMaterialOf(auth, extra = {}) {
  const mode = auth?.credentialSource === 'serviceAccount' || extra.videoCredentialSource === 'serviceAccount' ? 'serviceAccount' : 'apiKey'
  if (mode === 'serviceAccount') {
    return {
      mode,
      email: String(extra.clientEmail || auth?.clientEmail || ''),
      projectId: String(auth?.vertexProject || extra.projectId || ''),
      location: String(auth?.vertexLocation || extra.location || ''),
    }
  }
  return { mode, key: String(auth?.apiKey || '') }
}

export function credentialHash(material) {
  return createHash('sha256').update(JSON.stringify({
    mode: material?.mode || '',
    key: material?.mode === 'apiKey' ? String(material?.key || '') : '',
    email: material?.email || '',
    projectId: material?.projectId || '',
    location: material?.location || '',
  })).digest('hex')
}

/** 只读头尾，不把整个文件读进内存。 */
export async function fingerprintFile(filePath, io = {}) {
  const statFn = io.stat || stat
  const openFn = io.open || open
  const st = await statFn(filePath)
  const h = createHash('sha256')
  h.update(String(st.size))
  h.update('\0')
  h.update(String(Math.round(st.mtimeMs)))
  const fh = await openFn(filePath, 'r')
  try {
    const head = Buffer.alloc(SAMPLE)
    const n = (await fh.read(head, 0, SAMPLE, 0)).bytesRead
    h.update(head.subarray(0, n))
    if (st.size > SAMPLE) {
      const tail = Buffer.alloc(SAMPLE)
      const pos = Math.max(0, st.size - SAMPLE)
      const m = (await fh.read(tail, 0, SAMPLE, pos)).bytesRead
      h.update(tail.subarray(0, m))
    }
  } finally {
    await fh.close()
  }
  return { size: st.size, mtimeMs: st.mtimeMs, id: h.digest('hex') }
}

export function planSegments(durationSec, { segmentSeconds = DEFAULT_SEGMENT_SECONDS, overlapSeconds = DEFAULT_OVERLAP_SECONDS } = {}) {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return []
  const win = Math.max(MIN_SEGMENT_SECONDS, Number(segmentSeconds) || DEFAULT_SEGMENT_SECONDS)
  let overlap = Math.max(0, Number(overlapSeconds) || 0)
  if (overlap >= win) overlap = Math.max(0, win - 1)
  if (duration <= win + 0.05) return [{ index: 0, start: 0, end: round3(duration) }]
  const out = []
  let start = 0
  let guard = 0
  while (start < duration - 0.05 && guard++ < 10000) {
    const end = Math.min(duration, start + win)
    out.push({ index: out.length, start: round3(start), end: round3(end) })
    if (end >= duration - 0.05) break
    const next = end - overlap
    if (next <= start + 0.05) break
    start = next
  }
  return out
}

/** watch 的 start/end：只覆盖请求范围，不规划范围之外的片段。 */
export function clipsForRange(durationSec, { start = null, end = null, segmentSeconds = DEFAULT_SEGMENT_SECONDS, overlapSeconds = DEFAULT_OVERLAP_SECONDS } = {}) {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return { error: '无法读取视频时长，不能按范围分段。' }
  const s = start == null ? 0 : Number(start)
  let e = end == null ? duration : Number(end)
  if (!Number.isFinite(s) || s < 0) return { error: 'start 不是有效的时间。' }
  if (!Number.isFinite(e) || e < 0) return { error: 'end 不是有效的时间。' }
  if (s >= duration - 0.001) return { error: `起点 ${formatStamp(s)} 超出视频时长 ${formatStamp(duration)}。` }
  let clamped = false
  if (e > duration) { e = duration; clamped = true }
  if (e <= s) return { error: 'end 必须晚于 start。' }
  const span = e - s
  const win = Math.max(MIN_SEGMENT_SECONDS, Number(segmentSeconds) || DEFAULT_SEGMENT_SECONDS)
  let overlap = Math.max(0, Number(overlapSeconds) || 0)
  if (overlap >= win) overlap = Math.max(0, win - 1)
  if (span <= win + 0.05) return { clips: [{ index: 0, start: round3(s), end: round3(e) }], clamped, duration }
  const clips = []
  let cursor = s
  let guard = 0
  while (cursor < e - 0.05 && guard++ < 10000) {
    const clipEnd = Math.min(e, cursor + win)
    clips.push({ index: clips.length, start: round3(cursor), end: round3(clipEnd) })
    if (clipEnd >= e - 0.05) break
    const next = clipEnd - overlap
    if (next <= cursor + 0.05) break
    cursor = next
  }
  return { clips, clamped, duration }
}

const STAMP_RE = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\]/g

function stampSeconds(h, m, s) {
  return (h ? Number(h) : 0) * 3600 + Number(m) * 60 + Number(s)
}

export function shiftTimestamps(text, offsetSec) {
  const offset = Number(offsetSec) || 0
  if (!offset) return String(text || '')
  return String(text || '').replace(STAMP_RE, (_all, h, m, s) => `[${formatStamp(stampSeconds(h, m, s) + offset)}]`)
}

function firstStamp(line) {
  const m = STAMP_RE.exec(line)
  STAMP_RE.lastIndex = 0
  if (!m) return null
  return stampSeconds(m[1], m[2], m[3])
}

export function dedupePieces(pieces) {
  const sorted = [...pieces].sort((a, b) => a.start - b.start || a.end - b.end)
  const out = []
  for (const piece of sorted) {
    const prev = out[out.length - 1]
    if (!prev) { out.push({ ...piece, text: String(piece.text || '').trim() }); continue }
    const cutoff = prev.end - 0.05
    const kept = []
    let seen = false
    for (const line of String(piece.text || '').split(/\r?\n/)) {
      const ts = firstStamp(line)
      if (ts != null && ts < cutoff) continue
      if (ts == null && !seen) continue
      if (ts != null) seen = true
      kept.push(line)
    }
    out.push({ ...piece, text: kept.join('\n').trim() })
  }
  return out
}

export function mergeSegmentTexts(pieces, { duration = 0, clamped = false, failures = [] } = {}) {
  const shifted = pieces.map((p) => ({ ...p, text: shiftTimestamps(p.text || '', p.start) }))
  const deduped = dedupePieces(shifted)
  const lines = []
  if (duration > 0) lines.push(`原视频 ${formatStamp(duration)}，共 ${deduped.length} 段。`)
  if (clamped && duration > 0) lines.push(`请求的结束时间超出视频时长，已截到 ${formatStamp(duration)}。`)
  if (lines.length) lines.push('')
  deduped.forEach((p, i) => {
    lines.push(`## 片段 ${i + 1}（原视频 ${formatStamp(p.start)}–${formatStamp(p.end)}）`)
    if (p.text) lines.push(p.text)
    lines.push('')
  })
  if (failures.length) {
    lines.push('以下片段分析失败，再次分析时只会重试这些片段：')
    for (const f of failures) lines.push(`- 原视频 ${formatStamp(f.start)}–${formatStamp(f.end)}：${f.error || '失败'}`)
  }
  return lines.join('\n').trim()
}

export function createExec(impl) {
  return async function run(file, args, opts = {}) {
    if (!Array.isArray(args)) throw new Error('内部错误：外部程序参数必须是数组')
    const options = { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: opts.timeout || 600000 }
    if (opts.signal) options.signal = opts.signal
    if (impl) return impl(file, args, options)
    return await new Promise((resolve, reject) => {
      execFileCb(file, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || '').slice(0, 400)
          err.stderr = String(stderr || '').slice(0, 400)
          if (err.stderr) err.message = `${err.message}\n${err.stderr}`
          reject(err)
        } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    })
  }
}

export async function resolveVideoFfmpeg({ cfg, whichImpl = which, execImpl, existsImpl = existsSync } = {}) {
  const run = createExec(execImpl)
  let ffmpeg = ''
  const raw = String(cfg?.ffmpegPath || '').trim()
  if (raw) {
    if (existsImpl(raw)) ffmpeg = raw
    else if (process.platform === 'win32' && existsImpl(`${raw}.exe`)) ffmpeg = `${raw}.exe`
  }
  if (!ffmpeg) ffmpeg = whichImpl('ffmpeg') || ''
  if (!ffmpeg) return { ok: false, error: FFMPEG_MISSING }
  const sibling = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  let ffprobe = existsImpl(sibling) ? sibling : (whichImpl('ffprobe') || '')
  if (!ffprobe) return { ok: false, error: FFMPEG_MISSING }
  try {
    await run(ffmpeg, ['-version'], { timeout: 15000 })
    await run(ffprobe, ['-version'], { timeout: 15000 })
  } catch {
    return { ok: false, error: FFMPEG_MISSING }
  }
  return { ok: true, ffmpeg, ffprobe }
}

export async function probeMedia(filePath, { ffprobe, execFileImpl, signal } = {}) {
  const run = createExec(execFileImpl)
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,start_time', '-of', 'json', filePath], { signal, timeout: 60000 })
  let duration = 0
  let startTime = 0
  try {
    const format = JSON.parse(stdout)?.format || {}
    duration = Number(format.duration)
    startTime = Number(format.start_time)
  } catch { duration = 0 }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe 没有返回有效时长。')
  if (!Number.isFinite(startTime)) startTime = 0
  return { duration, startTime }
}

export async function probeDuration(filePath, opts = {}) {
  return (await probeMedia(filePath, opts)).duration
}

function ffprobeBeside(ffmpeg) {
  if (!ffmpeg) return ''
  const sibling = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return existsSync(sibling) ? sibling : ''
}

/**
 * 按请求的起点和时长重编码。流复制会从上一关键帧开始，把范围外的画面留在片段里，所以这里不使用 -c copy。
 * -ss 放在 -i 之前以便长视频快速定位，同时打开 accurate_seek，把定位点到起点之间的帧丢掉。
 */
export async function ffmpegCut({ ffmpeg, input, output, start, duration, height = 0, signal, execFileImpl } = {}) {
  const run = createExec(execFileImpl)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-accurate_seek', '-ss', String(round3(start)), '-i', input, '-t', String(round3(duration)), '-map', '0:v:0', '-map', '0:a:0?']
  if (height > 0) args.push('-vf', `scale=-2:${height}`)
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', '-avoid_negative_ts', 'make_zero', '-muxdelay', '0', '-muxpreload', '0', '-movflags', '+faststart', '-f', 'mp4', output)
  await run(ffmpeg, args, { signal, timeout: 600000 })
  const st = await stat(output)
  const ffprobe = ffprobeBeside(ffmpeg)
  if (ffprobe) {
    const media = await probeMedia(output, { ffprobe, execFileImpl, signal })
    if (media.duration > duration + DURATION_SLACK_SEC || media.startTime > DURATION_SLACK_SEC) {
      await rm(output, { force: true }).catch(() => {})
      throw new Error(`切片实际覆盖 ${media.duration.toFixed(3)} 秒（起点 ${media.startTime.toFixed(3)}），超出请求的 ${round3(duration)} 秒，已停止，不会上传范围外的内容。`)
    }
  }
  return { path: output, bytes: st.size }
}

function abortMessage(signal) {
  if (signal?.reason?.name === 'TimeoutError') return '视频分段或分析超时，已停止并清理临时文件。'
  return '已取消'
}

function abortError(signal) {
  return Object.assign(new Error(abortMessage(signal)), { name: 'AbortError', code: 'ABORT_ERR' })
}

export async function shouldSegmentFile({ bytes = 0, durationSec = 0, uploadMaxBytes, segmentSeconds = DEFAULT_SEGMENT_SECONDS, autoSegment = true, probe } = {}) {
  if (autoSegment === false) return { segment: false, durationSec: durationSec || 0 }
  let known = Number(durationSec) || 0
  const oversize = bytes > uploadMaxBytes
  if (!(known > segmentSeconds) && typeof probe === 'function') {
    try {
      const d = Number(await probe())
      if (d > 0) known = d
    } catch (e) {
      if (e?.code === 'FFMPEG_MISSING' || e?.missing) {
        if (oversize) return { segment: true, reason: 'size', missing: true, durationSec: known }
        return { segment: false, durationSec: known, probeSkipped: true }
      }
      if (oversize) return { segment: true, reason: 'size', durationSec: known }
      return { segment: false, durationSec: known }
    }
  }
  if (oversize) return { segment: true, reason: 'size', durationSec: known }
  if (known > segmentSeconds) return { segment: true, reason: 'duration', durationSec: known }
  return { segment: false, durationSec: known }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(limit || 1, items.length || 1))
  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, () => worker()))
  return results
}

function safePieceName(name) {
  return /^p\d{3,}\.mp4$/.test(String(name || '')) ? String(name) : ''
}

function pieceOrdinal(name) {
  const m = /^p(\d+)\.mp4(?:\.part)?$/.exec(String(name || ''))
  return m ? Number(m[1]) : -1
}

async function firstFreeOrdinal(clipDir, pieces = []) {
  let max = -1
  for (const p of pieces) max = Math.max(max, pieceOrdinal(p?.file))
  let names = []
  try { names = await readdir(clipDir) } catch { names = [] }
  for (const name of names) max = Math.max(max, pieceOrdinal(name))
  return max + 1
}

const runQueues = new Map()
function enqueueRun(key, fn) {
  const prev = runQueues.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const settled = run.then(() => {}, () => {})
  runQueues.set(key, settled)
  settled.finally(() => { if (runQueues.get(key) === settled) runQueues.delete(key) })
  return run
}

async function moveFile(src, dest) {
  if (src === dest) return
  try { await rename(src, dest) } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    await copyFile(src, dest)
    await rm(src, { force: true })
  }
}

function cachePaths(cacheRoot, filePath, fp, params) {
  const sourceKey = createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 16)
  const runKey = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 20)
  const dir = join(cacheRoot, sourceKey)
  return { dir, runKey, sourceFile: join(dir, 'source.json'), manifestFile: join(dir, `${runKey}.json`), clipDir: join(dir, runKey), fp }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, file)
}

function segmentPrompt(piece, duration, { purpose, question }) {
  const head = [
    `这是原视频的一个片段，不是完整视频。原视频总长 ${formatStamp(duration)}。`,
    `本片段覆盖原视频 ${formatStamp(piece.start)}–${formatStamp(piece.end)}。`,
    '时间戳从本片段的 0:00 起算，写成 [m:ss] 或 [h:mm:ss]，不要写成原视频的绝对时间。',
  ]
  if (purpose === 'watch') {
    const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
    head.push(`问题：${q}`, '用提问的语言回答。若本片段里没有答案，直接说明。')
    return head.join('\n')
  }
  head.push(DESCRIBE_VIDEO_PROMPT)
  return head.join('\n')
}

async function sweepParts(dir) {
  let names = []
  try { names = await readdir(dir) } catch { return }
  await Promise.all(names.filter((n) => n.endsWith('.part') || n.endsWith('.tmp')).map((n) => rm(join(dir, n), { force: true }).catch(() => {})))
}

/**
 * 把一个时间范围切成不超过 uploadMaxBytes 的文件。超限先降分辨率，再缩短时长，有次数上限。
 */
export async function cutToFit(start, end, ctx, depth = 0) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal)
  if (end - start < 0.05) return []
  if (depth > 8) throw new Error('分段次数过多，已停止，不会上传超限文件。')
  let span = end - start
  let heightIndex = 0
  for (let step = 0; step < 48; step++) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal)
    const height = HEIGHTS[Math.min(heightIndex, HEIGHTS.length - 1)]
    const pieceEnd = Math.min(end, start + span)
    const name = ctx.allocName()
    const finalPath = join(ctx.clipDir, name)
    const partPath = `${finalPath}.part`
    try {
      const file = await ctx.cutClip({
        ffmpeg: ctx.ffmpeg,
        input: ctx.filePath,
        output: partPath,
        start,
        duration: Math.max(0.1, pieceEnd - start),
        height,
        signal: ctx.signal,
      })
      if (ctx.signal?.aborted) throw abortError(ctx.signal)
      const st = await ctx.stat(file?.path || partPath).catch(() => ({ size: 0 }))
      const bytes = Math.max(Number(st.size) || 0, Number(file?.bytes) || 0)
      if (!(bytes > 0) || bytes > ctx.uploadMaxBytes) {
        await ctx.remove(partPath)
        await ctx.remove(finalPath)
        if (heightIndex < HEIGHTS.length - 1) { heightIndex += 1; continue }
        if (span <= MIN_SEGMENT_SECONDS + 0.01) {
          throw new Error(`片段 ${formatStamp(start)}–${formatStamp(pieceEnd)} 在降低分辨率后仍超过 ${Math.max(1, Math.round(ctx.uploadMaxBytes / 1024 / 1024))} MB 上传上限，已停止，不会上传超限文件。`)
        }
        span = Math.max(MIN_SEGMENT_SECONDS, span / 2)
        heightIndex = 0
        continue
      }
      await ctx.move(file?.path || partPath, finalPath)
      const piece = {
        start: round3(start), end: round3(pieceEnd), file: name, path: finalPath, bytes, height,
        status: 'pending', text: '', error: '',
      }
      if (pieceEnd >= end - 0.05) return [piece]
      const overlap = Math.min(ctx.overlap, Math.max(0, (pieceEnd - start) / 2))
      const advance = overlap > 0 ? pieceEnd - overlap : pieceEnd
      if (advance >= end - 0.05) return [piece]
      if (advance <= start + 0.05) throw new Error('分段没有前进，已停止，不会上传超限文件。')
      const rest = await cutToFit(advance, end, ctx, depth + 1)
      return [piece, ...rest]
    } catch (e) {
      await ctx.remove(partPath)
      await ctx.remove(finalPath)
      if (ctx.signal?.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') throw abortError(ctx.signal)
      const msg = String(e?.message || e)
      if (/已停止|没有前进|次数过多/.test(msg)) throw e
      if (heightIndex < HEIGHTS.length - 1) { heightIndex += 1; continue }
      if (span <= MIN_SEGMENT_SECONDS + 0.01) {
        throw new Error(`片段 ${formatStamp(start)}–${formatStamp(pieceEnd)} 无法压到上传上限以内（${msg.slice(0, 160)}）。已停止，不会上传超限文件。`)
      }
      span = Math.max(MIN_SEGMENT_SECONDS, span / 2)
      heightIndex = 0
    }
  }
  throw new Error('分段次数过多，已停止，不会上传超限文件。')
}

function publicPiece(p, i) {
  return {
    index: i,
    start: p.start,
    end: p.end,
    file: p.file,
    bytes: p.bytes,
    height: p.height || 0,
    status: p.status,
    text: p.text || '',
    error: p.error || '',
  }
}

export async function runSegmented(opts = {}) {
  const filePath = opts.filePath
  const purpose = opts.purpose === 'watch' ? 'watch' : 'describe'
  const signal = opts.signal
  const uploadMaxBytes = Number(opts.uploadMaxBytes) || SESSION_UPLOAD_MAX
  const segmentSeconds = Number(opts.segmentSeconds) || DEFAULT_SEGMENT_SECONDS
  const overlapSeconds = Math.max(0, Number(opts.overlapSeconds) || 0)
  const ioStat = opts.io?.stat || stat
  const ioRead = opts.io?.readFile || readFile
  const remove = async (p) => { try { await rm(p, { force: true }) } catch {} }
  if (!filePath) return { ok: false, error: '没有可分段的本地视频文件。' }
  try { await ioStat(filePath) } catch { return { ok: false, error: `文件不存在：${filePath}` } }
  if (signal?.aborted) return { ok: false, error: abortMessage(signal) }
  const lockKey = JSON.stringify({
    file: resolve(filePath),
    purpose,
    question: purpose === 'watch' ? String(opts.question || '').replace(/\s+/g, ' ').trim().toLowerCase() : '',
    start: purpose === 'watch' ? (opts.startSec ?? null) : null,
    end: purpose === 'watch' ? (opts.endSec ?? null) : null,
    segmentSeconds,
    overlapSeconds,
    uploadMaxBytes,
    model: String(opts.model || opts.auth?.model || ''),
    cred: credentialHash(opts.credentialMaterial),
    algo: CUT_ALGO,
  })
  return enqueueRun(lockKey, () => runSegmentedBody(opts, { filePath, purpose, signal, uploadMaxBytes, segmentSeconds, overlapSeconds, ioStat, ioRead, remove }))
}

async function runSegmentedBody(opts, { filePath, purpose, signal, uploadMaxBytes, segmentSeconds, overlapSeconds, ioStat, ioRead, remove }) {
  let duration = Number(opts.durationSec) || 0
  const probe = opts.probe || (opts.bins?.ok ? (p) => probeDuration(p, { ffprobe: opts.bins.ffprobe, execFileImpl: opts.execFile, signal }) : null)
  if (!(duration > 0)) {
    if (!probe) return { ok: false, error: opts.bins?.error || FFMPEG_MISSING }
    try { duration = await probe(filePath) } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return { ok: false, error: abortMessage(signal) }
      return { ok: false, error: e?.code === 'FFMPEG_MISSING' || e?.missing ? FFMPEG_MISSING : '无法读取视频时长。请确认文件是有效视频，且 ffprobe 可用。' }
    }
  }

  const ranged = purpose === 'watch' && (opts.startSec != null || opts.endSec != null)
  const planned = ranged
    ? clipsForRange(duration, { start: opts.startSec, end: opts.endSec, segmentSeconds, overlapSeconds })
    : { clips: planSegments(duration, { segmentSeconds, overlapSeconds }), clamped: false, duration }
  if (planned.error) return { ok: false, error: planned.error }
  if (!planned.clips?.length) return { ok: false, error: '没有可分析的片段。' }

  const fp = await fingerprintFile(filePath, opts.io)
  const cred = credentialHash(opts.credentialMaterial)
  const params = {
    fp: fp.id,
    segmentSeconds,
    overlapSeconds,
    uploadMaxBytes,
    purpose,
    question: purpose === 'watch' ? String(opts.question || '').replace(/\s+/g, ' ').trim().toLowerCase() : '',
    start: ranged ? opts.startSec : null,
    end: ranged ? opts.endSec : null,
    model: String(opts.model || opts.auth?.model || ''),
    cred,
    algo: CUT_ALGO,
  }
  const paths = cachePaths(opts.cacheRoot || join(dirname(filePath), 'segments'), filePath, fp, params)
  await mkdir(paths.clipDir, { recursive: true })
  const previousSource = await readJson(paths.sourceFile)
  if (previousSource && previousSource.id && previousSource.id !== fp.id) {
    await rm(paths.dir, { recursive: true, force: true }).catch(() => {})
    await mkdir(paths.clipDir, { recursive: true })
  }
  await writeJson(paths.sourceFile, { id: fp.id, size: fp.size, mtimeMs: fp.mtimeMs, path: filePath })

  const describe = opts.describe || describeVideo
  const ask = opts.ask || askVideo
  let manifest = await readJson(paths.manifestFile)
  const manifestCurrent = manifest?.version === 2 && manifest?.algo === CUT_ALGO && (!manifest.fingerprint || manifest.fingerprint === fp.id)
  if (!manifestCurrent) manifest = null
  let seq = await firstFreeOrdinal(paths.clipDir, manifest?.pieces || [])
  const ctx = {
    filePath,
    ffmpeg: opts.bins?.ffmpeg,
    clipDir: paths.clipDir,
    uploadMaxBytes,
    overlap: Math.min(overlapSeconds, segmentSeconds > 1 ? segmentSeconds - 1 : 0),
    signal,
    allocName: () => `p${String(seq++).padStart(3, '0')}.mp4`,
    cutClip: opts.cutClip || ((spec) => ffmpegCut({ ...spec, execFileImpl: opts.execFile })),
    stat: ioStat,
    remove,
    move: async (src, dest) => {
      if (resolve(src) === resolve(dest)) return
      await moveFile(src, dest)
    },
  }

  let pieces = []
  try {
    if (Array.isArray(manifest?.pieces) && manifest.pieces.length) {
      for (const raw of manifest.pieces) {
        const name = safePieceName(raw.file)
        const full = name ? join(paths.clipDir, name) : ''
        let valid = false
        if (full) {
          try {
            const st = await ioStat(full)
            valid = st.size > 0 && st.size <= uploadMaxBytes
          } catch { valid = false }
        }
        if (raw.status === 'ok' && raw.text && valid) {
          pieces.push({ ...raw, path: full, file: name })
          continue
        }
        if (valid) {
          pieces.push({ ...raw, path: full, file: name, status: 'pending', text: '', error: '' })
          continue
        }
        const made = await cutToFit(Number(raw.start) || 0, Number(raw.end) || 0, ctx, 0)
        pieces.push(...made)
      }
    } else {
      for (const clip of planned.clips) pieces.push(...await cutToFit(clip.start, clip.end, ctx, 0))
    }
  } catch (e) {
    await sweepParts(paths.clipDir)
    if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return { ok: false, error: abortMessage(signal) }
    return { ok: false, error: String(e?.message || e).slice(0, 400) }
  }
  pieces = pieces.map((p, i) => ({ ...p, index: i }))
  if (!pieces.length) return { ok: false, error: '没有生成可上传的片段。' }

  let active = 0
  let peak = 0
  const analyzed = await mapLimit(pieces, Math.min(MAX_PARALLEL, opts.maxParallel || MAX_PARALLEL), async (piece) => {
    if (piece.status === 'ok' && piece.text) return piece
    if (signal?.aborted) return { ...piece, status: 'error', error: abortMessage(signal), text: '' }
    let data
    try { data = await ioRead(piece.path) } catch { return { ...piece, status: 'error', error: '分段文件不存在，已跳过上传。', text: '' } }
    if (!data?.length || data.length > uploadMaxBytes) {
      return { ...piece, status: 'error', error: '分段超过上传上限，已拒绝上传。', text: '' }
    }
    active += 1
    peak = Math.max(peak, active)
    try {
      const prompt = segmentPrompt(piece, duration, { purpose, question: opts.question })
      const call = purpose === 'watch' ? ask : describe
      const r = await call({
        ...opts.auth,
        meta: { name: piece.file, mediaType: 'video/mp4' },
        load: async () => data,
        saveRemote: async () => {},
        prompt,
        question: opts.question,
        signal,
      })
      if (!r?.ok) return { ...piece, status: 'error', error: String(r?.error || '视频理解失败').slice(0, 300), text: '' }
      return { ...piece, status: 'ok', text: r.text, error: '' }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return { ...piece, status: 'error', error: abortMessage(signal), text: '' }
      return { ...piece, status: 'error', error: String(e?.message || e).slice(0, 300), text: '' }
    } finally {
      active -= 1
      data = null
    }
  })
  await sweepParts(paths.clipDir)
  const stored = analyzed.map((p, i) => publicPiece(p, i))
  const failures = stored.filter((p) => p.status !== 'ok')
  const okPieces = stored.filter((p) => p.status === 'ok' && p.text)
  await writeJson(paths.manifestFile, { version: 2, algo: CUT_ALGO, fingerprint: fp.id, duration, pieces: stored })
  if (!okPieces.length) {
    return { ok: false, partial: false, error: failures.map((f) => f.error).filter(Boolean).join('；') || '视频理解失败', pieces: stored, peak, cacheDir: paths.dir }
  }
  const text = mergeSegmentTexts(okPieces, { duration, clamped: planned.clamped, failures })
  const cached = stored.every((p) => manifest?.pieces?.some((old) => old.file === p.file && old.status === 'ok' && old.text === p.text))
  return {
    ok: true,
    partial: failures.length > 0,
    text,
    pieces: stored,
    cached,
    peak,
    duration,
    cacheDir: paths.dir,
    clipDir: paths.clipDir,
    manifestFile: paths.manifestFile,
  }
}

export async function analyzeMedia(opts = {}) {
  const settings = opts.settings || {}
  const autoSegment = settings.autoSegment !== false
  const segmentSeconds = Number(settings.segmentSeconds) > 0 ? Number(settings.segmentSeconds) : DEFAULT_SEGMENT_SECONDS
  const overlapSeconds = settings.overlapSeconds == null || settings.overlapSeconds === '' ? DEFAULT_OVERLAP_SECONDS : Number(settings.overlapSeconds)
  let bytes = Number(opts.bytes) || 0
  if (opts.filePath && !(bytes > 0)) {
    try { bytes = (await stat(opts.filePath)).size } catch { bytes = 0 }
  }
  const uploadMaxBytes = Number(opts.uploadMaxBytes) || SESSION_UPLOAD_MAX
  let bins = opts.bins
  const resolveBins = () => resolveVideoFfmpeg({ cfg: opts.cfg, whichImpl: opts.whichImpl, execImpl: opts.execFile, existsImpl: opts.existsImpl })
  const probe = opts.filePath && autoSegment ? async () => {
    if (!bins) bins = await resolveBins()
    if (!bins?.ok) {
      const err = new Error(bins?.error || FFMPEG_MISSING)
      err.code = 'FFMPEG_MISSING'
      err.missing = true
      throw err
    }
    return probeDuration(opts.filePath, { ffprobe: bins.ffprobe, execFileImpl: opts.execFile, signal: opts.signal })
  } : null
  const decision = await shouldSegmentFile({
    bytes,
    durationSec: opts.durationSec || 0,
    uploadMaxBytes,
    segmentSeconds,
    autoSegment,
    probe,
  })
  if (!decision.segment) {
    const call = opts.purpose === 'watch' ? (opts.ask || askVideo) : (opts.describe || describeVideo)
    return call({
      ...opts.auth,
      meta: opts.meta,
      load: opts.load,
      saveRemote: opts.saveRemote,
      question: opts.question,
      start: opts.start,
      end: opts.end,
      signal: opts.signal,
    })
  }
  if (decision.missing) return { ok: false, error: FFMPEG_MISSING }
  if (!bins) bins = await resolveBins()
  if (!bins?.ok && !opts.cutClip) return { ok: false, error: bins?.error || FFMPEG_MISSING }
  const startSec = opts.startSec != null ? Number(opts.startSec) : parseOffset(opts.start)
  const endSec = opts.endSec != null ? Number(opts.endSec) : parseOffset(opts.end)
  return runSegmented({
    filePath: opts.filePath,
    purpose: opts.purpose,
    question: opts.question,
    startSec: opts.purpose === 'watch' ? startSec : null,
    endSec: opts.purpose === 'watch' ? endSec : null,
    durationSec: decision.durationSec || opts.durationSec || 0,
    uploadMaxBytes,
    segmentSeconds,
    overlapSeconds,
    model: opts.model || opts.auth?.model,
    credentialMaterial: opts.credentialMaterial,
    auth: opts.auth,
    cacheRoot: opts.cacheRoot,
    signal: opts.signal,
    bins,
    describe: opts.describe,
    ask: opts.ask,
    cutClip: opts.cutClip,
    probe: opts.probe,
    execFile: opts.execFile,
    io: opts.io,
  })
}
