/**
 * 插件自管的工具目录 <数据目录>/tools：下载、安装、定位。
 *
 *   tools/uv/uv(.exe)、uvx(.exe)   官方 GitHub release 里的 uv
 *   tools/python/                  uv 管理的 Python（UV_PYTHON_INSTALL_DIR）
 *   tools/.uv-cache/               uv 缓存（UV_CACHE_DIR），装完会 prune
 *   tools/officemcp/               OfficeMCP 源码（GitHub zip）+ .venv（uv sync，另装 pillow）
 *   tools/blender/.venv/           mcp-for-blender 独立 venv
 *   tools/unity/.venv/             mcpforunityserver 独立 venv
 *   tools/godot/.venv/             godot-ai 独立 venv（另装 cryptography，用它自带的 release_verify 校验插件签名）
 *   tools/godot/addon/             与 godot-ai 同版本的 Godot 插件包（GitHub Release 的 zip + 签名清单 + 签名）
 *   tools/node/                    Node.js（官方 zip；只在系统里找不到带 npm 的 Node.js 时才下载）
 *   tools/chrome|figma|photoshop/  npm 组件（npm install 到各自目录的 node_modules）
 *   tools/.npm-cache/              npm 缓存（装完即删）
 *   tools/.downloads/              下载中转
 *
 * 可写状态一律放在包目录之外的数据目录 dataDir()（默认 $DSH_HOME/data/dsh-work-components，
 * DSH_HOME 缺省为 ~/.dsh），这样以 npm 包安装时升级 / 重装不会丢，也不往 node_modules 里写。
 * 包目录里的 tools/、local-components/ 不再沿用（避免把 uv / Node.js / Python 和组件安装写进仓库）。
 * 设置文件和 GameBot 数据仍一次性从包目录搬进数据目录。
 * 下载只用 Node 自带的 http/https（支持 HTTP 代理 CONNECT），解压用系统 tar（Windows 10+ 自带 bsdtar）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''
export const PYTHON_VERSION = '3.12'
/** 系统里没有带 npm 的 Node.js 时下载的 LTS 大版本。 */
export const NODE_MAJOR = 22
export const MARKER = '.dsh-install.json'
/** npm 包名；数据目录以它命名。 */
export const PACKAGE_ID = 'dsh-work-components'

export function pluginRoot() {
  // 构建后本文件被打进 lib/index.mjs；profile 里是 junction，realpath 后才是真实仓库目录。
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try { return realpathSync(dir) } catch { return dir }
}

/** DSH 主目录：环境变量 DSH_HOME，缺省 ~/.dsh。 */
export function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/**
 * 插件的可写数据目录（包目录之外）。默认 $DSH_HOME/data/dsh-work-components；
 * 可用 DSH_WORKBENCH_DATA_DIR 覆盖（测试 / 便携安装）。
 */
export function dataDir() {
  return process.env.DSH_WORKBENCH_DATA_DIR ? resolve(process.env.DSH_WORKBENCH_DATA_DIR) : join(dshHome(), 'data', PACKAGE_ID)
}

const LEGACY_FILE = 'legacy-locations.json'
const MIGRATION_FILE = 'migration.json'

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {} } catch { return {} }
}
function writeMigration(done) {
  try { writeFileSync(join(dataDir(), MIGRATION_FILE), JSON.stringify(done, null, 2) + '\n', 'utf8') } catch {}
}
function nonEmptyDir(p) {
  try { return statSync(p).isDirectory() && readdirSync(p).length > 0 } catch { return false }
}

let _legacy = null
/** 路径是否落在包目录里（profile 的 junction 经 pluginRoot() 的 realpath 归一）。 */
function insidePluginRoot(p) {
  if (typeof p !== 'string' || !p) return false
  let root, abs
  try { root = resolve(pluginRoot()); abs = resolve(p) } catch { return false }
  if (process.platform === 'win32') {
    const r = root.toLowerCase()
    const a = abs.toLowerCase()
    return a === r || a.startsWith(r + '\\') || a.startsWith(r + '/')
  }
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 数据目录之外的显式旧路径（<数据目录>/legacy-locations.json）。
 * 包目录里的 tools/、local-components/ 不沿用：uv / Node.js / Python 和组件安装只进数据目录。
 * 记录若指向包目录，读到时丢掉并写回。
 */
function legacyLocations() {
  if (_legacy) return _legacy
  const dir = dataDir()
  const legacy = readJson(join(dir, LEGACY_FILE))
  let dropped = false
  for (const key of ['tools', 'localComponents']) {
    if (insidePluginRoot(legacy[key])) { delete legacy[key]; dropped = true }
  }
  if (dropped) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, LEGACY_FILE), JSON.stringify(legacy, null, 2) + '\n', 'utf8')
    } catch { /* 下次启动再写 */ }
  }
  _legacy = legacy
  return _legacy
}
function adopted(name) {
  const p = legacyLocations()[name]
  return typeof p === 'string' && p && existsSync(p) ? p : null
}

/** 工具根目录：DSH_WORKBENCH_TOOLS_DIR → 沿用的旧目录 → <数据目录>/tools。 */
export function toolsDir() {
  if (process.env.DSH_WORKBENCH_TOOLS_DIR) return resolve(process.env.DSH_WORKBENCH_TOOLS_DIR)
  return adopted('tools') || join(dataDir(), 'tools')
}

/**
 * 用户本地兼容组件源码目录（ComponentModule，非 tools/ 安装产物）。
 * DSH_WORKBENCH_LOCAL_COMPONENTS_DIR → 沿用的旧目录 → <数据目录>/local-components。
 */
export function localComponentsDir() {
  if (process.env.DSH_WORKBENCH_LOCAL_COMPONENTS_DIR) return resolve(process.env.DSH_WORKBENCH_LOCAL_COMPONENTS_DIR)
  return adopted('localComponents') || join(dataDir(), 'local-components')
}

/** 设置文件（没有 ctx.settings 服务时用）：DSH_WORKBENCH_SETTINGS_FILE → <数据目录>/settings.json。 */
export function settingsFilePath() {
  if (process.env.DSH_WORKBENCH_SETTINGS_FILE) return resolve(process.env.DSH_WORKBENCH_SETTINGS_FILE)
  return join(dataDir(), 'settings.json')
}

/** 旧版本放在包目录里的设置文件名。 */
export const LEGACY_SETTINGS_FILE = '.dsh-workbench-settings.json'

/**
 * 一次性把旧版本写在包目录里的状态迁到数据目录（每项只做一次，记录在 <数据目录>/migration.json）。
 *  - tools/、local-components/：不从包目录沿用，一律用数据目录（见 legacyLocations）。
 *  - .dsh-workbench-settings.json → <数据目录>/settings.json（复制并校验后删除旧文件，里面可能有令牌）。
 *    设了 DSH_WORKBENCH_SETTINGS_FILE 时跳过（冒烟 / 测试用的临时文件）。
 *  - src/components/gamebot/data/ → <数据目录>/gamebot/data/（同上：复制后删除旧目录）。
 *  目标已存在时不覆盖、也不删旧的，只记日志，留给用户自己取舍。
 * 返回本次做了的项目名（不含任何值）。
 */
