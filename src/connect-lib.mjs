/**
 * 「已连接」探测的共享原语：进程列表、TCP / HTTP、MCP 工具调用、Chrome 配置目录等。
 * 各组件的 app 描述与 probe 实现放在 src/components/<id>/；本文件不依赖具体组件。
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROBE_TTL_MS = 6000
export const PROBE_TIMEOUT_MS = 15000
export const TOOL_TIMEOUT_MS = 4000
const NET_TIMEOUT_MS = 800
const IS_WIN = process.platform === 'win32'

/** connection.state 的取值（前端据此显示文字 / 颜色）。 */
export const CONN_STATES = ['connected', 'no-app', 'unreachable', 'mcp-down', 'checking']

// ── 程序进程 ──
// 名字统一小写、去掉 .exe；macOS 上是可执行文件名（ps -o comm= 的最后一段）。
// APPS 由各组件模块贡献，见 ./connect.mjs

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

/** 当前进程名集合（小写、无 .exe）。Windows 用 tasklist（CSV 第一列是映像名，和系统语言无关）。 */
export async function listProcesses() {
  const names = new Set()
  if (IS_WIN) {
    const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line)
      if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ''))
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'comm='])
    for (const line of out.split('\n')) {
      const p = line.trim()
      if (p) names.add(p.split('/').pop().toLowerCase())
    }
  }
  return names
}

/** 进程名集合里是否匹配 app.match（app 为 { match }）。 */
export function appRunning(procs, app) {
  if (!app?.match) return false
  for (const n of procs) if (app.match.test(n)) return true
  return false
}

/** 兼容：按 id 查 APPS 表（由 connect.mjs 注入）。 */
let _APPS = {}
export function setApps(apps) { _APPS = apps || {} }

/** 进程名集合里有没有该组件的程序（procs 为空 / 不是集合时算没有）。 */
export function appRunningIn(procs, id) {
  if (!procs || typeof procs[Symbol.iterator] !== 'function' || !_APPS[id]) return false
  return appRunning(procs, _APPS[id])
}

export function noAppById(id) {
  const app = _APPS[id]
  return { state: 'no-app', detail: `未检测到 ${app?.name || id} 运行${app?.exe ? `（${app.exe}）` : ''}`, via: 'process' }
}


// ── 网络 ──
/** TCP 能不能连上（连上立刻断开，不发数据）。 */
export function tcpOpen(host, port, timeout = NET_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeout)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** MCP for Unity 桥接的握手 + ping（和服务器 port_discovery._try_probe_unity_mcp 一样的帧格式）。 */
export function unityPing(port, timeout = NET_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    let buf = Buffer.alloc(0)
    let stage = 'hello'
    const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeout)
    sock.once('error', () => done(false))
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 'hello') {
        const text = buf.toString('latin1')
        if (!text.includes('FRAMING=1')) {
          if (text.includes('\n') || buf.length > 256) done(false)
          return
        }
        stage = 'pong'
        buf = Buffer.alloc(0)
        const header = Buffer.alloc(8)
        header.writeBigUInt64BE(4n)
        sock.write(Buffer.concat([header, Buffer.from('ping')]))
        return
      }
      if (buf.length < 8) return
      const len = Number(buf.readBigUInt64BE(0))
      if (len > 10000) return done(false)
      if (buf.length < 8 + len) return
      done(buf.subarray(8, 8 + len).toString('utf8').includes('"message":"pong"'))
    })
  })
}

