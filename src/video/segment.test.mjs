import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, mkdir, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FFMPEG_MISSING, analyzeMedia, clipsForRange, createExec, credentialHash, ffmpegCut, mergeSegmentTexts,
  planSegments, probeDuration, probeMedia, resolveVideoFfmpeg, runSegmented, shiftTimestamps, shouldSegmentFile,
} from './segment.mjs'
import { videoSettings } from './index.mjs'
import { createVideoTools } from './tools.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const samples = join(root, 'docs', 'video-segmentation-samples')
const DOUYIN = 'C:\\Users\\10917\\AppData\\Local\\Temp\\dsh-douyin-trial\\7710906517213416730.mp4'
const SECRET = 'SECRET-VIDEO-KEY-SHOULD-NOT-LEAK-9f3a'
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-seg-'))

function execFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function keyframeTimes(ffprobe, file) {
  const { stdout } = await execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file])
  return String(stdout).split(/\s+/).map(Number).filter((n) => Number.isFinite(n))
}

async function frameScore(ffmpeg, fileA, timeA, fileB, timeB) {
  const { stderr } = await execFile(ffmpeg, [
    '-hide_banner', '-nostats',
    '-ss', String(timeA), '-i', fileA,
    '-ss', String(timeB), '-i', fileB,
    '-lavfi', '[0:v][1:v]ssim',
    '-frames:v', '1', '-f', 'null', '-',
  ])
  const m = String(stderr).match(/All:([0-9.]+)/)
  return m ? Number(m[1]) : 0
}

async function walk(dir, out = []) {
  let names = []
  try { names = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const n of names) {
    const p = join(dir, n.name)
    if (n.isDirectory()) await walk(p, out)
    else out.push(p)
  }
  return out
}

async function fakeCut(spec) {
  await writeFile(spec.output, Buffer.from('seg'))
  return { path: spec.output, bytes: 3 }
}

function sourceIo(filePath, size) {
  const positions = []
  return {
    positions,
    io: {
      stat: async (p) => (p === filePath ? { size, mtimeMs: 10, isFile: () => true } : stat(p)),
      open: async () => ({
        async read(_buf, _off, len, pos) {
          positions.push(pos)
          if (pos > 65536 && pos < size - 65536) throw new Error('读取了原视频中部')
          return { bytesRead: Math.min(len, 8) }
        },
        async close() {},
      }),
      readFile: async (p) => {
        if (p === filePath) throw new Error('整文件被读入内存')
        return readFile(p)
      },
    },
  }
}

test('probeDuration passes an argument array, windowsHide, and no shell', async () => {
  let seen = null
  const duration = await probeDuration('clip.mp4', {
    ffprobe: 'ffprobe',
    execFileImpl: async (file, args, options) => {
      seen = { file, args, options }
      return { stdout: '{"format":{"duration":"12.5"}}', stderr: '' }
    },
  })
  assert.equal(duration, 12.5)
  assert.equal(seen.file, 'ffprobe')
  assert.equal(seen.options.windowsHide, true)
  assert.equal(seen.options.shell, undefined)
  assert.ok(Array.isArray(seen.args))
  assert.equal(seen.args.at(-1), 'clip.mp4')
  const run = createExec(async (_file, args) => {
    assert.ok(Array.isArray(args))
    return { stdout: '', stderr: '' }
  })
  await run('ffmpeg', ['-version'], {})
})