export function migrateLegacyState(log) {
  const dir = dataDir()
  const root = pluginRoot()
  try { mkdirSync(dir, { recursive: true }) } catch (error) { log?.(`无法创建数据目录 ${dir}：${error.message}`); return [] }
  const hadAdopt = !!readJson(join(dir, MIGRATION_FILE)).adopt
  legacyLocations()
  const done = readJson(join(dir, MIGRATION_FILE))
  const did = !hadAdopt && done.adopt && Object.keys(legacyLocations()).length ? ['adopt'] : []
  let changed = did.length > 0
  const mark = (k, moved) => { done[k] = new Date().toISOString(); changed = true; if (moved) did.push(k) }

  if (!done.settings && !process.env.DSH_WORKBENCH_SETTINGS_FILE) {
    const oldFile = join(root, LEGACY_SETTINGS_FILE)
    const next = join(dir, 'settings.json')
    try {
      let moved = false
      if (existsSync(oldFile)) {
        if (existsSync(next)) {
          log?.(`数据目录已有 settings.json，未覆盖；旧文件 ${oldFile} 保留，确认后可手动删除`)
        } else {
          copyFileSync(oldFile, next)
          JSON.parse(readFileSync(next, 'utf8')) // 校验副本完整
          rmSync(oldFile, { force: true })
          moved = true
        }
      }
      mark('settings', moved)
    } catch (error) { log?.(`迁移设置文件失败（下次启动重试）：${error.message}`) }
  }

  if (!done.gamebotData) {
    const oldData = join(root, 'src', 'components', 'gamebot', 'data')
    const next = join(dir, 'gamebot', 'data')
    try {
      let moved = false
      if (existsSync(oldData)) {
        if (existsSync(next)) {
          log?.(`数据目录已有 gamebot/data，未覆盖；旧目录 ${oldData} 保留，确认后可手动删除`)
        } else {
          cpSync(oldData, next, { recursive: true, errorOnExist: false })
          rmSync(oldData, { recursive: true, force: true })
          moved = true
        }
      }
      mark('gamebotData', moved)
    } catch (error) { log?.(`迁移 GameBot 数据失败（下次启动重试）：${error.message}`) }
  }

  if (changed) writeMigration(done)
  return did
}

export function venvBin(venv, name) {
  return IS_WIN ? join(venv, 'Scripts', name + EXE) : join(venv, 'bin', name)
}

/** 各工具在 tools/ 里的位置。 */
export function managedPaths() {
  const root = toolsDir()
  return {
    root,
    uv: join(root, 'uv', 'uv' + EXE),
    uvx: join(root, 'uv', 'uvx' + EXE),
    python: join(root, 'python'),
    cache: join(root, '.uv-cache'),
    downloads: join(root, '.downloads'),
    officeRepo: join(root, 'officemcp'),
    officePython: venvBin(join(root, 'officemcp', '.venv'), 'python'),
    node: join(root, 'node'),
    nodeExe: IS_WIN ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node'),
    npmCache: join(root, '.npm-cache'),
    venv: (id) => join(root, id, '.venv'),
    dir: (id) => join(root, id),
  }
}

export function readMarker(dir) {
  try { return JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) } catch { return null }
}

/** 在 PATH 里找可执行文件，找不到返回 null。 */
export function which(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of IS_WIN && !/\.[a-z]+$/i.test(name) ? exts : ['']) {
      const p = join(dir, name + ext)
      try { if (statSync(p).isFile()) return p } catch {}
    }
  }
  return null
}

/** pip 包说明（可能带版本约束）里的包名；uvx 语义下它也是入口命令名。 */
export function packageName(spec) {
  return String(spec || '').trim().split(/[\s=<>!~;@[]/)[0]
}

/** npm 包说明（可带版本 / tag，可带 @scope）里的包名。 */
export function npmPackageName(spec) {
  const s = String(spec || '').trim()
  if (s.startsWith('@')) {
    const m = /^(@[^/\s@]+\/[^\s@]+)/.exec(s)
    return m ? m[1] : s
  }
  return s.split(/[\s@]/)[0]
}

// ─────────────────────────── Node.js ───────────────────────────

const versionCache = new Map()

/** `<exe> -v` 的输出（如 v24.18.0），失败返回 null；按路径缓存。 */
export function nodeVersion(exe) {
  if (!exe) return null
  if (versionCache.has(exe)) return versionCache.get(exe)
  let v = null
  try {
    const out = execFileSync(exe, ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (/^v\d+\.\d+/.test(out)) v = out
  } catch {}
  versionCache.set(exe, v)
  return v
}

/** chrome-devtools-mcp 的要求（^20.19 || ^22.12 || >=23），figma-console-mcp / photoshop-mcp 要求更低。 */
export function nodeSatisfies(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''))
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)
}

function nearNode(exe, file) {
  if (!exe) return null
  const dir = dirname(exe)
  for (const p of [join(dir, 'node_modules', 'npm', 'bin', file), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', file)]) {
    if (existsSync(p)) return p
  }
  return null
}
/** node 可执行文件旁边的 npm-cli.js（官方安装包 / zip 的布局），没有返回 null。 */
export const npmCliNear = (exe) => nearNode(exe, 'npm-cli.js')
export const npxCliNear = (exe) => nearNode(exe, 'npx-cli.js')

/** Node.js 官方发行包的平台名。 */
export function nodeDist(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch]
  if (!cpu) return null
  if (platform === 'win32') return { suffix: `win-${cpu}.zip` }
  if (platform === 'darwin') return { suffix: `darwin-${cpu}.tar.gz` }
  if (platform === 'linux') return { suffix: `linux-${cpu}.tar.gz` }
  return null
}

/** uv 官方 release 资源名。 */
export function uvAsset(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' }[arch]
  if (!cpu) return null
  if (platform === 'win32') return `uv-${cpu}-pc-windows-msvc.zip`
  if (platform === 'darwin' && cpu !== 'i686') return `uv-${cpu}-apple-darwin.tar.gz`
  if (platform === 'linux') return `uv-${cpu}-unknown-linux-gnu.tar.gz`
  return null
}

// ─────────────────────────── 下载 ───────────────────────────

function proxyFor(url, proxy) {
  if (proxy) return proxy
  const e = process.env
  const p = url.protocol === 'https:'
    ? (e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy)
    : (e.HTTP_PROXY || e.http_proxy)
  if (!p) return null
  const noProxy = (e.NO_PROXY || e.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (noProxy.some((h) => h === '*' || url.hostname === h || url.hostname.endsWith(h.startsWith('.') ? h : '.' + h))) return null
  return p
}

function tunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const p = new URL(proxyUrl)
    if (!/^https?:$/.test(p.protocol)) return reject(new Error(`只支持 HTTP 代理：${proxyUrl}`))
    const headers = { host: `${host}:${port}` }
    if (p.username) headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接代理超时：${proxyUrl}`)))
    req.on('connect', (res, socket) => {
      req.setTimeout(0)
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理拒绝连接 ${host}:${port}（HTTP ${res.statusCode}）`)); return }
      resolvePromise(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

async function request(url, proxy, timeoutMs) {
  const u = new URL(url)
  const p = proxyFor(u, proxy)
  const headers = { 'user-agent': 'dsh-workbench', accept: '*/*' }
  let opts = { method: 'GET', headers, agent: false }
  let mod = u.protocol === 'https:' ? https : http
  if (p && u.protocol === 'https:') {
    const socket = await tunnel(p, u.hostname, Number(u.port) || 443, timeoutMs)
    // 必须不带 agent，ClientRequest 才会用 createConnection。
    // 没有 agent 时默认端口会按 80 算（Host 头变成 github.com:80，GitHub 会一直 301），要显式给 443。
    opts = { method: 'GET', headers, port: Number(u.port) || 443, defaultPort: 443, createConnection: () => tls.connect({ socket, host: u.hostname, servername: u.hostname, ALPNProtocols: ['http/1.1'] }) }
  } else if (p) {
    const pu = new URL(p)
    mod = http
    opts = { ...opts, host: pu.hostname, port: pu.port || 80, path: url }
    return new Promise((res, rej) => {
      const req = mod.request(opts, res)
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
      req.on('error', rej)
      req.end()
    })
  }
  return new Promise((res, rej) => {
    const req = mod.request(u, opts, res)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`下载无响应超过 ${Math.round(timeoutMs / 1000)} 秒`)))
    req.on('error', rej)
    req.end()
  })
}

function mb(n) { return (n / 1048576).toFixed(1) }

