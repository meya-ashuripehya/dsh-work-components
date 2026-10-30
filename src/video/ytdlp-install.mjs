/**
 * yt-dlp 按需下载（与棋类辅助引擎同一思路：不随插件分发，只在设置页点「下载 yt-dlp」时从官方仓库取）。
 *   - 来源：GitHub yt-dlp/yt-dlp 最新正式版，按平台选官方单文件程序。版本号先问 GitHub API（releases/latest）；
 *     API 失败（常见：未登录请求每小时 60 次的上限在共用代理出口上用完 → 403）时，改读 github.com/…/releases/latest
 *     的跳转目标（…/releases/tag/<版本>）。程序与校验文件都从 github.com/…/releases/download/<版本>/ 下载，不经 API；
 *   - 代理：与其他下载相同（设置「下载代理」，留空时用环境变量 HTTPS_PROXY / HTTP_PROXY）；
 *   - 校验：同一版本的 SHA2-256SUMS，sha256 不一致即删除并报错；
 *   - 位置：<数据目录>/bin/yt-dlp(.exe)，标记文件 <数据目录>/bin/yt-dlp.json（版本、sha256、来源、时间）；
 *   - 先写临时文件，校验通过后再替换，旧版本在失败时保留。
 * 只能由设置页（本机桌面端 = 所有者）触发；没有注册为 AI 工具。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, download as httpDownload, resolveRedirect, downloadReason as reasonOf } from '../tools.mjs'

export { reasonOf }

export const YTDLP_REPO = 'yt-dlp/yt-dlp'
export const YTDLP_LATEST_API = `https://api.github.com/repos/${YTDLP_REPO}/releases/latest`
export const YTDLP_LATEST_PAGE = `https://github.com/${YTDLP_REPO}/releases/latest`
const RELEASE_BASE = `https://github.com/${YTDLP_REPO}/releases/download`
const API_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }

const ASSETS = {
  'win32-x64': 'yt-dlp.exe',
  'win32-ia32': 'yt-dlp_x86.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
}

/** 平台 → 官方资产名；不支持时 null。 */
export function ytdlpAsset(platform = process.platform, arch = process.arch) {
  return ASSETS[`${platform}-${arch}`] || null
}

export function ytdlpBinDir(root) {
  return join(root || dataDir(), 'bin')
}
export function ytdlpBinPath(root, platform = process.platform) {
  return join(ytdlpBinDir(root), platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
}
const markerPath = (root) => join(ytdlpBinDir(root), 'yt-dlp.json')

/** 已下载的副本：{ version, sha256, url, installedAt, path } 或 null（程序缺失也算未安装）。 */
export function readYtdlpInstalled(root, platform = process.platform) {
  let m
  try { m = JSON.parse(readFileSync(markerPath(root), 'utf8')) } catch { return null }
  const path = ytdlpBinPath(root, platform)
  if (!m || !m.version || !existsSync(path)) return null
  return { version: String(m.version), sha256: m.sha256 || '', url: m.url || '', installedAt: m.installedAt || '', path }
}

/** SHA2-256SUMS 文本 → 资产名的 sha256（小写 hex）；没有时 null。 */
export function parseSums(text, asset) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m && m[2].trim() === asset) return m[1].toLowerCase()
  }
  return null
}

function sha256File(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
  })
}

const TAG_RE = /^[0-9A-Za-z._-]{1,40}$/

