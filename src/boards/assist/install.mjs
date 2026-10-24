/**
 * 辅助引擎的按需下载、校验、解压、探测与移除。目录固定为 <数据目录>/boards/assist/<引擎>/。
 * 下载只在设置页点「下载辅助引擎」时发生；下载棋盘（本体）不会顺带下载引擎。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { download, downloadReason, extract, run, removeDir, withAbortSignal } from '../../tools.mjs'
import { boardsRoot, gameStatus } from '../download.mjs'
import { BoardError } from '../errors.mjs'
import { GAMES } from '../sources.mjs'
import { KatagoEngine, RapfiEngine, UciEngine } from './engines.mjs'
import { ASSIST_ENGINES, assetFor, platformKey, publicInfo } from './specs.mjs'

const IS_WIN = process.platform === 'win32'
const jobs = new Map()
const hooks = { beforeRemove: null }

export function assistRoot() {
  return join(boardsRoot(), 'assist')
}

export function engineDir(spec) {
  return join(assistRoot(), spec.id)
}

function markerFile(spec) {
  return join(assistRoot(), `${spec.id}.json`)
}

/** 已安装且与钉死版本一致时返回标记内容，否则 null。 */
export function readInstalled(game) {
  const spec = ASSIST_ENGINES[game]
  if (!spec) return null
  let data
  try { data = JSON.parse(readFileSync(markerFile(spec), 'utf8')) } catch { return null }
  if (!data || data.version !== spec.version || data.platform !== platformKey() || !data.bin) return null
  const dir = engineDir(spec)
  if (!existsSync(join(dir, data.bin))) return null
  for (const f of spec.files) if (!existsSync(join(dir, f))) return null
  if (spec.network && !existsSync(join(dir, spec.network.name))) return null
  return { ...data, dir }
}

/** 移除前回调（结束该棋种的引擎进程）。由 hints.mjs 注册，避免循环依赖。 */
export function setBeforeRemove(fn) {
  hooks.beforeRemove = fn
}

function gameReady(game) {
  return gameStatus().find((g) => g.id === game)?.ready === true
}

/** 设置页用：每个棋种的辅助引擎状态。 */
export function assistStatus() {
  const out = {}
  for (const game of Object.keys(GAMES)) {
    const spec = ASSIST_ENGINES[game]
    if (!spec) continue
    const installed = readInstalled(game)
    const job = jobs.get(game)
    out[game] = {
      ...publicInfo(spec),
      supported: assetFor(spec) != null,
      installed: Boolean(installed),
      ...(installed ? { binary: installed.bin.split('/').pop() } : {}),
      job: job ? { state: job.state, step: job.step, progress: job.progress, error: job.error || '' } : null,
    }
  }
  return out
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
  })
}

function onPath(name) {
  const exts = IS_WIN ? ['.exe', ''] : ['']
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try { if (statSync(p).isFile()) return p } catch { /* next */ }
    }
  }
  return null
}

/** 7z：Windows 用系统 bsdtar（libarchive 支持 7z）；其他平台依次找 bsdtar、7zz、7z、7za。 */
async function extract7z(archive, dest) {
  await mkdir(dest, { recursive: true })
  if (IS_WIN) {
    const tar = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(tar)) return run(tar, ['-xf', archive, '-C', dest])
  }
  const bsdtar = onPath('bsdtar')
  if (bsdtar) return run(bsdtar, ['-xf', archive, '-C', dest])
  for (const name of ['7zz', '7z', '7za']) {
    const bin = onPath(name)
    if (bin) return run(bin, ['x', '-y', `-o${dest}`, archive])
  }
  throw new BoardError('解压 7z 需要 bsdtar 或 7-Zip（7zz / 7z），本机未找到')
}

async function fetchVerified(url, sha, dest, onProgress, proxy) {
  try { await download(url, dest, { onProgress, timeoutMs: 120000, proxy }) }
  catch (e) {
    if (e?.name === 'AbortError' || /取消/.test(String(e?.message))) throw e
    throw new BoardError(`下载 ${url.split('/').pop()} 失败：${downloadReason(e, 'github.com')}`)
  }
  const got = await sha256(dest)
  if (got !== sha) {
    await rm(dest, { force: true })
    throw new BoardError(`校验失败：${url.split('/').pop()} 的 sha256 与钉死值不一致`)
  }
}