/** 下载到 dest（先写 .part 再改名），跟随重定向，失败重试。onProgress(received, total|null)。 */
export async function download(url, dest, { proxy, onProgress, retries = 3, timeoutMs = 60000, log } = {}) {
  await mkdir(dirname(dest), { recursive: true })
  const signal = currentAbortSignal()
  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    throwIfCancelled()
    let res = null
    // 取消下载：断开当前响应流；请求阶段用 race 立即返回（底层连接随后超时关闭）。
    const onAbort = () => { try { res?.destroy(cancelledError()) } catch {} }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let current = url
      for (let hop = 0; hop < 10; hop++) {
        res = await raceAbort(request(current, proxy, timeoutMs), signal)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          current = new URL(res.headers.location, current).toString()
          continue
        }
        if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}：${current}`) }
        const total = Number(res.headers['content-length']) || null
        let received = 0
        onProgress?.(0, total)
        const part = dest + '.part'
        await new Promise((ok, fail) => {
          const out = createWriteStream(part)
          res.setTimeout?.(timeoutMs, () => res.destroy(new Error(`下载无数据超过 ${Math.round(timeoutMs / 1000)} 秒`)))
          res.on('data', (c) => { received += c.length; onProgress?.(received, total) })
          res.on('error', fail)
          out.on('error', fail)
          out.on('finish', ok)
          res.pipe(out)
        })
        if (total && received !== total) throw new Error(`下载不完整：${received}/${total} 字节`)
        throwIfCancelled()
        await rm(dest, { force: true })
        await rename(part, dest)
        return { bytes: received, url: current }
      }
      throw new Error('重定向次数过多')
    } catch (error) {
      if (signal?.aborted) {
        await rm(dest + '.part', { force: true }).catch(() => {})
        throw cancelledError()
      }
      lastError = error
      log?.(`下载失败（第 ${attempt}/${retries} 次）：${error.message}`)
      if (attempt < retries) await raceAbort(new Promise((r) => setTimeout(r, 2000 * attempt)), signal).catch(() => {})
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  throwIfCancelled()
  throw lastError
}

// ─────────────────────────── 进程与文件 ───────────────────────────

const children = new Set()

/** 结束所有安装子进程（插件卸载时调用）。 */
export function killInstallProcesses() {
  for (const child of children) { try { child.kill() } catch {} }
  children.clear()
}

// ── 取消安装 ──
// 每个安装任务在自己的 AbortSignal 上下文里运行（withAbortSignal）；run() / download() 从上下文取信号，
// 取消时结束该任务的子进程树、断开下载，不影响其他任务，也不必给每个安装步骤单独传参。
const abortStore = new AsyncLocalStorage()
export const CANCELLED_TEXT = '已取消下载'

export function withAbortSignal(signal, fn) { return abortStore.run(signal, fn) }
export function currentAbortSignal() { return abortStore.getStore() ?? null }
export function cancelledError() { return Object.assign(new Error(CANCELLED_TEXT), { name: 'AbortError', cancelled: true }) }
export function isCancelled(error) { return !!error?.cancelled || currentAbortSignal()?.aborted === true }
export function throwIfCancelled() { if (currentAbortSignal()?.aborted) throw cancelledError() }

function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelledError())
  return new Promise((ok, fail) => {
    const onAbort = () => fail(cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((v) => { signal.removeEventListener('abort', onAbort); ok(v) }, (e) => { signal.removeEventListener('abort', onAbort); fail(e) })
  })
}

/** 结束子进程及其子进程（Windows 用 taskkill /T，uv / npm 会再拉起子进程）。 */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (IS_WIN) {
    execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 10000 }, () => {})
  } else {
    try { child.kill('SIGKILL') } catch {}
  }
}

/**
 * 删除某个安装任务留下的临时文件：tools/.tmp-<id>-*（npm / uv / Node.js / OfficeMCP 的解压临时目录）
 * 和 tools/.downloads 里属于它的下载文件（含 .part）。不碰 tools/<id> 本身、共享的 python / 缓存。
 */
export async function removeInstallLeftovers(id) {
  const m = managedPaths()
  const tmpPrefixes = [`.tmp-${id}-`]
  const dlPrefixes = []
  if (id === 'office') { tmpPrefixes.push('.tmp-officemcp-'); dlPrefixes.push('officemcp-') }
  else if (id === 'uv') { const a = uvAsset(); if (a) dlPrefixes.push(a) }
  else if (id === 'node') dlPrefixes.push('node-v')
  const ls = (dir) => { try { return readdirSync(dir) } catch { return [] } }
  for (const name of ls(m.root)) if (tmpPrefixes.some((p) => name.startsWith(p))) await removeDir(join(m.root, name))
  for (const name of ls(m.downloads)) if (dlPrefixes.some((p) => name.startsWith(p))) await rm(join(m.downloads, name), { force: true, recursive: true })
}

/**
 * 安装过程的控制台跟踪：不写入 job.log。
 * live 是当前一行（下载进度或子进程最新一行），默认约 300ms 节流；
 * 最近 50 行留在内存，失败时 dump() 追加到 job.log。
 */
export const CONSOLE_KEEP = 50
export function attachConsole(job, { keep = CONSOLE_KEEP, intervalMs = 300 } = {}) {
  const ring = []
  let lastAt = 0
  let pending = null
  let timer = null
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  const flush = () => {
    stopTimer()
    if (pending == null) return
    job.live = pending
    pending = null
    lastAt = Date.now()
  }
  const show = (text, record) => {
    const line = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
    if (!line) return
    if (record) {
      ring.push(line)
      if (ring.length > keep) ring.splice(0, ring.length - keep)
    }
    const now = Date.now()
    if (now - lastAt >= intervalMs) {
      stopTimer()
      job.live = line
      pending = null
      lastAt = now
      return
    }
    pending = line
    if (!timer) timer = setTimeout(flush, intervalMs - (now - lastAt))
  }
  return {
    /** 子进程的一行（记入环形缓冲）。 */
    live(line) { show(line, true) },
    /** 下载进度（只刷新 live，不进缓冲）。 */
    progress(line) { show(line, false) },
    dump() {
      flush()
      if (ring.length) {
        job.log.push(`控制台输出（最后 ${ring.length} 行）：`)
        for (const line of ring) job.log.push(line)
        if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
      }
      ring.length = 0
      pending = null
      stopTimer()
      job.live = ''
    },
    clear() {
      ring.length = 0
      pending = null
      stopTimer()
      job.live = ''
    },
  }
}

/** 有 live() 时子进程输出不进日志；否则退回 log()（GameBot 的 console.info）。 */
function consoleOf(task) {
  return typeof task?.live === 'function' ? (line) => task.live(line) : (line) => task?.log?.(line)
}

/** 运行命令，逐行回调输出；非零退出时带上最后几行输出抛错。 */
export function run(command, args, { cwd, env, onLine } = {}) {
  const signal = currentAbortSignal()
  return new Promise((ok, fail) => {
    if (signal?.aborted) { fail(cancelledError()); return }
    const tail = []
    let child
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { fail(error); return }
    children.add(child)
    const onAbort = () => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    const emit = (raw) => {
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()
      if (!line.trim()) return
      tail.push(line)
      if (tail.length > 15) tail.shift()
      onLine?.(line)
    }
    // 按行切分（数据块可能在行中间断开），close 时把残余的半行也发出去。
    const partial = { out: '', err: '' }
    const onData = (which) => (buf) => {
      const parts = (partial[which] + buf.toString('utf8')).split(/\r?\n|\r/)
      partial[which] = parts.pop()
      parts.forEach(emit)
    }
    child.stdout.on('data', onData('out'))
    child.stderr.on('data', onData('err'))
    child.on('error', (e) => { children.delete(child); signal?.removeEventListener('abort', onAbort); fail(signal?.aborted ? cancelledError() : e) })
    child.on('close', (code) => {
      children.delete(child)
      signal?.removeEventListener('abort', onAbort)
      emit(partial.out)
      emit(partial.err)
      if (signal?.aborted) fail(cancelledError())
      else if (code === 0) ok()
      else fail(new Error(`${command.split(/[\\/]/).pop()} ${args[0] ?? ''} 退出码 ${code}${tail.length ? '：' + tail.slice(-5).join(' | ') : ''}`))
    })
  })
}

/** Windows 上文件可能短暂被占用（杀毒、刚退出的进程），删除多试几次。 */
export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
}

async function moveDir(from, to) {
  for (let i = 0; i < 6; i++) {
    try { await rename(from, to); return } catch (error) {
      if (i === 5) break
      if (!['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(error.code)) throw error
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  await cp(from, to, { recursive: true })
  await removeDir(from)
}

/** 解压 zip / tar.gz 到目录。Windows 用系统自带的 bsdtar（不是 Git 的 GNU tar），没有时退回 Expand-Archive。 */
export async function extract(archive, destDir, onLine) {
  await mkdir(destDir, { recursive: true })
  if (IS_WIN) {
    const tar = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(tar)) return run(tar, ['-xf', archive, '-C', destDir], { onLine })
    const q = (s) => `'${s.replace(/'/g, "''")}'`
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(destDir)} -Force`], { onLine })
  }
  if (archive.endsWith('.zip')) {
    if (process.platform === 'darwin' || !which('unzip')) return run('tar', ['-xf', archive, '-C', destDir], { onLine })
    return run('unzip', ['-q', '-o', archive, '-d', destDir], { onLine })
  }
  return run('tar', ['-xzf', archive, '-C', destDir], { onLine })
}

function findFile(dir, name, depth = 3) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return p
  }
  if (depth <= 0) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const hit = findFile(join(dir, entry.name), name, depth - 1)
    if (hit) return hit
  }
  return null
}

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) { try { total += statSync(p).size } catch {} }
    }
  }
  return total
}
export { dirSize }

// ─────────────────────────── 安装步骤 ───────────────────────────

/** 给 uv 子进程的环境：Python、缓存都放进 tools/，只用 tools/python 里的解释器。 */
export function uvEnv(proxy) {
  const m = managedPaths()
  const env = { ...process.env }
  for (const k of ['VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT', 'CONDA_PREFIX', 'PYTHONHOME', 'PYTHONPATH']) delete env[k]
  Object.assign(env, {
    UV_PYTHON_INSTALL_DIR: m.python,
    UV_CACHE_DIR: m.cache,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    UV_HTTP_TIMEOUT: '600',
    // uv 在非 TTY（管道）下本来就不画 \r 进度条，强行打开也没有可用进度；保持关闭，进度用下载字节数。
    UV_NO_PROGRESS: '1',
    NO_COLOR: '1',
  })
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy })
  return env
}

function mibText(n) {
  const v = n / 1048576
  return v >= 10 ? v.toFixed(1) : v.toFixed(2)
}

/**
 * HTTP 下载的 live 行。有 Content-Length 时带百分比（0–100）；
 * 分块传输没有总长时只报已收字节和已用时间，percent 为 null，不编造百分比。
 */
function progressReporter(task, label) {
  const started = Date.now()
  let last = 0
  return (received, total) => {
    const now = Date.now()
    if (now - last < 300 && !(total && received === total)) return
    last = now
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : null
    const text = total
      ? `正在下载${label}：${mibText(received)} / ${mibText(total)} MiB（${pct}%）`
      : `正在下载${label}：${mibText(received)} MiB，已用 ${Math.max(0, Math.round((now - started) / 1000))} 秒`
    task.step(text)
    task.progress?.(text, pct)
  }
}

/** 下载 uv 到 tools/uv。task: { step(text), log(line), proxy }。 */
export async function installUv(task) {
  const m = managedPaths()
  const asset = uvAsset()
  if (!asset) throw new Error(`没有适用于 ${process.platform}/${process.arch} 的 uv 预编译包：请手动安装 uv，并在设置中填写 uv 路径`)
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${asset}`
  const archive = join(m.downloads, asset)
  task.step('正在下载 uv')
  task.log(`GET ${url}`)
  const got = await download(url, archive, { proxy: task.proxy, onProgress: progressReporter(task, ' uv'), log: task.log })
  task.log(`已下载 ${mb(got.bytes)} MB ← ${got.url.split('?')[0]}`)
  task.step('正在解压 uv')
  const tmp = join(m.root, `.tmp-uv-${Date.now()}`)
  await removeDir(tmp)
  await extract(archive, tmp, consoleOf(task))
  const uv = findFile(tmp, 'uv' + EXE)
  if (!uv) throw new Error('压缩包中未找到 uv 可执行文件')
  const dest = dirname(m.uv)
  try {
    await removeDir(dest)
  } catch (error) {
    await removeDir(tmp)
    throw new Error(`无法替换 ${dest}（uv 可能正在被使用）：${error.message}`)
  }
  await moveDir(dirname(uv), dest)
  await removeDir(tmp)
  await rm(archive, { force: true })
  let version = ''
  await run(m.uv, ['--version'], { onLine: (l) => { version = l; consoleOf(task)(l) } })
  await writeFile(join(dest, MARKER), JSON.stringify({ id: 'uv', version, source: got.url, installedAt: new Date().toISOString() }, null, 2))
  return { version }
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')))
  })
}