/** GET 一个 JSON（只用于 Chrome 调试地址的 /json/version）。 */
export async function httpJson(url, timeout = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 探测 HTTP 状态（区分「端口没开」和 Chrome 144+ inspect 开关下 /json/version 返回 404）。 */
export async function httpStatus(url, timeout = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ac.signal })
    return res.status
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/** Chrome 配置目录是不是正被某个 Chrome 占用。 */
export function profileLocked(dir) {
  if (!dir) return false
  if (IS_WIN) {
    // Chrome 运行期间独占打开 <配置目录>\lockfile；打得开（或不存在）就说明没有 Chrome 在用。
    const p = join(dir, 'lockfile')
    if (!existsSync(p)) return false
    try {
      closeSync(openSync(p, 'r+'))
      return false
    } catch (error) {
      return error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'
    }
  }
  try {
    const target = readlinkSync(join(dir, 'SingletonLock')) // "<host>-<pid>"
    const pid = Number(target.split('-').pop())
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export const defaultEnv = { processes: listProcesses, tcpOpen, unityPing, httpJson, httpStatus, profileLocked, home: homedir, env: process.env }

// ── 经 dsh-mcp-client 已有连接调用工具 ──
/** 服务器在 ctx.tools 里注册了的工具名（mcp__<server>__*）；拿不到工具表时返回 null。 */
export function mcpToolNames(tools, serverName) {
  const prefix = `mcp__${serverName}__`
  try {
    const view = tools?.view?.()
    if (view?.visible instanceof Map) return [...view.visible.keys()].filter((n) => n.startsWith(prefix))
  } catch {}
  try {
    const list = tools?.schemas?.()
    if (Array.isArray(list)) return list.map((s) => s.name).filter((n) => typeof n === 'string' && n.startsWith(prefix))
  } catch {}
  return null
}

function textOf(value) {
  const content = Array.isArray(value?.content) ? value.content : []
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
}

/** 直接执行 dsh-mcp-client 注册的工具定义（它的 execute 用自己的 MCP 连接发 tools/call）。 */
export async function callMcpTool(tools, serverName, rawName, args = {}, timeoutMs = TOOL_TIMEOUT_MS) {
  const def = typeof tools?.get === 'function' ? tools.get(`mcp__${serverName}__${rawName}`) : undefined
  if (!def || typeof def.execute !== 'function') return { ok: false, missing: true, error: `未注册工具 ${rawName}` }
  const ac = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`${rawName} 在 ${timeoutMs / 1000} 秒内未返回`), { timeout: true })) }, timeoutMs)
  })
  try {
    const value = await Promise.race([def.execute(args, { signal: ac.signal }), timeout])
    return { ok: true, value, text: textOf(value) }
  } catch (error) {
    return { ok: false, timeout: !!error?.timeout, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

// ── 各组件 ──
export const result = (state, detail, via) => ({ state, detail, via })
// 工具调用失败；超时单独标出（服务器可能正忙着执行模型的调用，调用方可以沿用上一次的结果）。
export const toolFailed = (r, detail, via) => ({ ...result('unreachable', detail, via), ...(r.timeout ? { timeout: true } : {}) })
export const noAppFor = (app, extra = '') => result('no-app', `未检测到 ${app.name} 运行（${app.exe}）${extra}`, 'process')

/** 工具结果里的 JSON（structuredContent 优先，其次文本）；取不到返回 null。 */
export function jsonOf(r) {
  const sc = r?.value?.structuredContent
  if (sc && typeof sc === 'object') return sc.result && typeof sc.result === 'object' && !Array.isArray(sc.result) ? sc.result : sc
  try { return JSON.parse(r.text) } catch { return null }
}

/** 服务器还没注册任何工具时（连接中 / 重连中 / 已放弃），不算已连接。 */
export function mcpNotReady(ctx, component) {
  const names = mcpToolNames(ctx.tools, component.serverName)
  if (names && names.length === 0) return result('mcp-down', '未注册工具，可能正在启动或重连', 'tools')
  return null
}

export function chromeProfileDir(cfg, home) {
  if (cfg.chromeUserDataDir && cfg.chromeUserDataDir.trim()) return cfg.chromeUserDataDir.trim()
  const ch = cfg.chromeChannel && cfg.chromeChannel !== 'stable' ? `chrome-profile-${cfg.chromeChannel}` : 'chrome-profile'
  return join(home, '.cache', 'chrome-devtools-mcp', ch)
}

/** autoConnect 连的是该渠道 Chrome 的默认配置目录。 */
export function chromeDefaultUserDataDir(channel, env, home) {
  const ch = channel || 'stable'
  if (IS_WIN) {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const name = { stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome SxS' }[ch] || 'Chrome'
    return join(base, 'Google', name, 'User Data')
  }
  if (process.platform === 'darwin') {
    const name = { stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome Canary' }[ch] || 'Chrome'
    return join(home, 'Library', 'Application Support', 'Google', name)
  }
  const name = { stable: 'google-chrome', beta: 'google-chrome-beta', dev: 'google-chrome-unstable', canary: 'google-chrome-canary' }[ch] || 'google-chrome'
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), name)
}

export function readDevToolsPort(dir) {
  try {
    const [port] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    const n = Number(port)
    return n > 0 && n < 65536 ? n : null
  } catch {
    return null
  }
}

export async function listPages(ctx, component, prefix, timeoutMs = TOOL_TIMEOUT_MS) {
  const r = await callMcpTool(ctx.tools, component.serverName, 'list_pages', {}, timeoutMs)
  if (!r.ok) return toolFailed(r, `${prefix}，但 list_pages 失败：${r.error}`, 'tool:list_pages')
  const pages = (r.text.match(/^\s*\d+:/gm) || []).length
  return result('connected', `${prefix}，list_pages 成功${pages ? `（${pages} 个标签页）` : ''}`, 'tool:list_pages')
}