/** 构造引擎实例（不启动）。spawnImpl 测试用。 */
export function createEngine(game, installed, { spawnImpl } = {}) {
  const spec = ASSIST_ENGINES[game]
  const dir = installed.dir
  const command = join(dir, installed.bin)
  if (spec.id === 'pikafish') {
    return new UciEngine({ command, cwd: dir, spawnImpl, options: { EvalFile: join(dir, 'pikafish.nnue') } })
  }
  if (spec.id === 'stockfish') return new UciEngine({ command, cwd: dir, spawnImpl })
  if (spec.id === 'rapfi') {
    return new RapfiEngine({ command, cwd: dir, spawnImpl, args: ['--config', join(dir, 'dsh-config.toml')], size: 15, rule: 0 })
  }
  return new KatagoEngine({
    command,
    cwd: dir,
    spawnImpl,
    args: ['analysis', '-config', join(dir, 'dsh-analysis.cfg'), '-model', join(dir, spec.network.name)],
  })
}

/** 由官方配置派生本插件用的配置（只改几个键），写在引擎目录里。 */
function writeDerivedConfig(spec, dir) {
  if (spec.id === 'rapfi') {
    const text = readFileSync(join(dir, 'config.toml'), 'utf8')
    writeFileSync(join(dir, 'dsh-config.toml'), text.replace(/^(\s*message_mode\s*=\s*)"[^"]*"/m, '$1"ucilike"'), 'utf8')
  }
  if (spec.id === 'katago') {
    const set = {
      logDir: 'logs',
      logToStderr: 'false',
      reportAnalysisWinratesAs: 'SIDETOMOVE',
      numAnalysisThreads: '1',
      numSearchThreadsPerAnalysisThread: '4',
      nnMaxBatchSize: '8',
      nnCacheSizePowerOfTwo: '18',
      nnMutexPoolSizePowerOfTwo: '14',
    }
    const lines = readFileSync(join(dir, 'analysis_example.cfg'), 'utf8').split(/\r?\n/)
      .filter((l) => { const k = /^\s*([A-Za-z0-9_]+)\s*=/.exec(l)?.[1]; return !k || !(k in set) })
    for (const [k, v] of Object.entries(set)) lines.push(`${k} = ${v}`)
    writeFileSync(join(dir, 'dsh-analysis.cfg'), lines.join('\n') + '\n', 'utf8')
  }
}

/** 依次试候选程序：能完成握手并给出一次分析的第一个即选用。 */
async function probe(game, dir, bins, spawnImpl) {
  for (const bin of bins) {
    const full = join(dir, bin)
    if (!existsSync(full)) continue
    if (!IS_WIN) { try { chmodSync(full, 0o755) } catch { /* ignore */ } }
    const engine = createEngine(game, { dir, bin }, { spawnImpl })
    try {
      const res = await engine.analyze(probePosition(game), 200)
      if (Array.isArray(res) && res.length) return bin
    } finally { await engine.dispose() }
  }
  return null
}

function probePosition(game) {
  if (game === 'xiangqi') return 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
  if (game === 'chess') return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  if (game === 'gomoku') return { stones: [{ x: 7, y: 7 }] }
  return { moves: [], rules: 'chinese', komi: 7.5, boardXSize: 9, boardYSize: 9 }
}

/** Windows 上刚退出的程序或杀毒扫描会让目录短暂被占用：重试几次，最后退回复制。 */
async function moveDir(from, to) {
  for (let i = 0; i < 8; i++) {
    try { await rename(from, to); return } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(error.code)) throw error
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  await cp(from, to, { recursive: true })
  await removeDir(from)
}

function setJob(game, patch) {
  const job = { ...(jobs.get(game) || {}), ...patch }
  jobs.set(game, job)
  return job
}

function progressFor(game, label, base, span) {
  let last = -1
  return (received, total) => {
    const pct = total ? Math.floor(base + (received / total) * span) : null
    if (pct === last) return
    last = pct
    const mb = (received / 1048576).toFixed(1)
    setJob(game, { step: `正在下载 ${label}：${mb}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, progress: pct })
  }
}

/** 开始下载（后台任务）；返回当前状态。本体未下载时拒绝。 */
export function startAssistDownload(game, options = {}) {
  const spec = ASSIST_ENGINES[game]
  if (!spec) throw new BoardError('这个棋种没有辅助引擎')
  if (!options.skipGameCheck && !gameReady(game)) throw new BoardError(`请先下载${GAMES[game].label}棋盘，再下载辅助引擎`, 409)
  if (!assetFor(spec)) throw new BoardError(`${spec.name} 没有适用于 ${platformKey()} 的官方构建`)
  const running = jobs.get(game)
  if (running?.state === 'running') return running.promise
  const controller = new AbortController()
  const promise = withAbortSignal(controller.signal, () => installAssist(game, options))
    .then((info) => { setJob(game, { state: 'done', step: '已安装', progress: 100, error: '' }); return info })
    .catch((error) => { setJob(game, { state: 'error', step: '', progress: null, error: error?.message || '下载失败' }); throw error })
  setJob(game, { state: 'running', step: '准备下载', progress: 0, error: '', promise, controller })
  promise.catch(() => {})
  return promise
}

export function cancelAssistDownload(game) {
  jobs.get(game)?.controller?.abort()
}

export async function installAssist(game, { spawnImpl, proxy } = {}) {
  const spec = ASSIST_ENGINES[game]
  const key = platformKey()
  const asset = assetFor(spec)
  const root = assistRoot()
  await mkdir(join(root, 'downloads'), { recursive: true })
  const stage = join(root, `${spec.id}.tmp-${randomBytes(3).toString('hex')}`)
  const finalDir = engineDir(spec)
  const archives = []
  try {
    const hasNet = Boolean(spec.network)
    const span = hasNet ? 45 : 90
    const fetchAsset = async (a, label) => {
      const file = join(root, 'downloads', a.url.split('/').pop())
      archives.push(file)
      await fetchVerified(a.url, a.sha256, file, progressFor(game, label, 0, span), proxy)
      setJob(game, { step: `正在解压 ${label}`, progress: span })
      if (a.kind === '7z') await extract7z(file, stage)
      else await extract(file, stage)
    }
    await fetchAsset(asset, spec.name)
    if (hasNet) {
      const net = spec.network
      await fetchVerified(net.url, net.sha256, join(stage, net.name), progressFor(game, '网络权重', 45, 45), proxy)
    }
    for (const f of spec.files) {
      if (!existsSync(join(stage, f))) throw new BoardError(`${spec.name} 发布包里缺少 ${f}`)
    }
    writeDerivedConfig(spec, stage)
    setJob(game, { step: '正在检测 CPU 兼容的构建', progress: 92 })
    let bin = await probe(game, stage, spec.bins[key], spawnImpl)
    if (!bin && asset.fallback) {
      await rm(join(stage, spec.bins[key][0]), { force: true })
      await fetchAsset(asset.fallback, `${spec.name}（通用 CPU 版）`)
      writeDerivedConfig(spec, stage)
      bin = await probe(game, stage, spec.bins[key], spawnImpl)
    }
    if (!bin) throw new BoardError(`${spec.name} 在本机无法启动（CPU 或系统不兼容）`)
    // 发布包里其他平台 / 其他指令集的程序用不上，删掉省空间
    if (spec.binPrefix) {
      for (const name of readdirSync(stage)) {
        if (name.startsWith(spec.binPrefix) && name !== bin) await rm(join(stage, name), { force: true })
      }
    }
    await hooks.beforeRemove?.(game)
    await removeDir(finalDir)
    await moveDir(stage, finalDir)
    const info = { version: spec.version, platform: key, bin, url: asset.url, installedAt: new Date().toISOString() }
    await writeFile(markerFile(spec), JSON.stringify(info, null, 2) + '\n', 'utf8')
    return info
  } finally {
    await removeDir(stage).catch(() => {})
    for (const a of archives) await rm(a, { force: true }).catch(() => {})
  }
}

export async function removeAssist(game) {
  const spec = ASSIST_ENGINES[game]
  if (!spec) throw new BoardError('这个棋种没有辅助引擎')
  if (jobs.get(game)?.state === 'running') throw new BoardError('正在下载，请稍后再移除', 409)
  await hooks.beforeRemove?.(game)
  await rm(markerFile(spec), { force: true })
  await removeDir(engineDir(spec))
  jobs.delete(game)
  return true
}

// 便于测试
export const _internal = { probePosition, writeDerivedConfig, onPath }
