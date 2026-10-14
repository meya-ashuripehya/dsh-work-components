/**
 * llm-gateway-bench（MIT）的按需下载：只在设置页「网关核验」点「下载安装」时发生，不随本插件分发、不进仓库。
 * 来源：GitHub 仓库 tarball，钉死到 BENCH_COMMIT；解压到 <数据目录>/tools/llm-gateway-bench/，旁边写 .dsh-install.json 标记。
 * 进度与日志记在内存任务上，由 GET /dsh-workbench/api/trust/bench 读取（与棋类辅助引擎的下载任务同一套写法）。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, download, extract, removeDir, withAbortSignal } from '../tools.mjs'
import { metricsFile, REQUIRED_EXPORTS } from './bench.mjs'

export const BENCH_REPO = 'https://github.com/cuihuan/llm-gateway-bench'
export const BENCH_COMMIT = '77b8474102032ab64da601d83d3bfc659f71305f'
export const BENCH_LICENSE = 'MIT'
/** 相对数据目录的默认安装位置。 */
export const BENCH_REL_DIR = join('tools', 'llm-gateway-bench')
const MARKER = '.dsh-install.json'
const LOG_KEEP = 200

export function benchTarballUrl(commit = BENCH_COMMIT) {
  return `https://codeload.github.com/cuihuan/llm-gateway-bench/tar.gz/${commit}`
}

export function managedBenchDir(base = dataDir()) {
  return join(base, BENCH_REL_DIR)
}

export function readBenchMarker(dir = managedBenchDir()) {
  try { return JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) } catch { return null }
}

let job = null

function pushLog(line) {
  if (!job) return
  job.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`)
  if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP)
}
function setStep(step, progress) {
  if (!job) return
  job.step = step
  if (progress !== undefined) job.progress = progress
}

/** 设置页用：托管目录的安装状态与当前下载任务。 */
export function benchInstallStatus(base = dataDir()) {
  const dir = managedBenchDir(base)
  const marker = readBenchMarker(dir)
  const installed = !!metricsFile(dir)
  return {
    repo: BENCH_REPO,
    license: BENCH_LICENSE,
    commit: BENCH_COMMIT,
    relDir: BENCH_REL_DIR.replace(/\\/g, '/'),
    dir,
    installed,
    installedCommit: installed ? (marker?.commit || null) : null,
    outdated: installed && !!marker?.commit && marker.commit !== BENCH_COMMIT,
    installedAt: installed ? (marker?.installedAt || null) : null,
    job: job ? { state: job.state, step: job.step, progress: job.progress, error: job.error || '', log: job.log.slice(-80) } : null,
  }
}

function findMetricsRoot(stage) {
  if (metricsFile(stage)) return stage
  for (const name of readdirSync(stage)) {
    const p = join(stage, name)
    try { if (statSync(p).isDirectory() && metricsFile(p)) return p } catch { /* next */ }
  }
  return null
}

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

/**
 * 下载并安装（后台任务）；已有任务在跑时返回同一个 promise。
 * @param {{ base?: string, proxy?: string, downloadImpl?: Function, extractImpl?: Function, importImpl?: Function }} [options]
 */
export function startBenchInstall(options = {}) {
  if (job?.state === 'running') return job.promise
  const controller = new AbortController()
  job = { state: 'running', step: '准备下载', progress: 0, error: '', log: [], controller, promise: null }
  const promise = withAbortSignal(controller.signal, () => installBench(options))
    .then((info) => { setStep('已安装', 100); job.state = 'done'; pushLog('安装完成'); return info })
    .catch((error) => {
      const msg = String(error?.message || error || '下载失败')
      job.state = 'error'; job.error = msg; job.step = '安装失败'; job.progress = null
      pushLog('错误：' + msg)
      throw error
    })
  job.promise = promise
  promise.catch(() => {})
  return promise
}

export function cancelBenchInstall() { job?.controller?.abort() }

export async function installBench({ base = dataDir(), proxy, downloadImpl = download, extractImpl = extract, importImpl = (u) => import(u) } = {}) {
  const finalDir = managedBenchDir(base)
  const toolsDir = join(finalDir, '..')
  await mkdir(join(toolsDir, 'downloads'), { recursive: true })
  const archive = join(toolsDir, 'downloads', `llm-gateway-bench-${BENCH_COMMIT.slice(0, 12)}.tar.gz`)
  const stage = join(toolsDir, `llm-gateway-bench.tmp-${randomBytes(3).toString('hex')}`)
  const url = benchTarballUrl()
  try {
    pushLog(`下载 ${url}`)
    let last = -1
    await downloadImpl(url, archive, {
      proxy,
      timeoutMs: 120000,
      log: pushLog,
      onProgress(received, total) {
        const pct = total ? Math.floor((received / total) * 80) : null
        if (pct === last && pct !== null) return
        last = pct
        const mb = (received / 1048576).toFixed(1)
        setStep(`正在下载：${mb}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, pct)
      },
    })
    setStep('正在解压', 85)
    pushLog('解压到临时目录')
    await extractImpl(archive, stage)
    const root = findMetricsRoot(stage)
    if (!root) throw new Error('下载内容中缺少 probe/metrics.mjs，无法用作网关核验规则')
    setStep('正在校验', 92)
    const { pathToFileURL } = await import('node:url')
    const file = metricsFile(root)
    const mod = await importImpl(pathToFileURL(file).href + '?install=' + Date.now())
    const missing = REQUIRED_EXPORTS.filter((n) => typeof mod?.[n] !== 'function')
    if (missing.length) throw new Error(`llm-gateway-bench 缺少导出：${missing.join('、')}`)
    if (!existsSync(join(root, 'LICENSE')) && !existsSync(join(root, 'LICENSE.md'))) pushLog('提示：下载内容中未找到 LICENSE 文件（上游声明为 MIT）')
    await removeDir(finalDir)
    await moveDir(root, finalDir)
    const info = { repo: BENCH_REPO, commit: BENCH_COMMIT, license: BENCH_LICENSE, url, installedAt: new Date().toISOString() }
    await writeFile(join(finalDir, MARKER), JSON.stringify(info, null, 2) + '\n', 'utf8')
    pushLog(`已安装到 ${finalDir}`)
    return info
  } finally {
    await removeDir(stage).catch(() => {})
    await rm(archive, { force: true }).catch(() => {})
  }
}

export async function removeBench(base = dataDir()) {
  if (job?.state === 'running') throw new Error('正在下载，请稍后再移除')
  await removeDir(managedBenchDir(base))
  job = null
  return true
}

/** 测试用：清掉内存任务。 */
export function _resetBenchJob() { job = null }