/**
 * 下载 Node.js LTS（NODE_MAJOR）官方包到 tools/node（校验 SHASUMS256）。只在系统里找不到带 npm 的 Node.js 时用。
 * beforeReplace()：删除旧目录之前调用（先停掉正在用 tools/node 的组件）。
 */
export async function installNode(task, { beforeReplace, baseUrl = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/` } = {}) {
  const m = managedPaths()
  const dist = nodeDist()
  if (!dist) throw new Error(`没有适用于 ${process.platform}/${process.arch} 的 Node.js 官方包：请手动安装 Node.js 22 LTS，并在设置中填写 node 路径`)
  task.step('正在获取 Node.js 版本信息')
  const sums = join(m.downloads, `node-v${NODE_MAJOR}-SHASUMS256.txt`)
  task.log(`GET ${baseUrl}SHASUMS256.txt`)
  await download(baseUrl + 'SHASUMS256.txt', sums, { proxy: task.proxy, log: task.log })
  const line = readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.trim().endsWith(dist.suffix) && /\snode-v[\d.]+-/.test(l))
  await rm(sums, { force: true })
  if (!line) throw new Error(`SHASUMS256.txt 中缺少 ${dist.suffix} 的校验值`)
  const [hash, file] = line.trim().split(/\s+/)
  const url = baseUrl + file
  const archive = join(m.downloads, file)
  task.step('正在下载 Node.js')
  task.log(`GET ${url}`)
  const got = await download(url, archive, { proxy: task.proxy, onProgress: progressReporter(task, ' Node.js'), log: task.log })
  task.log(`已下载 ${mb(got.bytes)} MB`)
  task.step('正在校验 Node.js')
  const actual = await sha256(archive)
  if (actual !== hash) { await rm(archive, { force: true }); throw new Error(`Node.js 包校验失败（sha256 ${actual} ≠ ${hash}）`) }
  task.step('正在解压 Node.js')
  const tmp = join(m.root, `.tmp-node-${Date.now()}`)
  await removeDir(tmp)
  await extract(archive, tmp, consoleOf(task))
  const exe = findFile(tmp, IS_WIN ? 'node.exe' : 'node', 3)
  if (!exe) { await removeDir(tmp); throw new Error('压缩包中未找到 node 可执行文件') }
  const home = IS_WIN ? dirname(exe) : dirname(dirname(exe))
  await beforeReplace?.()
  try {
    await removeDir(m.node)
  } catch (error) {
    await removeDir(tmp)
    throw new Error(`无法替换 ${m.node}（Node.js 可能正在被使用）：${error.message}`)
  }
  await moveDir(home, m.node)
  await removeDir(tmp)
  await rm(archive, { force: true })
  versionCache.delete(m.nodeExe)
  const version = nodeVersion(m.nodeExe) || file.replace(/^node-|-.*$/g, '')
  task.log(`Node.js ${version} → ${m.nodeExe}`)
  if (!npmCliNear(m.nodeExe)) throw new Error('解压后的 Node.js 中缺少 npm')
  await writeFile(join(m.node, MARKER), JSON.stringify({ id: 'node', version, source: url, sha256: hash, installedAt: new Date().toISOString() }, null, 2))
  return { version }
}

/** 给 npm 子进程的环境：缓存放 tools/.npm-cache，关掉更新提示 / 募捐 / 审计，代理与镜像按设置。 */
export function npmEnv(proxy, registry, extra = {}) {
  const m = managedPaths()
  const env = { ...process.env, ...extra }
  Object.assign(env, {
    npm_config_cache: m.npmCache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_progress: 'false',
    npm_config_color: 'false',
    NO_COLOR: '1',
  })
  if (proxy) Object.assign(env, { npm_config_proxy: proxy, npm_config_https_proxy: proxy, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy })
  if (registry) env.npm_config_registry = registry
  return env
}

/**
 * 把 npm 包装进 tools/<id>：先在临时目录 npm install（失败不动旧安装），再替换。
 * npm：{ node, cli, env }（resolveNpm 的结果）；bin：包里要用的入口命令名。
 * 装完在标记文件里记下入口脚本的相对路径，启动时用 `node <入口脚本>`（不经 .cmd 包装）。
 */
export async function installNpmPackage(task, { id, spec, bin, npm, extraArgs = [], registry, beforeReplace }) {
  const m = managedPaths()
  const dir = m.dir(id)
  const name = npmPackageName(spec)
  if (!name) throw new Error(`npm 包名为空：${spec}`)
  const tmp = join(m.root, `.tmp-${id}-${Date.now()}`)
  await removeDir(tmp)
  await mkdir(tmp, { recursive: true })
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: `dsh-workbench-tool-${id}`, private: true, description: 'installed by dsh-workbench' }, null, 2))
  const args = [npm.cli, 'install', spec, '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'warn', ...extraArgs]
  task.step(`正在安装 ${spec}`)
  task.log(`> npm ${args.slice(1).join(' ')}`)
  try {
    await run(npm.node, args, { cwd: tmp, env: npmEnv(task.proxy, registry, npm.env), onLine: consoleOf(task) })
  } catch (error) {
    await removeDir(tmp)
    throw error
  }
  task.step('正在校验安装')
  const pkgDir = join(tmp, 'node_modules', ...name.split('/'))
  let pkg
  try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch {
    await removeDir(tmp)
    throw new Error(`安装后未找到 ${name}/package.json`)
  }
  const bins = typeof pkg.bin === 'string' ? { [name.split('/').pop()]: pkg.bin } : (pkg.bin || {})
  const rel = bins[bin] ?? bins[name.split('/').pop()] ?? Object.values(bins)[0]
  const entry = rel ? ['node_modules', ...name.split('/'), ...String(rel).split(/[\\/]/).filter((x) => x && x !== '.')].join('/') : null
  if (!entry || !existsSync(join(tmp, entry))) {
    await removeDir(tmp)
    throw new Error(`${name} 中未找到入口命令 ${bin}`)
  }
  await beforeReplace?.()
  task.step('正在替换旧版本')
  await removeDir(dir)
  await moveDir(tmp, dir)
  await removeDir(m.npmCache).catch(() => {})
  task.log(`${name} ${pkg.version} → ${join(dir, entry)}`)
  await writeFile(join(dir, MARKER), JSON.stringify({ id, package: spec, name, version: pkg.version, bin, entry, installedAt: new Date().toISOString() }, null, 2))
  return { version: pkg.version, entry }
}

/**
 * uv 的控制台输出与下载进度。
 * - 伪控制台模式（Windows，见 runUvPty）：uv 画自己的进度条，bar(name, done, total) 收到每个包的已下载 / 总字节，
 *   live 行显示「正在下载 pydantic-core：1.20 / 2.03 MiB（59%）」或汇总「已下载 12.3 / 40.1 MiB（31%），已完成 3 / 9」。
 * - 管道模式（伪控制台不可用时）：uv 只打印「Downloading 包名 (大小)」和「 Downloaded 包名」，没有字节进度；
 *   这时每秒显示包名、大小、完成数和已用时间。
 */
export function uvConsole(task, { tickMs = 1000 } = {}) {
  const line = consoleOf(task)
  if (typeof task?.progress !== 'function') return { onLine: line, bar() {}, stop() {} }
  const pending = new Map() // 包名 -> { size, at }
  const bars = new Map() // 包名 -> { done, total }（MiB）
  let done = 0
  let total = 0
  let timer = null
  const stop = () => { if (timer) { clearInterval(timer); timer = null } }
  const num = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2))
  const pct = (d, t) => (t > 0 ? `（${Math.min(100, Math.floor((d / t) * 100))}%）` : '')
  const showBars = () => {
    const all = [...bars.entries()]
    const active = all.filter(([, b]) => b.done < b.total)
    if (!active.length) return
    const finished = all.length - active.length
    if (active.length === 1) {
      const [name, b] = active[0]
      const count = all.length > 1 ? `，已完成 ${finished} / ${all.length}` : ''
      task.progress(`正在下载 ${name}：${num(b.done)} / ${num(b.total)} MiB${pct(b.done, b.total)}${count}`, b.total > 0 ? (b.done / b.total) * 100 : null)
      return
    }
    let d = 0
    let tot = 0
    for (const [, b] of all) { d += b.done; tot += b.total }
    task.progress(`已下载 ${num(d)} / ${num(tot)} MiB${pct(d, tot)}，已完成 ${finished} / ${all.length}`, tot > 0 ? (d / tot) * 100 : null)
  }
  const show = () => {
    if (bars.size) { showBars(); return }
    if (!pending.size) return
    const [name, { size, at }] = pending.entries().next().value
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
    const more = pending.size > 1 ? `等 ${pending.size} 个包` : ''
    const count = total > 1 ? `，已完成 ${done} / ${total}` : ''
    task.progress(`正在下载 ${name}（${size}）${more}${count}，已用 ${secs} 秒`, null)
  }
  return {
    onLine(l) {
      line(l)
      let m
      if ((m = /^\s*Downloading (\S+) \(([\d.]+\s*[KMGT]?i?B)\)\s*$/.exec(l))) {
        if (!pending.has(m[1])) total++
        pending.set(m[1], { size: m[2], at: Date.now() })
        if (!timer) { timer = setInterval(show, tickMs); timer.unref?.() }
        show()
      } else if ((m = /^\s*Downloaded (\S+)\s*$/.exec(l)) && pending.delete(m[1])) {
        done++
        if (pending.size) show()
        else stop()
      }
    },
    /** 伪控制台里解析到的进度条：name 已下载 done / total MiB。 */
    bar(name, doneMiB, totalMiB) {
      if (!(totalMiB > 0)) return
      bars.set(name, { done: Math.min(doneMiB, totalMiB), total: totalMiB })
      stop() // 有真实进度后不再需要计时文案
      showBars()
    },
    stop,
  }
}

// ── 伪控制台（ConPTY）运行 uv ──
// uv 只有在终端里（且 TERM 不是 dumb / 未设置）才画下载进度条。Windows 10 1809+ 的 CreatePseudoConsole 可以给 uv
// 一个真正的控制台：由 Windows PowerShell 在运行时编译一段 C#（Add-Type，无原生插件）创建伪控制台并启动 uv，
// 把 VT 输出转发到管道，这里解析进度条。辅助脚本启动 uv 失败（系统过旧、执行策略、编译失败）时退回普通管道模式。
const PTY_SCRIPT_NAME = 'conpty-v1.ps1'
const PTY_SCRIPT = String.raw`# Run a command inside a Windows pseudo console (ConPTY) and copy its VT output to stdout.
# Usage: set DSH_PTY_CMD to the full Windows command line, then: powershell -File conpty.ps1 -Cols 300
param([int]$Cols = 300, [int]$Rows = 50)
$src = @"
using System; using System.IO; using System.Runtime.InteropServices; using System.Threading; using Microsoft.Win32.SafeHandles;
public static class Pty {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle hIn, SafeFileHandle hOut, uint flags, out IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern void ClosePseudoConsole(IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  public static int Run(string cmd, short cols, short rows) {
    SafeFileHandle inR, inW, outR, outW;
    CreatePipe(out inR, out inW, IntPtr.Zero, 0); CreatePipe(out outR, out outW, IntPtr.Zero, 0);
    IntPtr hpc; int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inR, outW, 0, out hpc);
    if (hr != 0) { Console.Error.WriteLine("CreatePseudoConsole failed " + hr); return 90; }
    inR.Dispose(); outW.Dispose();
    IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.StartupInfo.dwFlags = 0x00000100; si.StartupInfo.hStdInput = IntPtr.Zero; si.StartupInfo.hStdOutput = IntPtr.Zero; si.StartupInfo.hStdError = IntPtr.Zero;
    si.lpAttributeList = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size)) return 91;
    if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, (IntPtr)0x20016, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) return 92;
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, IntPtr.Zero, null, ref si, out pi)) { Console.Error.WriteLine("CreateProcess failed " + Marshal.GetLastWin32Error()); return 93; }
    Console.Error.WriteLine("PID " + pi.dwProcessId);
    var stdout = Console.OpenStandardOutput();
    var reader = new Thread(() => { var fs = new FileStream(outR, FileAccess.Read); var buf = new byte[8192]; int n; try { while ((n = fs.Read(buf, 0, buf.Length)) > 0) { stdout.Write(buf, 0, n); stdout.Flush(); } } catch {} });
    reader.IsBackground = true; reader.Start();
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    Thread.Sleep(300); ClosePseudoConsole(hpc); reader.Join(2000);
    return (int)code;
  }
}
"@
Add-Type -TypeDefinition $src
exit [Pty]::Run($env:DSH_PTY_CMD, [int16]$Cols, [int16]$Rows)
`
let ptyBroken = false

function ptyScriptPath() {
  const dir = join(toolsDir(), '.pty')
  const file = join(dir, PTY_SCRIPT_NAME)
  let current = null
  try { current = readFileSync(file, 'utf8') } catch {}
  if (current !== PTY_SCRIPT) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, PTY_SCRIPT, 'utf8')
  }
  return file
}

/** Windows 命令行引号规则（CreateProcess / CommandLineToArgvW）。 */
function winQuote(arg) {
  const s = String(arg)
  if (s && !/[\s"]/.test(s)) return s
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

const UNIT_MIB = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }
const BAR_RE = /^(\S+)\s+[-━─=>#]{5,}\s+([\d.]+)\s*(B|KiB|MiB|GiB)\/([\d.]+)\s*(B|KiB|MiB|GiB)\s*$/
// 进度条之外的刷新内容（转圈、整体进度），不记入控制台缓冲。
const PTY_NOISE_RE = /^[⠀-⣿]|Preparing packages\.\.\.|Installing wheels\.\.\.|Resolving dependencies|Building |[░█▏▎▍▌▋▊▉]{3,}/

/**
 * 在伪控制台里运行 uv。onLine：普通输出行（去掉 VT 控制序列）；onBar(name, doneMiB, totalMiB)：进度条。
 * uv 没能启动时以 { ptyUnavailable: true } 的错误拒绝（调用方改用管道模式重试，不会重复执行 uv）。
 */
function runUvPty(command, args, { cwd, env, onLine, onBar } = {}) {
  const signal = currentAbortSignal()
  return new Promise((ok, fail) => {
    if (signal?.aborted) { fail(cancelledError()); return }
    let script
    try { script = ptyScriptPath() } catch (error) { fail(Object.assign(error, { ptyUnavailable: true })); return }
    const childEnv = { ...(env ?? process.env), TERM: 'xterm-256color', DSH_PTY_CMD: [command, ...args].map(winQuote).join(' ') }
    delete childEnv.UV_NO_PROGRESS
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Cols', '300'], { cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { fail(Object.assign(error, { ptyUnavailable: true })); return }
    children.add(child)
    const onAbort = () => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    let started = false
    const diag = []
    const tail = []
    let last = ''
    let carry = ''
    // 伪控制台按整行重绘：多行之间常常没有换行，而是用光标定位和行尾补齐的空格隔开，所以再按长串空格切成行。
    const handle = (piece) => {
      for (const row of piece.split(/ {40,}/)) {
        const text = row.trim()
        if (!text) continue
        const m = BAR_RE.exec(text)
        if (m) { onBar?.(m[1], +m[2] * UNIT_MIB[m[3]], +m[4] * UNIT_MIB[m[5]]); continue }
        if (PTY_NOISE_RE.test(text) || text === last) continue
        last = text
        tail.push(text)
        if (tail.length > 15) tail.shift()
        onLine?.(text)
      }
    }
    const flush = (final) => {
      let s = carry
      // 不完整的控制序列留到下一块。
      const partial = final ? -1 : s.search(/\x1b(\[[0-9;?]*[ -\/]*)?$|\x1b\][^\x07]*$/)
      if (partial >= 0) { carry = s.slice(partial); s = s.slice(0, partial) } else carry = ''
      s = s
        .replace(/\x1b\][^\x07]*\x07/g, '') // 窗口标题
        .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n) || 1, 300))) // 伪控制台用光标右移代替连续空格
        .replace(/\x1b\[[0-9;?]*[ -\/]*[ABDEFGHJKSTfsu]/g, '\n') // 光标移动 / 清屏：按换行切分
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '') // 其余（颜色、模式切换）
        .replace(/\x1b./g, '')
      const parts = s.split(/\r\n|\n|\r/)
      const rest = final ? '' : parts.pop()
      parts.forEach(handle)
      if (final) return
      // 没有换行的半行：完整的行（后面已有补齐空格）先处理，最后一段可能不完整，留到下一块。
      const rows = rest.split(/( {40,})/)
      const open = rows.pop()
      if (rows.length) handle(rows.join(''))
      carry = open + carry
      if (carry.length > 8192) { handle(carry); carry = '' }
    }
    const debugFile = process.env.DSH_WORKBENCH_PTY_DEBUG // 排查用：把伪控制台原始输出追加到该文件
    child.stdout.on('data', (buf) => {
      if (debugFile) { try { appendFileSync(debugFile, buf) } catch {} }
      carry += buf.toString('utf8')
      flush(false)
    })
    child.stderr.on('data', (buf) => {
      for (const l of buf.toString('utf8').split(/\r?\n/)) {
        if (/^PID \d+/.test(l)) started = true
        else if (l.trim()) { diag.push(l.trim()); if (diag.length > 10) diag.shift() }
      }
    })
    child.on('error', (e) => { children.delete(child); signal?.removeEventListener('abort', onAbort); fail(signal?.aborted ? cancelledError() : Object.assign(e, { ptyUnavailable: !started })) })
    child.on('close', (code) => {
      children.delete(child)
      signal?.removeEventListener('abort', onAbort)
      flush(true)
      if (signal?.aborted) fail(cancelledError())
      else if (!started) fail(Object.assign(new Error(`伪控制台不可用（退出码 ${code}）${diag.length ? '：' + diag.slice(-3).join(' | ') : ''}`), { ptyUnavailable: true }))
      else if (code === 0) ok()
      else fail(new Error(`uv ${args[0] ?? ''} 退出码 ${code}${tail.length ? '：' + tail.slice(-5).join(' | ') : ''}`))
    })
  })
}

/** 会下载内容（包、Python）的 uv 子命令才值得用伪控制台显示进度。 */
const usePty = (args) => IS_WIN && !ptyBroken && process.env.DSH_WORKBENCH_NO_PTY !== '1'
  && (args[0] === 'venv' || args[0] === 'sync' || (args[0] === 'pip' && args[1] === 'install'))

async function uv(task, args, cwd) {
  const m = managedPaths()
  task.log(`> uv ${args.join(' ')}`)
  const con = uvConsole(task)
  const env = uvEnv(task.proxy)
  try {
    if (usePty(args)) {
      try {
        await runUvPty(m.uv, args, { cwd, env, onLine: con.onLine, onBar: con.bar })
        return
      } catch (error) {
        if (!error?.ptyUnavailable) throw error
        // uv 没有启动过：本次会话改用管道模式（只显示已用时间）。
        ptyBroken = true
        task.log(`无法显示下载进度（${error.message}），改用普通模式`)
      }
    }
    await run(m.uv, args, { cwd, env, onLine: con.onLine })
  } finally { con.stop() }
}

async function pruneCache(task) {
  try { await uv(task, ['cache', 'prune', '--ci']) } catch (error) { task.log(`清理缓存失败（不影响安装）：${error.message}`) }
}

/**
 * 下载 OfficeMCP 源码到 tools/officemcp，uv sync，再装 pillow（ScreenShot 工具要用，OfficeMCP 没列进依赖）。
 * beforeReplace()：删除旧目录之前调用（让组件先停掉，释放 venv 里的文件）。
 */
export async function installOffice(task, { repoUrl = 'https://github.com/officemcp/officemcp', branch = 'main', beforeReplace } = {}) {
  if (!IS_WIN) throw new Error('OfficeMCP 依赖 Windows COM，只能在 Windows 上安装')
  const m = managedPaths()
  const base = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '')
  const url = `${base}/archive/refs/heads/${branch}.zip`
  const archive = join(m.downloads, `officemcp-${branch}.zip`)
  task.step('正在下载 OfficeMCP 源码')
  task.log(`GET ${url}`)
  const got = await download(url, archive, { proxy: task.proxy, onProgress: progressReporter(task, ' OfficeMCP 源码'), log: task.log })
  task.log(`已下载 ${mb(got.bytes)} MB`)
  task.step('正在解压 OfficeMCP')
  const tmp = join(m.root, `.tmp-officemcp-${Date.now()}`)
  await removeDir(tmp)
  await extract(archive, tmp, consoleOf(task))
  const pyproject = findFile(tmp, 'pyproject.toml', 2)
  if (!pyproject) throw new Error('压缩包中缺少 pyproject.toml，不是有效的 OfficeMCP 源码')
  await beforeReplace?.()
  await removeDir(m.officeRepo)
  await moveDir(dirname(pyproject), m.officeRepo)
  await removeDir(tmp)
  await rm(archive, { force: true })
  task.step(`正在安装依赖（Python ${PYTHON_VERSION}）`)
  await uv(task, ['sync', '--python', PYTHON_VERSION], m.officeRepo)
  task.step('正在安装 pillow')
  await uv(task, ['pip', 'install', '--python', m.officePython, 'pillow'], m.officeRepo)
  task.step('正在校验安装')
  await run(m.officePython, ['-c', "import importlib.util as u, sys; assert u.find_spec('officemcp') and u.find_spec('PIL'), 'officemcp/PIL missing'; print('python', sys.version.split()[0], 'ok')"], { onLine: consoleOf(task) })
  await pruneCache(task)
  await writeFile(join(m.officeRepo, MARKER), JSON.stringify({ id: 'office', source: url, installedAt: new Date().toISOString() }, null, 2))
}

/**
 * 建独立 venv（tools/<id>/.venv）并装入 pip 包，入口命令 entry 必须存在。
 * extraPackages：一起装进去的其他包；afterInstall({ dir, venv, python, version })：装好后、写标记前调用，
 * 返回的字段并进 .dsh-install.json。
 */
export async function installVenvTool(task, { id, spec, entry, beforeReplace, extraPackages = [], afterInstall }) {
  const m = managedPaths()
  const dir = m.dir(id)
  const venv = m.venv(id)
  await beforeReplace?.()
  task.step('正在清理旧版本')
  await removeDir(dir)
  await mkdir(dir, { recursive: true })
  task.step(`正在创建 Python ${PYTHON_VERSION} 环境`)
  await uv(task, ['venv', '--python', PYTHON_VERSION, '--no-project', venv], dir)
  task.step(`正在安装 ${[spec, ...extraPackages].join(' ')}`)
  await uv(task, ['pip', 'install', '--python', venvBin(venv, 'python'), spec, ...extraPackages], dir)
  const exe = venvBin(venv, entry)
  if (!existsSync(exe)) throw new Error(`安装后未找到入口命令：${exe}`)
  let version = ''
  try {
    await run(m.uv, ['pip', 'show', '--python', venvBin(venv, 'python'), packageName(spec)], {
      env: uvEnv(task.proxy),
      onLine: (l) => { if (/^Version:/i.test(l)) version = l.split(':')[1].trim() },
    })
  } catch {}
  task.log(`${packageName(spec)} ${version} → ${exe}`)
  const extra = afterInstall ? await afterInstall({ dir, venv, python: venvBin(venv, 'python'), version }) : {}
  await pruneCache(task)
  await writeFile(join(dir, MARKER), JSON.stringify({ id, package: spec, entry, version, ...extra, installedAt: new Date().toISOString() }, null, 2))
}

/** 结束可执行文件在 dir 下的所有进程（连同子进程）。替换 / 删除 tools/<id> 前用：只动插件自己装的程序。返回结束的个数。 */
export async function killProcessesUnder(dir, log) {
  const root = resolve(dir)
  let pids = []
  try {
    if (IS_WIN) {
      const q = root.replace(/'/g, "''")
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${q}\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      pids = out.split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid)
      for (const pid of pids) {
        try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 10000 }) } catch {}
      }
    } else {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 10000 })
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)/.exec(line)
        if (m && m[2].startsWith(root + '/') && Number(m[1]) !== process.pid) pids.push(Number(m[1]))
      }
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
    }
  } catch (error) {
    log?.(`查找残留进程失败（不影响安装）：${error.message}`)
    return 0
  }
  if (pids.length) {
    log?.(`已结束 ${pids.length} 个残留进程（PID ${pids.join(', ')}）`)
    await new Promise((r) => setTimeout(r, 800))
  }
  return pids.length
}

// ─────────────────────────── Godot 插件（hi-godot/godot-ai） ───────────────────────────

export const GODOT_REPO = 'hi-godot/godot-ai'
/** Godot AI v4 的 GitHub Release 三件套：插件 zip、签名的文件清单、清单签名。 */
export const GODOT_ADDON_FILES = ['godot-ai-v4-plugin.zip', 'godot-ai-v4-plugin.manifest.json', 'godot-ai-v4-plugin.manifest.sig']
export const GODOT_MIN_VERSION = '4.7'

// 用 godot-ai 包自带的 godot_ai.release_verify 校验（RSA 签名 + 清单里每个文件的大小 / SHA-256 + plugin.cfg 版本），
// 和 Godot 里「新项目安装」走的是同一套检查；stage 模式再把校验过的文件解压到一个新目录（目标已存在就拒绝）。
// 期望的身份：仓库 hi-godot/godot-ai、stable、tag v<服务器版本>、版本 = 服务器版本；源提交取自清单本身（签名覆盖它）。
const GODOT_VERIFY_PY = [
  'import json, sys',
  'from pathlib import Path',
  'from godot_ai import release_verify as rv',
  'mode, folder, version = sys.argv[1], Path(sys.argv[2]), sys.argv[3]',
  'files = [folder / rv.ASSET_NAME, folder / rv.MANIFEST_NAME, folder / rv.SIGNATURE_NAME]',
  'try:',
  '    raw = json.loads(files[1].read_bytes())',
  '    commit = str(raw.get("source_commit", "")) if isinstance(raw, dict) else ""',
  '    expected = (rv.REPOSITORY, "stable", "v" + version, version, commit)',
  '    if mode == "verify":',
  '        m = rv.verify_release(*files, expected)',
  '        out = {"version": m["version"], "files": len(m["inventory"]), "sha256": m["asset"]["sha256"], "source_commit": m["source_commit"]}',
  '    else:',
  '        plugin, _digest, m = rv.stage_verified_release(*files, expected, Path(sys.argv[4]))',
  '        out = {"version": m["version"], "files": len(m["inventory"]), "plugin": str(plugin)}',
  'except (rv.ReleaseError, OSError, ValueError) as e:',
  '    print("DSH_ERROR " + str(e))',
  '    sys.exit(3)',
  'print("DSH_JSON " + json.dumps(out))',
].join('\n')

async function runGodotVerify(python, args, log) {
  let out = null
  let err = null
  try {
    await run(python, ['-c', GODOT_VERIFY_PY, ...args], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
      onLine: (l) => {
        if (l.startsWith('DSH_JSON ')) out = JSON.parse(l.slice(9))
        else if (l.startsWith('DSH_ERROR ')) err = l.slice(10)
        else log?.(l)
      },
    })
  } catch (error) {
    throw new Error(err ? `Godot 插件校验失败：${err}` : error.message)
  }
  if (!out) throw new Error('Godot 插件校验无输出')
  return out
}

/**
 * 下载与 godot-ai 同版本的 Godot 插件（GitHub Release v<version> 的三件套）到 <dir>/addon，校验签名后才替换旧的。
 * python：tools/godot/.venv 里的 python（带 godot_ai 和 cryptography）。返回写进标记文件的 addon 信息。
 */
export async function fetchGodotAddon(task, { dir, python, version, baseUrl }) {
  if (!/^4\.\d+\.\d+$/.test(String(version || ''))) throw new Error(`godot-ai ${version || '(未知版本)'} 不是 v4 正式版，无对应的签名插件包`)
  const base = baseUrl ?? `https://github.com/${GODOT_REPO}/releases/download/v${version}/`
  const addonDir = join(dir, 'addon')
  const tmp = join(dir, `.addon-tmp-${Date.now()}`)
  await removeDir(tmp)
  await mkdir(tmp, { recursive: true })
  try {
    for (const f of GODOT_ADDON_FILES) {
      task.step(`正在下载 Godot 插件：${f}`)
      task.log(`GET ${base}${f}`)
      await download(base + f, join(tmp, f), { proxy: task.proxy, onProgress: progressReporter(task, ` ${f}`), log: task.log })
    }
    task.step('正在校验 Godot 插件签名')
    const info = await runGodotVerify(python, ['verify', tmp, version], consoleOf(task))
    if (info.version !== version) throw new Error(`插件版本 ${info.version} 与服务器版本 ${version} 不一致`)
    await removeDir(addonDir)
    await moveDir(tmp, addonDir)
    task.log(`Godot 插件 ${info.version}（${info.files} 个文件，签名已校验）→ ${addonDir}`)
    return { version: info.version, files: info.files, sha256: info.sha256, sourceCommit: info.source_commit, verifiedAt: new Date().toISOString() }
  } catch (error) {
    await removeDir(tmp).catch(() => {})
    throw error
  }
}

