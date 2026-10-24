/**
 * 哔哩哔哩视频下载（可选）：找得到 yt-dlp 时启用。查找顺序：设置中的路径 → PATH → 设置页「下载 yt-dlp」下载到
 * <数据目录>/bin/ 的副本（见 ../video/ytdlp-install.mjs）。插件本身不附带 yt-dlp。
 * 下载到临时目录，单个文件受聊天室附件 25 MB 上限约束；失败时给中文原因。
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const YTDLP_MISSING = '未检测到 yt-dlp：观看哔哩哔哩视频需要 yt-dlp。可在「多模态 › 视频理解」中点击「下载 yt-dlp」，或自行安装并加入 PATH（无需重启）。'

function run(cmd, args, { timeout = 10000, signal } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
}

/** yt-dlp 失败输出 → 中文原因。 */
export function ytdlpReason(stderr, maxBytes) {
  const s = String(stderr || '')
  const mb = Math.round(maxBytes / 1024 / 1024)
  if (/larger than max-filesize|File is larger/i.test(s)) return `视频超过 ${mb} MB 上限，未下载。`
  if (/HTTP Error 412|HTTP Error 403|Precondition Failed/i.test(s)) return '哔哩哔哩拒绝了下载请求（可能需要登录或触发了风控），请稍后再试或改为上传视频文件。'
  if (/HTTP Error 404|Video unavailable|视频不存在|not found/i.test(s)) return '该哔哩哔哩视频不存在或不可访问。'
  if (/ffmpeg/i.test(s) && /not (found|installed)/i.test(s)) return '下载需要合并音视频，但本机未找到 ffmpeg。'
  if (/timed out|ETIMEDOUT|ECONNRESET|Unable to download/i.test(s)) return '下载哔哩哔哩视频时网络出错，请稍后再试。'
  const last = s.split(/\r?\n/).map((x) => x.trim()).filter((x) => /ERROR/i.test(x)).pop()
  return last ? `yt-dlp 下载失败：${last.replace(/^ERROR:\s*/i, '').slice(0, 160)}` : 'yt-dlp 下载失败。'
}

/**
 * candidates()：按顺序尝试的程序 [{ bin, source }]（source：setting / path / downloaded）；不给时只试 PATH 上的 bin。
 * @param {{ bin?: string, candidates?: () => Array<{ bin: string, source: string }>, runImpl?: typeof run, ttlMs?: number, now?: () => number }} [o]
 */
export function createYtdlp({ bin = 'yt-dlp', candidates, runImpl = run, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  let cached = null
  const list = () => {
    let c = []
    try { c = typeof candidates === 'function' ? candidates() || [] : [] } catch { c = [] }
    c = c.filter((x) => x && typeof x.bin === 'string' && x.bin.trim())
    return c.length ? c : [{ bin, source: 'path' }]
  }
  /** 依次探测，返回第一个能运行的 { version, bin, source }；都不行时 version 为 ''。结果缓存 10 分钟。 */
  async function resolve() {
    const cands = list()
    const sig = cands.map((c) => c.source + ':' + c.bin).join('|')
    if (cached && cached.sig === sig && now() - cached.at < ttlMs) return cached
    let hit = { version: '', bin: '', source: '' }
    for (const c of cands) {
      const r = await runImpl(c.bin, ['--version'], { timeout: 10000 })
      const version = !r.err && /^\d{4}\.\d/.test(r.stdout.trim()) ? r.stdout.trim().split(/\s/)[0] : ''
      if (version) { hit = { version, bin: c.bin, source: c.source || 'path' }; break }
    }
    cached = { ...hit, sig, at: now() }
    return cached
  }
  /** 返回版本号字符串；找不到返回 ''。 */
  async function detect() {
    return (await resolve()).version
  }
  /** 清除检测缓存（下载 / 更新 yt-dlp、改了路径设置后调用）。 */
  function reset() { cached = null }
  /** 读取元数据：yt-dlp -J --no-playlist */
  async function probe(url, { signal } = {}) {
    const use = (await resolve()).bin || bin
    const r = await runImpl(use, ['-J', '--no-playlist', url], { timeout: 120000, signal })
    if (r.err) return { ok: false, error: ytdlpReason(r.stderr || r.err?.message, 20 * 1024 * 1024) }
    try {
      const info = JSON.parse(r.stdout || '{}')
      return { ok: true, info }
    } catch {
      return { ok: false, error: 'yt-dlp 元数据不是有效 JSON。' }
    }
  }
  /** 下载到 dir，返回 { ok: true, path, bytes } 或 { ok: false, error }。 */
  async function download(url, dir, { maxBytes, maxHeight = 480, maxFilesizeM, signal } = {}) {
    const mb = maxFilesizeM != null ? maxFilesizeM : Math.max(1, Math.floor(maxBytes / 1024 / 1024))
    const h = Math.max(144, Math.min(2160, Math.floor(Number(maxHeight) || 480)))
    const args = ['--no-playlist', '--no-progress', '--no-part', '-S', `res:${h},+size`, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4']
    if (maxFilesizeM !== false && mb > 0) args.push('--max-filesize', `${mb}M`)
    args.push('-o', join(dir, '%(id)s.%(ext)s'), url)
    const use = (await resolve()).bin || bin
    const r = await runImpl(use, args, { timeout: 300000, signal })
    let files = []
    try { files = (await readdir(dir)).filter((f) => !/\.(part|ytdl|tmp)$/i.test(f)) } catch {}
    if (r.err && !files.length) return { ok: false, error: ytdlpReason(r.stderr || r.err?.message, maxBytes) }
    if (!files.length) return { ok: false, error: /max-filesize|larger/i.test(r.stdout + r.stderr) ? ytdlpReason('larger than max-filesize', maxBytes) : 'yt-dlp 没有下载到视频文件。' }
    const path = join(dir, files.find((f) => /\.mp4$/i.test(f)) || files[0])
    const st = await stat(path)
    if (maxBytes > 0 && st.size > maxBytes) return { ok: false, error: ytdlpReason('larger than max-filesize', maxBytes) }
    return { ok: true, path, bytes: st.size }
  }
  return { detect, resolve, reset, probe, download }
}