/** 跳转目标 …/releases/tag/<版本> → 版本号；不符合时 null。 */
export function tagFromLocation(loc) {
  const m = String(loc || '').match(/\/releases\/tag\/([^/?#]+)\/?(?:[?#].*)?$/)
  if (!m) return null
  let tag
  try { tag = decodeURIComponent(m[1]) } catch { return null }
  return TAG_RE.test(tag) ? tag : null
}

/**
 * 下载器（后台任务 + 进度）。deps 可注入：download(url, dest, { onProgress }) / root / platform / arch / onInstalled（清除检测缓存）。
 */
export function createYtdlpInstaller({ download = httpDownload, redirect = resolveRedirect, proxy, root, platform = process.platform, arch = process.arch, onInstalled } = {}) {
  let job = null
  const rootDir = () => (typeof root === 'function' ? root() : root) || dataDir()
  const proxyNow = () => String((typeof proxy === 'function' ? proxy() : proxy) || '').trim() || undefined

  /** 最新版本号：先 API，失败再看 github.com 的跳转。两者都失败时给出两边的原因。 */
  async function latestTag(meta, px) {
    let apiErr = null
    try {
      await download(YTDLP_LATEST_API, meta, { timeoutMs: 30000, retries: 1, proxy: px, headers: API_HEADERS })
      let rel = null
      try { rel = JSON.parse(await readFile(meta, 'utf8')) } catch { rel = null }
      const tag = String(rel?.tag_name || '')
      if (TAG_RE.test(tag)) return { tag, via: 'api' }
      apiErr = new Error('GitHub API 返回的版本信息无效')
    } catch (e) { apiErr = e }
    set({ step: '正在改用 github.com 发布页查询最新版本', progress: 3 })
    try {
      const loc = await redirect(YTDLP_LATEST_PAGE, { proxy: px, timeoutMs: 20000 })
      const tag = tagFromLocation(loc)
      if (tag) return { tag, via: 'redirect' }
      throw new Error('github.com 发布页跳转目标中没有有效的版本号')
    } catch (e) {
      throw new Error(`无法获取 yt-dlp 最新版本：${reasonOf(apiErr, 'GitHub API')}；改用 github.com 发布页也失败：${reasonOf(e, 'github.com')}。请检查网络或「下载代理」设置后重试。`)
    }
  }
  const set = (patch) => { job = { ...(job || {}), ...patch } }

  async function install() {
    const asset = ytdlpAsset(platform, arch)
    if (!asset) throw new Error(`yt-dlp 没有适用于 ${platform}-${arch} 的官方程序`)
    const dir = ytdlpBinDir(rootDir())
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.yt-dlp-${randomBytes(4).toString('hex')}`)
    const meta = tmp + '.release.json'
    const sums = tmp + '.sums'
    try {
      const px = proxyNow()
      set({ step: '正在查询最新版本', progress: 2 })
      const { tag, via } = await latestTag(meta, px)
      set({ step: `正在下载校验文件（${tag}）`, progress: 5, version: tag, via })
      try { await download(`${RELEASE_BASE}/${tag}/SHA2-256SUMS`, sums, { timeoutMs: 30000, proxy: px }) }
      catch (e) { throw new Error(`下载校验文件 SHA2-256SUMS（${tag}）失败：${reasonOf(e, 'github.com')}`) }
      const want = parseSums(await readFile(sums, 'utf8'), asset)
      if (!want) throw new Error(`SHA2-256SUMS 中没有 ${asset}`)
      const url = `${RELEASE_BASE}/${tag}/${asset}`
      let last = -1
      await download(url, tmp, {
        timeoutMs: 120000,
        proxy: px,
        onProgress: (received, total) => {
          const pct = total ? Math.floor(8 + (received / total) * 88) : null
          if (pct === last) return
          last = pct
          set({ step: `正在下载 ${asset}：${(received / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, progress: pct })
        },
      }).catch((e) => { throw new Error(`下载 ${asset}（${tag}）失败：${reasonOf(e, 'github.com')}`) })
      set({ step: '正在校验 sha256', progress: 97 })
      const got = await sha256File(tmp)
      if (got !== want) throw new Error(`校验失败：${asset} 的 sha256 与官方 SHA2-256SUMS 不一致，已删除`)
      if (platform !== 'win32') { try { chmodSync(tmp, 0o755) } catch {} }
      const dest = ytdlpBinPath(rootDir(), platform)
      await rm(dest, { force: true })
      await rename(tmp, dest)
      const info = { version: tag, sha256: got, url, asset, via, installedAt: new Date().toISOString() }
      await writeFile(markerPath(rootDir()), JSON.stringify(info, null, 2) + '\n', 'utf8')
      try { onInstalled?.(info) } catch {}
      return { ...info, path: dest }
    } finally {
      for (const f of [tmp, tmp + '.part', meta, meta + '.part', sums, sums + '.part']) await rm(f, { force: true }).catch(() => {})
    }
  }

  return {
    /** 开始下载（已在下载时返回同一个任务）。 */
    start() {
      if (job?.state === 'running') return job.promise
      const promise = install()
        .then((info) => { set({ state: 'done', step: `已安装 ${info.version}`, progress: 100, error: '', promise: null }); return info })
        .catch((e) => { set({ state: 'error', step: '', progress: null, error: e?.message || '下载失败', promise: null }); throw e })
      job = { state: 'running', step: '准备下载', progress: 0, error: '', version: '', promise }
      promise.catch(() => {})
      return promise
    },
    /** 任务状态（不含 promise）。 */
    job() {
      if (!job) return null
      const { promise, ...rest } = job
      return rest
    },
    installed: () => readYtdlpInstalled(rootDir(), platform),
    binPath: () => ytdlpBinPath(rootDir(), platform),
  }
}