/** tools/godot/addon 里的三件套是否齐全。 */
export function godotAddonReady(dir) {
  return GODOT_ADDON_FILES.every((f) => existsSync(join(dir, 'addon', f)))
}

const statusError = (status, message) => Object.assign(new Error(message), { status })

/** 校验「Godot 项目路径」：绝对路径、存在、含 project.godot（也接受直接填 project.godot 文件）。返回项目根目录。 */
export function resolveGodotProject(input) {
  const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!raw) throw statusError(400, '请填写 Godot 项目路径（包含 project.godot 的文件夹）')
  if (!isAbsolute(raw)) throw statusError(400, `项目路径须为完整路径：${raw}`)
  let root = resolve(raw)
  let st
  try { st = statSync(root) } catch { throw statusError(400, `目录不存在：${root}`) }
  if (st.isFile() && basename(root).toLowerCase() === 'project.godot') { root = dirname(root); st = statSync(root) }
  if (!st.isDirectory()) throw statusError(400, `不是文件夹：${root}`)
  let pf
  try { pf = statSync(join(root, 'project.godot')) } catch {}
  if (!pf?.isFile()) throw statusError(400, `不是 Godot 项目目录（缺少 project.godot）：${root}`)
  return root
}

/** plugin.cfg 里的 version="…"；读不到返回 null。 */
export function readPluginCfgVersion(file) {
  try {
    const m = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(readFileSync(file, 'utf8'))
    return m ? m[1] : null
  } catch {
    return null
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 把 tools/godot/addon 里校验过的插件装进 Godot 项目的 addons/godot_ai。
 *   - 只装进含 project.godot 的目录（resolveGodotProject）；addons/godot_ai 是链接（开发检出）时不动。
 *   - 已经是同一版本：什么都不改。
 *   - 已有其他版本：Godot 在运行时拒绝（插件文件正被编辑器加载）；否则先把整个旧目录挪到
 *     addons/.godot_ai_backup/<旧版本>-<时间>/（带 .gdignore，Godot 不扫描），不覆盖、不合并。
 *   - 新文件先由 release_verify 校验签名并解压到 addons/.godot_ai_dsh_stage-*（同一分区），再改名成 addons/godot_ai。
 */
export async function installGodotAddonToProject({ project, dir, python, version, godotRunning = false }) {
  const root = resolveGodotProject(project)
  const addons = join(root, 'addons')
  const target = join(addons, 'godot_ai')
  let prev = null
  let exists = false
  try {
    const st = lstatSync(target)
    exists = true
    if (st.isSymbolicLink()) throw statusError(409, `${target} 是符号链接（可能是开发检出），不自动修改`)
    if (!st.isDirectory()) throw statusError(409, `${target} 不是文件夹，不自动修改`)
    prev = readPluginCfgVersion(join(target, 'plugin.cfg'))
  } catch (error) {
    if (error.status) throw error
  }
  if (exists && prev === version) {
    return { action: 'same', project: root, target, version, message: `项目中已是 Godot AI ${version}（${target}），无需重新安装。请在 Godot「项目 → 项目设置 → 插件」中确认 Godot AI 已启用。` }
  }
  if (exists && godotRunning) {
    throw statusError(409, `Godot 正在运行：请关闭 Godot 后再替换项目中的 Godot AI 插件（${prev || '未知版本'} → ${version}）`)
  }
  await mkdir(addons, { recursive: true })
  const stage = join(addons, `.godot_ai_dsh_stage-${Date.now()}`)
  let backup = null
  try {
    const info = await runGodotVerify(python, ['stage', join(dir, 'addon'), version, stage])
    const staged = join(stage, 'addons', 'godot_ai')
    if (!existsSync(join(staged, 'plugin.cfg'))) throw new Error('校验后的插件中缺少 plugin.cfg')
    if (exists) {
      const backupRoot = join(addons, '.godot_ai_backup')
      await mkdir(backupRoot, { recursive: true })
      await writeFile(join(backupRoot, '.gdignore'), '')
      backup = join(backupRoot, `${(prev || 'unknown').replace(/[^\w.-]/g, '_')}-${stamp()}`)
      try {
        await rename(target, backup)
      } catch (error) {
        backup = null
        throw statusError(409, `无法移动旧插件 ${target}（可能被 Godot 或其他程序占用）：${error.code || error.message}`)
      }
    }
    try {
      await rename(staged, target)
    } catch (error) {
      if (backup) { try { await rename(backup, target) } catch {} ; backup = null }
      throw new Error(`无法写入插件目录 ${target}：${error.code || error.message}`)
    }
    const how = exists
      ? `已替换 ${prev || '未知版本'}（旧目录已移至 ${backup}）`
      : '新安装'
    return {
      action: exists ? 'replaced' : 'installed', project: root, target, version, previous: prev, backup, files: info.files,
      message: `安装完成：${target}（Godot AI ${version}，${info.files} 个文件，签名已校验，${how}）。请在 Godot 中打开该项目，并在「项目 → 项目设置 → 插件」中启用 Godot AI。`,
    }
  } finally {
    await removeDir(stage).catch(() => {})
  }
}
