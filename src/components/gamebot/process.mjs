/**
 * GameBot REST body process lifecycle (owned child only).
 * Spawned when the workbench enables GameBot; stopped on disable / plugin unload.
 * Does not kill an externally started GameBot on the same port.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** @type {import('node:child_process').ChildProcess | null} */
let owned = null
/** Base URL we last started (no trailing slash). */
let ownedUrl = ''
let exitHooked = false

function hookExit() {
  if (exitHooked) return
  exitHooked = true
  const bye = () => { try { stopBodySync() } catch {} }
  process.once('exit', bye)
  process.once('SIGTERM', bye)
  process.once('SIGINT', bye)
}

function stopBodySync() {
  const child = owned
  owned = null
  ownedUrl = ''
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch {}
}

/** Stop the REST body we started (no-op if we never owned one). */
export async function stopBody() {
  stopBodySync()
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
 * Ensure GameBot REST is reachable at url. Spawns `python -m gamebot` under root when needed.
 * @param {{ root: string, python: string, url: string, log?: (line: string) => void }} opts
 */
export async function ensureBodyRunning(opts) {
  const { root, python, url, log } = opts
  const { host, port, base } = parseListen(url)
  hookExit()

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
    throw new Error(`找不到 Python：${python}`)
  }

  if (bodyOwned() && ownedUrl === base) {
    const ready = await waitHealth(base, 20000, log)
    if (ready) return { ok: true, reused: true, url: base }
    stopBodySync()
  } else if (bodyOwned() && ownedUrl !== base) {
    log?.(`GameBot REST 地址变更（${ownedUrl} → ${base}），重启 body`)
    stopBodySync()
  }

  log?.(`启动 GameBot REST：${base}（python -m gamebot）`)
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    GAMEBOT_HOST: host === 'localhost' ? '127.0.0.1' : host,
    GAMEBOT_PORT: port,
    GAMEBOT_OPEN_UI: '0',
    GAMEBOT_CONFIG_FILE: process.env.GAMEBOT_CONFIG_FILE || join(root, 'data', 'game-configs.json'),
  }
  const child = spawn(python, ['-m', 'gamebot'], {
    cwd: root,
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
    stopBodySync()
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
    if (attempt === 1 || attempt % 5 === 0) log?.(`等待 GameBot /health…（${Math.round((Date.now() - start) / 1000)}s）`)
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
    if (!users.size) stopBodySync()
    throw error
  }
}

/** Drop `user`; stop our owned body when no game needs it any more. */
export async function releaseBody(user) {
  users.delete(user)
  if (!users.size) stopBodySync()
}

export function bodyUsers() { return [...users] }
