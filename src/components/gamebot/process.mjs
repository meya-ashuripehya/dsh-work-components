/**
 * GameBot REST body process lifecycle (owned child only).
 * Spawned when the workbench enables a game; stopped on disable / plugin unload.
 * Does not kill an externally started GameBot on the same port.
 *
 * Lifecycle: no module-level process listeners. The plugin's apply() installs the
 * exit hook through ctx.effect (installExitHook) and awaits stopBody() on dispose.
 * We never listen to SIGINT / SIGTERM: a listener would override the host's own
 * signal handling (Node stops exiting by default once one is registered).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** @type {import('node:child_process').ChildProcess | null} */
let owned = null
/** Base URL we last started (no trailing slash). */
let ownedUrl = ''

const IS_WIN = process.platform === 'win32'

/**
 * Last-resort cleanup when the host process exits without disposing the plugin.
 * 'exit' handlers must be synchronous, so this uses spawnSync. Returns a disposer.
 */
export function installExitHook() {
  const onExit = () => {
    const child = owned
    if (!child?.pid || child.exitCode != null) return
    try {
      if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      else child.kill('SIGTERM')
    } catch {}
  }
  process.on('exit', onExit)
  return () => { process.off('exit', onExit) }
}

function waitExit(child, ms) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.off('exit', done); resolve(false) }, ms)
    function done() { clearTimeout(t); resolve(true) }
    child.once('exit', done)
  })
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let p
    try {
      p = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    } catch { resolve(false); return }
    const t = setTimeout(() => { try { p.kill() } catch {} ; resolve(false) }, 10000)
    p.once('error', () => { clearTimeout(t); resolve(false) })
    p.once('close', (code) => { clearTimeout(t); resolve(code === 0) })
  })
}

/** Stop the REST body we started (no-op if we never owned one). Resolves after the process tree is gone (bounded). */
export async function stopBody() {
  const child = owned
  owned = null
  ownedUrl = ''
  if (!child || child.exitCode != null || child.signalCode != null) return
  try {
    if (IS_WIN && child.pid) await runTaskkill(child.pid)
    else child.kill('SIGTERM')
  } catch {}
  if (!(await waitExit(child, 5000))) {
    try { child.kill('SIGKILL') } catch {}
    await waitExit(child, 2000)
  }
}

export function bodyOwned() {
  return !!(owned && !owned.killed && owned.exitCode == null)
}

async function healthOk(baseUrl, timeoutMs = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal })
    if (!res.ok) return false
    const j = await res.json().catch(() => null)
    return !!(j && j.ok === true)
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

function parseListen(url) {
  const u = new URL(url)
  const host = (u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '')
  const port = String(Number(u.port) || (u.protocol === 'https:' ? 443 : 80))
  return { host, port, base: url.replace(/\/$/, '') }
}

/**
 * Ensure GameBot REST is reachable at url. Spawns `python -m gamebot` (code from root/src,
 * writable data under state) when needed.
 * @param {{ root: string, state: string, python: string, url: string, log?: (line: string) => void }} opts
 */
export async function ensureBodyRunning(opts) {
  const { root, state, python, url, log } = opts
  const { host, port, base } = parseListen(url)

  if (await healthOk(base)) {
    log?.(`GameBot REST 已在线：${base}`)
    return { ok: true, reused: true, url: base }
  }

  if (owned && (owned.killed || owned.exitCode != null)) {
    owned = null
    ownedUrl = ''
  }

  if (!existsSync(join(root, 'src', 'gamebot', '__main__.py')) && !existsSync(join(root, 'src', 'gamebot', 'api', 'app.py'))) {
    throw new Error(`GameBot 包不完整：${join(root, 'src', 'gamebot')}`)
  }
  if (!existsSync(python)) {
    throw new Error(`未找到 Python：${python}`)
  }

  if (bodyOwned() && ownedUrl === base) {
    const ready = await waitHealth(base, 20000, log)
    if (ready) return { ok: true, reused: true, url: base }
    await stopBody()
  } else if (bodyOwned() && ownedUrl !== base) {
    log?.(`GameBot REST 地址已变更（${ownedUrl} → ${base}），正在重启`)
    await stopBody()
  }

  log?.(`正在启动 GameBot REST：${base}`)
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    GAMEBOT_HOST: host === 'localhost' ? '127.0.0.1' : host,
    GAMEBOT_PORT: port,
    GAMEBOT_OPEN_UI: '0',
    GAMEBOT_CONFIG_FILE: process.env.GAMEBOT_CONFIG_FILE || join(state, 'data', 'game-configs.json'),
    GAMEBOT_MEMORY_DIR: process.env.GAMEBOT_MEMORY_DIR || join(state, 'data', 'memory'),
    PYTHONPATH: [join(root, 'src'), process.env.PYTHONPATH].filter(Boolean).join(IS_WIN ? ';' : ':'),
    // 字节码缓存写数据目录，不在包里生成 __pycache__。
    PYTHONPYCACHEPREFIX: join(state, 'pycache'),
  }
  mkdirSync(join(state, 'data'), { recursive: true })
  // cwd = state：GameBot 的相对路径 data/…（outbox 等）都落在数据目录，不写包目录。
  const child = spawn(python, ['-m', 'gamebot'], {
    cwd: state,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  owned = child
  ownedUrl = base
  child.on('exit', (code, signal) => {
    if (owned === child) {
      owned = null
      ownedUrl = ''
    }
    log?.(`GameBot REST 已退出（code=${code}, signal=${signal || ''}）`)
  })
  child.stdout?.on('data', (buf) => {
    const line = String(buf).trimEnd()
    if (line) log?.(`[gamebot] ${line}`)
  })
  child.stderr?.on('data', (buf) => {
    const line = String(buf).trimEnd()
    if (line) log?.(`[gamebot] ${line}`)
  })
  child.on('error', (err) => {
    log?.(`GameBot REST 启动失败：${err.message}`)
    if (owned === child) {
      owned = null
      ownedUrl = ''
    }
  })

  const ready = await waitHealth(base, 25000, log)
  if (!ready) {
    await stopBody()
    throw new Error(`GameBot REST 在 25s 内未就绪：${base}/health`)
  }
  log?.(`GameBot REST 已就绪：${base}`)
  return { ok: true, reused: false, url: base }
}

async function waitHealth(base, budgetMs, log) {
  const start = Date.now()
  let attempt = 0
  while (Date.now() - start < budgetMs) {
    attempt++
    if (await healthOk(base, 1200)) return true
    if (attempt === 1 || attempt % 5 === 0) log?.(`正在等待 GameBot 就绪（${Math.round((Date.now() - start) / 1000)} 秒）`)
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

// ── shared body refcount: one REST body for all per-game components ──────────
const users = new Set()
let inflight = null

/** Mark `user` (component id) as needing the body, and ensure it's running. */
export async function acquireBody(user, opts) {
  users.add(user)
  try {
    inflight ??= ensureBodyRunning(opts).finally(() => { inflight = null })
    return await inflight
  } catch (error) {
    users.delete(user)
    if (!users.size) await stopBody()
    throw error
  }
}

/** Drop `user`; stop our owned body when no game needs it any more (awaits process exit). */
export async function releaseBody(user) {
  users.delete(user)
  if (!users.size) await stopBody()
}

export function bodyUsers() { return [...users] }