test('missing FFmpeg returns the Chinese message and does not run a program', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'big.mp4')
    await writeFile(file, Buffer.alloc(64, 1))
    const execs = []
    const r = await analyzeMedia({
      filePath: file,
      bytes: 30 * 1024 * 1024,
      uploadMaxBytes: 1024 * 1024,
      settings: { autoSegment: true, segmentSeconds: 600, overlapSeconds: 5 },
      whichImpl: () => null,
      existsImpl: () => false,
      execFile: async () => { execs.push(1); return { stdout: '', stderr: '' } },
      describe: async () => { throw new Error('不应分析') },
      auth: { apiKey: 'x', model: 'm', credentialSource: 'apiKey' },
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, FFMPEG_MISSING)
    assert.equal(execs.length, 0)
    const bins = await resolveVideoFfmpeg({ whichImpl: () => null, existsImpl: () => false, execImpl: async () => { execs.push(1) } })
    assert.equal(bins.ok, false)
    assert.equal(bins.error, FFMPEG_MISSING)
    assert.equal(execs.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a small video is not segmented and ffmpeg is not invoked', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'small.mp4')
    await writeFile(file, Buffer.alloc(2048, 2))
    let probes = 0
    const decision = await shouldSegmentFile({ bytes: 2048, uploadMaxBytes: 200 * 1024 * 1024, segmentSeconds: 600, probe: async () => { probes++; throw new Error('不是有效视频') } })
    assert.equal(probes, 1)
    assert.equal(decision.segment, false)
    const longSmall = await shouldSegmentFile({ bytes: 4129361, uploadMaxBytes: 200 * 1024 * 1024, segmentSeconds: 600, probe: async () => 1210 })
    assert.equal(longSmall.segment, true)
    assert.equal(longSmall.reason, 'duration')
    assert.equal(longSmall.durationSec, 1210)
    const brief = await shouldSegmentFile({ bytes: 4129361, uploadMaxBytes: 200 * 1024 * 1024, segmentSeconds: 600, probe: async () => 10 })
    assert.equal(brief.segment, false)
    const execs = []
    let described = 0
    const r = await analyzeMedia({
      filePath: file,
      bytes: 2048,
      uploadMaxBytes: 200 * 1024 * 1024,
      settings: { autoSegment: true, segmentSeconds: 600, overlapSeconds: 5 },
      execFile: async () => { execs.push(1) },
      whichImpl: () => null,
      meta: { name: 'small.mp4', mediaType: 'video/mp4' },
      load: () => readFile(file),
      auth: { apiKey: 'k', model: 'm', credentialSource: 'apiKey' },
      describe: async () => { described++; return { ok: true, text: '[0:00] 短视频' } },
    })
    assert.equal(r.ok, true)
    assert.equal(r.text, '[0:00] 短视频')
    assert.equal(described, 1)
    assert.equal(execs.length, 0)
    assert.equal((await shouldSegmentFile({ bytes: 10, durationSec: 99999, uploadMaxBytes: 100, autoSegment: false })).segment, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a long video is fingerprinted from both ends and the original is never read whole', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'long.mp4')
    await writeFile(file, Buffer.from('x'))
    const size = 80 * 1024 * 1024
    const io = sourceIo(file, size)
    const r = await runSegmented({
      filePath: file,
      durationSec: 1300,
      segmentSeconds: 600,
      overlapSeconds: 5,
      uploadMaxBytes: 200 * 1024 * 1024,
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: io.io,
      cutClip: fakeCut,
      describe: async () => ({ ok: true, text: '[0:01] 一段' }),
    })
    assert.equal(r.ok, true)
    assert.ok(r.pieces.length >= 3)
    assert.deepEqual(io.positions, [0, size - 65536])
    assert.match(r.text, /## 片段 3/)
    assert.ok(r.text.length > 40)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('watch start/end uploads only the covering range', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'two-hour.mp4')
    await writeFile(file, Buffer.from('x'))
    const cuts = []
    const r = await runSegmented({
      filePath: file,
      purpose: 'watch',
      startSec: 100,
      endSec: 130,
      durationSec: 7200,
      segmentSeconds: 600,
      overlapSeconds: 5,
      uploadMaxBytes: 200 * 1024 * 1024,
      question: '这一小段里有什么？',
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 90 * 1024 * 1024).io,
      cutClip: async (spec) => { cuts.push({ start: spec.start, duration: spec.duration }); return fakeCut(spec) },
      ask: async () => ({ ok: true, text: '[0:01] 范围内的画面' }),
    })
    assert.equal(r.ok, true)
    assert.equal(cuts.length, 1)
    assert.equal(cuts[0].start, 100)
    assert.ok(Math.abs(cuts[0].duration - 30) < 0.05)
    assert.match(r.text, /原视频 1:40–2:10/)
    const past = clipsForRange(100, { start: 120, end: 130 })
    assert.match(past.error, /超出视频时长/)
    const backwards = clipsForRange(100, { start: 40, end: 40 })
    assert.match(backwards.error, /晚于 start/)
    const clamped = clipsForRange(100, { start: 90, end: 500 })
    assert.equal(clamped.clamped, true)
    assert.equal(clamped.clips.at(-1).end, 100)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an over-limit segment is shrunk a bounded number of times and never uploaded', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'fat.mp4')
    await writeFile(file, Buffer.from('x'))
    let cuts = 0
    let asked = 0
    const r = await runSegmented({
      filePath: file,
      durationSec: 30,
      segmentSeconds: 600,
      overlapSeconds: 0,
      uploadMaxBytes: 1024,
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 4096).io,
      cutClip: async (spec) => {
        cuts++
        await writeFile(spec.output, Buffer.from('x'))
        return { path: spec.output, bytes: 50 * 1024 * 1024 }
      },
      describe: async () => { asked++; return { ok: true, text: '不应出现' } },
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /不会上传超限文件/)
    assert.ok(cuts > 1)
    assert.ok(cuts < 80)
    assert.equal(asked, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('timestamps move onto the original timeline and overlap lines are dropped', () => {
  assert.equal(shiftTimestamps('[1:00] 猫出现', 90), '[2:30] 猫出现')
  assert.equal(shiftTimestamps('[1:02:03] 说话', 90), '[1:03:33] 说话')
  const merged = mergeSegmentTexts([
    { start: 0, end: 10, text: '[0:09] 前一段', status: 'ok' },
    { start: 8, end: 16, text: '[0:01] 重叠\n[0:03] 新内容', status: 'ok' },
  ], { duration: 16 })
  assert.match(merged, /前一段/)
  assert.doesNotMatch(merged, /重叠/)
  assert.match(merged, /新内容/)
  const chunk = '[0:01] ' + '画面'.repeat(800)
  const text = mergeSegmentTexts(
    Array.from({ length: 5 }, (_v, i) => ({ start: i * 10, end: i * 10 + 10, text: chunk, status: 'ok' })),
    { duration: 50 },
  )
  assert.ok(text.length > 4000)
  assert.match(text, /## 片段 5（原视频 0:40–0:50）/)
  assert.ok(!text.includes('画面'.repeat(800) + '画面'))
})

test('at most two segments are analyzed at once', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'parallel.mp4')
    await writeFile(file, Buffer.from('x'))
    let current = 0
    let peak = 0
    const r = await runSegmented({
      filePath: file,
      durationSec: 40,
      segmentSeconds: 10,
      overlapSeconds: 0,
      uploadMaxBytes: 1024 * 1024,
      maxParallel: 9,
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 4096).io,
      cutClip: fakeCut,
      describe: async () => {
        current += 1
        peak = Math.max(peak, current)
        await new Promise((resolve) => setTimeout(resolve, 40))
        current -= 1
        return { ok: true, text: '[0:01] 并行' }
      },
    })
    assert.equal(r.ok, true)
    assert.equal(r.pieces.length, 4)
    assert.ok(peak <= 2)
    assert.ok(r.peak <= 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('cache reuses analysis, invalidates when the file changes, and isolates credentials', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'cached.mp4')
    await writeFile(file, Buffer.alloc(128, 7))
    const cacheRoot = join(dir, 'cache')
    let calls = 0
    const describe = async () => { calls++; return { ok: true, text: '[0:01] 缓存内容' } }
    const base = {
      filePath: file,
      bytes: 128,
      durationSec: 20,
      uploadMaxBytes: 1024 * 1024,
      settings: { autoSegment: true, segmentSeconds: 12, overlapSeconds: 2 },
      model: 'gemini-3.8-flash',
      cacheRoot,
      auth: { apiKey: SECRET, model: 'gemini-3.8-flash', credentialSource: 'apiKey' },
      credentialMaterial: { mode: 'apiKey', key: SECRET },
      cutClip: fakeCut,
      describe,
      bins: { ok: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    }
    const first = await analyzeMedia(base)
    assert.equal(first.ok, true)
    const afterFirst = calls
    assert.ok(afterFirst >= 2)
    const second = await analyzeMedia(base)
    assert.equal(second.ok, true)
    assert.equal(calls, afterFirst)
    assert.equal(second.cached, true)
    const st = await stat(file)
    await writeFile(file, Buffer.alloc(129, 8))
    await utimes(file, st.atime, new Date(st.mtimeMs + 5000))
    const third = await analyzeMedia({ ...base, bytes: 129 })
    assert.equal(third.ok, true)
    assert.ok(calls > afterFirst)
    const afterChange = calls
    const other = await analyzeMedia({
      ...base,
      bytes: 129,
      auth: { ...base.auth, apiKey: SECRET + '-other' },
      credentialMaterial: { mode: 'apiKey', key: SECRET + '-other' },
    })
    assert.equal(other.ok, true)
    assert.ok(calls > afterChange)
    assert.notEqual(credentialHash({ mode: 'apiKey', key: SECRET }), credentialHash({ mode: 'apiKey', key: SECRET + '-other' }))
    const dumped = await Promise.all((await walk(cacheRoot)).map(async (p) => readFile(p)))
    assert.ok(dumped.every((buf) => !buf.includes(Buffer.from(SECRET))))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a failed piece keeps the successful text and is the only piece retried', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'partial.mp4')
    await writeFile(file, Buffer.from('x'))
    const names = []
    const describe = async (o) => {
      names.push(o.meta.name)
      if (o.meta.name === 'p001.mp4') return { ok: false, error: '这一段配额用尽' }
      return { ok: true, text: '[0:01] 成功的画面' }
    }
    const base = {
      filePath: file,
      durationSec: 20,
      segmentSeconds: 12,
      overlapSeconds: 2,
      uploadMaxBytes: 1024 * 1024,
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 4096).io,
      cutClip: fakeCut,
      describe,
    }
    const first = await runSegmented(base)
    assert.equal(first.ok, true)
    assert.equal(first.partial, true)
    assert.match(first.text, /成功的画面/)
    assert.match(first.text, /1:40|0:10/)
    assert.match(first.text, /配额用尽/)
    const before = names.length
    const second = await runSegmented(base)
    assert.equal(second.partial, true)
    assert.deepEqual(names.slice(before), ['p001.mp4'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('timeout removes partial segment files', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'cancel.mp4')
    await writeFile(file, Buffer.from('x'))
    const cacheRoot = join(dir, 'cache')
    const ac = new AbortController()
    const r = await runSegmented({
      filePath: file,
      durationSec: 20,
      segmentSeconds: 600,
      overlapSeconds: 0,
      uploadMaxBytes: 1024 * 1024,
      cacheRoot,
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      signal: ac.signal,
      io: sourceIo(file, 4096).io,
      cutClip: async (spec) => {
        await mkdir(dirname(spec.output), { recursive: true })
        await writeFile(spec.output, Buffer.from('partial'))
        ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        const err = new Error('stop')
        err.name = 'AbortError'
        throw err
      },
      describe: async () => ({ ok: true, text: '不应分析' }),
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, '视频分段或分析超时，已停止并清理临时文件。')
    const left = await walk(cacheRoot)
    assert.ok(left.every((p) => !p.endsWith('.part') && !p.endsWith('.tmp')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real FFmpeg cuts a 20 second synthetic video', async (t) => {
  const bins = await resolveVideoFfmpeg({})
  if (!bins.ok) return t.skip(bins.error || FFMPEG_MISSING)
  await mkdir(samples, { recursive: true })
  const src = join(samples, 'synthetic-20s.mp4')
  const cacheRoot = join(samples, 'cache')
  await rm(cacheRoot, { recursive: true, force: true })
  await execFile(bins.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=20',
    '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-g', '240', '-keyint_min', '240', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k',
    src,
  ])
  const probed = await probeDuration(src, { ffprobe: bins.ffprobe })
  assert.ok(probed > 19 && probed < 21)
  const described = []
  const r = await analyzeMedia({
    filePath: src,
    bytes: (await stat(src)).size,
    durationSec: probed,
    uploadMaxBytes: 200 * 1024 * 1024,
    bins,
    settings: { autoSegment: true, segmentSeconds: 8, overlapSeconds: 1 },
    model: 'gemini-test',
    credentialMaterial: { mode: 'apiKey', key: 'sample' },
    auth: { apiKey: 'sample', model: 'gemini-test', credentialSource: 'apiKey' },
    cacheRoot,
    describe: async (o) => {
      described.push(o.prompt)
      return { ok: true, text: '[0:01] 彩条与蜂鸣' }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.pieces.length, 3)
  assert.equal(described.length, 3)
  assert.match(described[0], /从本片段的 0:00 起算/)
  const expectedDurations = [8, 8, 6]
  const probedPieces = []
  for (let i = 0; i < r.pieces.length; i++) {
    const piece = r.pieces[i]
    const full = join(r.clipDir, piece.file)
    const st = await stat(full)
    assert.ok(st.size > 0)
    assert.ok(st.size <= 200 * 1024 * 1024)
    const media = await probeMedia(full, { ffprobe: bins.ffprobe })
    assert.ok(Math.abs(media.duration - expectedDurations[i]) < 0.4, `${piece.file} 实际时长 ${media.duration}，计划 ${expectedDurations[i]}`)
    assert.ok(media.startTime < 0.2, `${piece.file} 起点 ${media.startTime}`)
    probedPieces.push({ ...piece, path: full, probedDuration: media.duration, probedStart: media.startTime })
  }
  const keys = await keyframeTimes(bins.ffprobe, src)
  assert.ok(keys.length >= 1)
  assert.ok(keys[0] < 0.2)
  assert.ok(keys.every((t) => t < 0.2 || t > 8), `关键帧落在非起点的分段起点上：${keys.join(',')}`)
  const shifted = probedPieces[1]
  const same = await frameScore(bins.ffmpeg, shifted.path, 0.4, src, shifted.start + 0.4)
  const other = await frameScore(bins.ffmpeg, shifted.path, 0.4, src, 0.4)
  assert.ok(same > 0.9 && same > other, `片段画面没有对上原片 ${shifted.start + 0.4} 秒（正确位置 ${same}，开头 ${other}）`)
  const watchRoot = await tmp()
  try {
    const watchUploads = []
    const watched = await analyzeMedia({
      filePath: src,
      bytes: (await stat(src)).size,
      durationSec: probed,
      uploadMaxBytes: 200 * 1024 * 1024,
      bins,
      purpose: 'watch',
      question: '这一段里有什么',
      startSec: 7,
      endSec: 15,
      settings: { autoSegment: true, segmentSeconds: 8, overlapSeconds: 1 },
      model: 'gemini-test',
      credentialMaterial: { mode: 'apiKey', key: 'sample-watch' },
      auth: { apiKey: 'sample-watch', model: 'gemini-test', credentialSource: 'apiKey' },
      cacheRoot: watchRoot,
      ask: async (o) => {
        watchUploads.push(await o.load())
        return { ok: true, text: '[0:01] 只有这一段' }
      },
    })
    assert.equal(watched.ok, true)
    assert.equal(watched.pieces.length, 1)
    assert.equal(watchUploads.length, 1)
    const watchPath = join(watched.clipDir, watched.pieces[0].file)
    const watchMedia = await probeMedia(watchPath, { ffprobe: bins.ffprobe })
    assert.ok(Math.abs(watchMedia.duration - 8) < 0.4, `范围片段实际时长 ${watchMedia.duration}`)
    assert.ok(watchMedia.startTime < 0.2)
    const watchSame = await frameScore(bins.ffmpeg, watchPath, 0.4, src, 7.4)
    const watchOther = await frameScore(bins.ffmpeg, watchPath, 0.4, src, 0.4)
    assert.ok(watchSame > 0.9 && watchSame > watchOther, `范围片段没有对上原片 7.4 秒（正确位置 ${watchSame}，开头 ${watchOther}）`)
    assert.ok(watchUploads[0].length < (await stat(src)).size * 0.95)
  } finally { await rm(watchRoot, { recursive: true, force: true }) }
  const index = {
    source: src,
    cacheDir: r.cacheDir,
    clipDir: r.clipDir,
    duration: r.duration,
    segmentSeconds: 8,
    overlapSeconds: 1,
    cut: 'reencode',
    pieces: probedPieces,
  }
  await writeFile(join(samples, 'segments.json'), JSON.stringify(index, null, 2))
  assert.match(r.text, /## 片段 1/)
  assert.match(r.text, /彩条与蜂鸣/)
})

test('ffprobe plans the read-only Douyin file without rewriting it', async (t) => {
  if (!existsSync(DOUYIN)) return t.skip('本机抖音样片不在，跳过只读规划')
  const bins = await resolveVideoFfmpeg({})
  if (!bins.ok) return t.skip(bins.error || FFMPEG_MISSING)
  const before = await stat(DOUYIN)
  const duration = await probeDuration(DOUYIN, { ffprobe: bins.ffprobe })
  const after = await stat(DOUYIN)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.size, 1427577145)
  const plan = planSegments(duration, { segmentSeconds: 600, overlapSeconds: 5 })
  assert.ok(plan.length > 1)
  assert.equal(plan[0].start, 0)
  assert.ok(Math.abs(plan.at(-1).end - duration) < 0.05)
  await writeFile(join(samples, 'douyin-plan.json'), JSON.stringify({
    path: DOUYIN,
    bytes: before.size,
    mtime: before.mtime.toISOString(),
    duration,
    segmentSeconds: 600,
    overlapSeconds: 5,
    count: plan.length,
    plan,
    note: '只做 ffprobe 与时间规划，没有切割、改写或删除该文件。',
  }, null, 2))
})

test('ffmpegCut re-encodes from the requested start and does not stream-copy', async () => {
  const dir = await tmp()
  try {
    const out = join(dir, 'out.mp4')
    const seen = []
    await ffmpegCut({
      ffmpeg: join(dir, 'bin', 'ffmpeg.exe'),
      input: 'in.mp4',
      output: out,
      start: 7.2,
      duration: 8,
      execFileImpl: async (_file, args) => {
        seen.push(args)
        await writeFile(out, Buffer.from('x'))
        return { stdout: '', stderr: '' }
      },
    })
    const args = seen[0]
    assert.equal(args.includes('copy'), false)
    assert.ok(args.includes('-accurate_seek'))
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'))
    assert.equal(args[args.indexOf('-ss') + 1], '7.2')
    assert.equal(args[args.indexOf('-t') + 1], '8')
    assert.equal(args.at(-1), out)
    assert.equal(args.at(-2), 'mp4')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('rebuilding a missing middle piece keeps the other pieces and their names', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'gap.mp4')
    await writeFile(file, Buffer.alloc(256, 3))
    const cutClip = async (spec) => {
      const body = Buffer.from(`start=${Number(spec.start).toFixed(3)};dur=${Number(spec.duration).toFixed(3)}`)
      await writeFile(spec.output, body)
      return { path: spec.output, bytes: body.length }
    }
    const base = {
      filePath: file,
      durationSec: 20,
      segmentSeconds: 8,
      overlapSeconds: 1,
      uploadMaxBytes: 1024 * 1024,
      cacheRoot: join(dir, 'cache'),
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 4096).io,
      cutClip,
      describe: async () => ({ ok: true, text: '[0:01] 段' }),
    }
    const first = await runSegmented(base)
    assert.equal(first.ok, true)
    assert.equal(first.pieces.length, 3)
    const paths = first.pieces.map((p) => join(first.clipDir, p.file))
    const before = await Promise.all(paths.map((p) => readFile(p)))
    await rm(paths[1], { force: true })
    const second = await runSegmented(base)
    assert.equal(second.ok, true)
    const names = second.pieces.map((p) => p.file)
    assert.equal(new Set(names).size, names.length)
    assert.equal(names[0], first.pieces[0].file)
    assert.equal(names[2], first.pieces[2].file)
    assert.notEqual(names[1], names[0])
    assert.notEqual(names[1], names[2])
    assert.deepEqual(await readFile(join(second.clipDir, names[0])), before[0])
    assert.deepEqual(await readFile(join(second.clipDir, names[2])), before[2])
    const mid = String(await readFile(join(second.clipDir, names[1])))
    assert.match(mid, /start=7\.000/)
    assert.match(mid, /dur=8\.000/)
    for (const piece of second.pieces) assert.equal(existsSync(join(second.clipDir, piece.file)), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('two callers with the same cache key cut once and do not leave partial files', async () => {
  const dir = await tmp()
  try {
    const file = join(dir, 'once.mp4')
    await writeFile(file, Buffer.alloc(128, 4))
    const cacheRoot = join(dir, 'cache')
    let active = 0
    let peak = 0
    let describes = 0
    const opts = {
      filePath: file,
      durationSec: 20,
      segmentSeconds: 8,
      overlapSeconds: 1,
      uploadMaxBytes: 1024 * 1024,
      cacheRoot,
      credentialMaterial: { mode: 'apiKey', key: 'k' },
      model: 'm',
      io: sourceIo(file, 4096).io,
      cutClip: async (spec) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 40))
        active -= 1
        await writeFile(spec.output, Buffer.from(`s=${spec.start}`))
        return { path: spec.output, bytes: 4 }
      },
      describe: async () => { describes += 1; return { ok: true, text: '[0:01] 一次' } },
    }
    const [a, b] = await Promise.all([runSegmented(opts), runSegmented(opts)])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(a.pieces.length, 3)
    assert.equal(describes, a.pieces.length)
    assert.equal(peak, 1)
    assert.equal(b.cached || a.cached, true)
    const names = a.pieces.map((p) => p.file)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(b.pieces.map((p) => p.file), names)
    const left = await walk(cacheRoot)
    assert.ok(left.every((p) => !p.endsWith('.part') && !p.endsWith('.tmp')))
    for (const name of names) assert.equal(existsSync(join(a.clipDir, name)), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a 1210 second file under 8MB is segmented by the session tool without a known duration', async (t) => {
  const proof = 'C:\\Users\\10917\\AppData\\Local\\Temp\\dsh-video-segmentation-proof\\long-1210s.mp4'
  if (!existsSync(proof)) return t.skip('本机长视频证明文件不在，跳过只读分段复核')
  const before = await stat(proof)
  assert.equal(before.size, 4129361)
  assert.ok(before.size < 8 * 1024 * 1024)
  const dir = await tmp()
  const uploads = []
  const res = (status, json) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => String(h).toLowerCase() === 'x-goog-upload-url' ? 'https://upload.test/segment' : null }, json: async () => json })
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes(':generateContent')) {
      const body = JSON.parse(init.body)
      const inline = body.contents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData?.data
      if (inline) uploads.push(Buffer.from(inline, 'base64'))
      return res(200, { candidates: [{ content: { parts: [{ text: '[0:01] 长视频片段' }] }, finishReason: 'STOP' }] })
    }
    if (u.includes('/upload/v1beta/files')) return res(200, {})
    if (u.startsWith('https://upload.test/')) {
      const buf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body || '')
      uploads.push(buf)
      return res(200, { file: { uri: `https://files.test/${uploads.length}`, name: `files/seg-${uploads.length}`, state: 'ACTIVE', mimeType: 'video/mp4' } })
    }
    return res(404, { error: { message: 'unexpected' } })
  }
  const gemini = { resolveKey: async () => ({ key: 'k', credentialSource: 'apiKey' }), fetch: () => fetchImpl }
  const config = { videoGeminiKey: 'k' }
  const list = createVideoTools({
    getSettings: () => videoSettings(config),
    getConfig: () => config,
    getGemini: () => gemini,
    videosRoot: () => dir,
  })
  const describe = list.find((t) => t.name === 'describe_video')
  const watch = list.find((t) => t.name === 'watch_video')
  try {
    const described = await describe.execute({ source: proof })
    assert.match(described.text, /片段/)
    assert.equal(uploads.length, 3)
    const bins = await resolveVideoFfmpeg({})
    const expected = [600, 600, 20]
    const submitted = []
    for (let i = 0; i < uploads.length; i++) {
      const piece = join(dir, `submitted-${i}.mp4`)
      await writeFile(piece, uploads[i])
      const media = await probeMedia(piece, { ffprobe: bins.ffprobe })
      assert.ok(Math.abs(media.duration - expected[i]) < 1.5, `提交的第 ${i + 1} 段实际时长 ${media.duration}，计划 ${expected[i]}`)
      assert.ok(media.startTime < 0.5)
      assert.ok(uploads[i].length < before.size * 4)
      submitted.push({ index: i, plannedDuration: expected[i], probedDuration: media.duration, probedStart: media.startTime, bytes: uploads[i].length })
    }
    uploads.length = 0
    const watched = await watch.execute({ source: proof, question: '这一小段里有什么', start: '100', end: '130' })
    assert.match(watched.text, /长视频片段/)
    assert.equal(uploads.length, 1)
    const one = join(dir, 'submitted-range.mp4')
    await writeFile(one, uploads[0])
    const range = await probeMedia(one, { ffprobe: bins.ffprobe })
    assert.ok(Math.abs(range.duration - 30) < 1.5, `范围问答实际上传时长 ${range.duration}`)
    assert.ok(uploads[0].length < before.size)
    await writeFile(join(samples, 'long-1210-submit.json'), JSON.stringify({
      source: proof,
      sourceBytes: before.size,
      sourceMtime: before.mtime.toISOString(),
      note: 'describe_video / watch_video 替身收到的实际上传字节，经 ffprobe 复核。没有调用计费 Gemini，也没有改写原片。',
      describe: submitted,
      watch: { start: 100, end: 130, probedDuration: range.duration, probedStart: range.startTime, bytes: uploads[0].length },
    }, null, 2))
    const after = await stat(proof)
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
