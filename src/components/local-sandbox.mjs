/**
 * Host-side sandbox for local-components: fork isolation + IPC proxy.
 *
 * Why fork (not Worker): in Node, process.exit() inside a Worker terminates the
 * whole process — the same failure mode we are fixing. A forked child can exit
 * or hang without taking down DSH Desktop.
 *
 * Sync ComponentModule methods (launch / installed / note / spec) are exposed as
 * async on the proxy; manager awaits via Promise.resolve so bundled sync modules
 * keep working unchanged.
 */
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginRoot } from '../tools.mjs'

/** Import/discovery budget per local module. */
export const LOCAL_DISCOVER_TIMEOUT_MS = 12_000
/** Default IPC call budget (launch / installed / note / probe / …). */
export const LOCAL_CALL_TIMEOUT_MS = 30_000
/** Install may download packages — generous budget; hang still kills the child. */
export const LOCAL_INSTALL_TIMEOUT_MS = 15 * 60_000

/** @type {Set<LocalComponentChild>} */
const liveChildren = new Set()

function resolveWorkerPath() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'local-loader-worker.mjs'),
    join(pluginRoot(), 'lib', 'local-loader-worker.mjs'),
    join(pluginRoot(), 'src', 'components', 'local-loader-worker.mjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(`dsh-workbench: local-loader-worker.mjs not found (tried: ${candidates.join('; ')})`)
}

function forkEnv() {
  const env = { ...process.env }
  // Electron main: fork(execPath) without this would spawn another GUI process.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function reviveApp(app) {
  if (!app) return null
  let match = app.match
  if (match && match.__regexp) match = new RegExp(match.source, match.flags || '')
  else if (typeof match === 'string') match = new RegExp(match)
  return { name: app.name, exe: app.exe, match }
}

function collectToolNames(tools, serverName) {
  const prefix = `mcp__${serverName}__`
  try {
    const view = tools?.view?.()
    if (view?.visible instanceof Map) {
      return [...view.visible.keys()].filter((n) => typeof n === 'string' && n.startsWith(prefix))
    }
  } catch { /* ignore */ }
  try {
    const list = tools?.schemas?.()
    if (Array.isArray(list)) {
      return list.map((s) => s.name).filter((n) => typeof n === 'string' && n.startsWith(prefix))
    }
  } catch { /* ignore */ }
  return []
}

class LocalComponentChild {
  /**
   * @param {string} entryPath
   * @param {string} dirName
   * @param {((msg: string) => void) | undefined} log
   */
  constructor(entryPath, dirName, log) {
    this.entryPath = entryPath
    this.dirName = dirName
    this.log = log
    this.child = null
    this.manifest = null
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.nextReq = 1
    this.dead = false
    /** @type {null | { task?: any, hooks?: any, tools?: any }} */
    this.hostHandlers = null
  }

  async start(discoverTimeoutMs = LOCAL_DISCOVER_TIMEOUT_MS) {
    const worker = resolveWorkerPath()
    this.child = fork(worker, [], {
      env: forkEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    })
    liveChildren.add(this)

    this.child.stderr?.on('data', (buf) => {
      const text = String(buf).trim()
      if (text) this.log?.(`dsh-workbench: local[${this.dirName}] stderr: ${text}`)
    })
    this.child.on('message', (msg) => { void this.#onMessage(msg) })
    this.child.on('exit', (code, signal) => {
      this.dead = true
      liveChildren.delete(this)
      const err = new Error(`local component "${this.dirName}" child exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })
    this.child.on('error', (error) => {
      this.log?.(`dsh-workbench: local[${this.dirName}] child error: ${error?.message ?? error}`)
    })

    await this.#waitFor('ready', discoverTimeoutMs, 'loader ready')
    this.manifest = await this.#requestLoad(discoverTimeoutMs)
    return this.manifest
  }

  #waitFor(type, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        this.kill(`${label} timeout`)
        reject(new Error(`local component "${this.dirName}": timed out waiting for ${label} (${timeoutMs}ms)`))
      }, timeoutMs)
      const onMsg = (msg) => {
        if (msg?.type === type) { cleanup(); resolve(msg) }
        else if (type === 'ready' && (msg?.type === 'load-ok' || msg?.type === 'load-err')) {
          // ready may have been missed if buffered after load in tests
        }
      }
      const onExit = () => {
        cleanup()
        reject(new Error(`local component "${this.dirName}": child exited before ${label}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.child?.off('message', onMsg)
        this.child?.off('exit', onExit)
      }
      this.child.on('message', onMsg)
      this.child.on('exit', onExit)
    })
  }

  #requestLoad(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        this.kill('discover import timeout')
        reject(new Error(`local component "${this.dirName}": import timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onMsg = (msg) => {
        if (msg?.type === 'load-ok') { cleanup(); resolve(msg.manifest) }
        else if (msg?.type === 'load-err') { cleanup(); reject(new Error(msg.error || 'load failed')) }
      }
      const onExit = () => {
        cleanup()
        reject(new Error(`local component "${this.dirName}": child exited during import (process.exit or crash)`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.child?.off('message', onMsg)
        this.child?.off('exit', onExit)
      }
      this.child.on('message', onMsg)
      this.child.on('exit', onExit)
      try {
        this.child.send({ type: 'load', entryPath: this.entryPath, dirName: this.dirName })
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  async #onMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'call-ok' || msg.type === 'call-err') {
      const p = this.pending.get(msg.reqId)
      if (!p) return
      this.pending.delete(msg.reqId)
      clearTimeout(p.timer)
      if (msg.type === 'call-ok') p.resolve(msg.value)
      else p.reject(new Error(msg.error || 'call failed'))
      return
    }
    if (msg.type === 'host-call' || msg.type === 'host-event') {
      try {
        const value = await this.#handleHost(msg.op, msg.args || {})
        if (msg.type === 'host-call') {
          this.child?.send({ type: 'host-result', reqId: msg.reqId, ok: true, value: value ?? null })
        }
      } catch (error) {
        if (msg.type === 'host-call') {
          this.child?.send({
            type: 'host-result',
            reqId: msg.reqId,
            ok: false,
            error: String(error?.message ?? error),
          })
        }
      }
    }
  }

  async #handleHost(op, args) {
    const h = this.hostHandlers
    if (!h) throw new Error('no host handlers registered for this call')
    switch (op) {
      case 'task.step':
        h.task?.step?.(args.text)
        return null
      case 'task.log':
        h.task?.log?.(args.line)
        return null
      case 'hooks.beforeReplace':
        if (h.hooks?.beforeReplace) await h.hooks.beforeReplace()
        return null
      case 'mcpExecute': {
        const tools = h.tools
        const def = typeof tools?.get === 'function' ? tools.get(args.fullName) : undefined
        if (!def || typeof def.execute !== 'function') {
          throw new Error(`没有注册工具 ${args.fullName}`)
        }
        return await def.execute(args.args || {}, {})
      }
      default:
        throw new Error(`unknown host op: ${op}`)
    }
  }

  /**
   * @param {string} op
   * @param {object} args
   * @param {number} timeoutMs
   * @param {null | { task?: any, hooks?: any, tools?: any }} hostHandlers
   */
  call(op, args, timeoutMs, hostHandlers = null) {
    if (this.dead || !this.child?.connected) {
      return Promise.reject(new Error(`local component "${this.dirName}" child is not running`))
    }
    this.hostHandlers = hostHandlers
    const reqId = this.nextReq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        this.kill(`call ${op} timeout`)
        reject(new Error(`local component "${this.dirName}".${op} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(reqId, { resolve, reject, timer })
      try {
        this.child.send({ type: 'call', reqId, op, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(error)
      }
    }).finally(() => {
      // Clear handlers after the call settles so a late host-event is ignored safely.
      if (this.hostHandlers === hostHandlers) this.hostHandlers = null
    })
  }

  kill(reason) {
    if (!this.child) return
    try { this.child.send({ type: 'shutdown' }) } catch { /* ignore */ }
    try { this.child.kill() } catch { /* ignore */ }
    // Windows may ignore soft kill; force after a short grace.
    const proc = this.child
    setTimeout(() => {
      try { if (proc.exitCode == null) proc.kill('SIGKILL') } catch { /* ignore */ }
    }, 800).unref?.()
    this.dead = true
    liveChildren.delete(this)
    if (reason) this.log?.(`dsh-workbench: killed local child "${this.dirName}": ${reason}`)
  }

  dispose() {
    this.kill('dispose')
  }
}

/**
 * Build a ComponentModule + mod proxy that forwards lifecycle calls to the child.
 * @param {object} manifest
 * @param {LocalComponentChild} child
 * @param {string} dir
 */
export function buildLocalProxy(manifest, child, dir) {
  const app = reviveApp(manifest.app)
  const meta = manifest.meta
    ? { ...manifest.meta, moduleSource: 'local' }
    : { id: manifest.id, moduleSource: 'local' }

  const component = {
    id: manifest.id,
    label: manifest.label,
    url: manifest.url || undefined,
    serverName: manifest.serverName,
    summary: manifest.summary,
    runtime: manifest.runtime || undefined,
    keys: Array.isArray(manifest.keys) ? [...manifest.keys] : [],
    bin: manifest.bin || undefined,
    installArgs: manifest.installArgs || undefined,
    moduleSource: 'local',
    moduleDir: dir,
    /** @param {object} cfg */
    async installed(cfg) {
      return !!(await child.call('installed', { cfg }, LOCAL_CALL_TIMEOUT_MS))
    },
    /** @param {object} cfg */
    async spec(cfg) {
      if (!manifest.hasSpec) return null
      return child.call('spec', { cfg }, LOCAL_CALL_TIMEOUT_MS)
    },
    /** @param {object} cfg */
    async note(cfg) {
      if (!manifest.hasNote) return null
      return child.call('note', { cfg }, LOCAL_CALL_TIMEOUT_MS)
    },
    /** @param {object} cfg */
    async launch(cfg) {
      return child.call('launch', { cfg }, LOCAL_CALL_TIMEOUT_MS)
    },
    async install(cfg, task, hooks) {
      if (!manifest.hasInstall) throw new Error(`${manifest.id} has no install()`)
      return child.call(
        'install',
        {
          cfg,
          taskProxy: task?.proxy || '',
          hooksNpm: hooks?.npm
            ? {
                node: hooks.npm.node,
                cli: hooks.npm.cli,
                npx: hooks.npm.npx,
                source: hooks.npm.source,
                version: hooks.npm.version,
                env: hooks.npm.env || {},
              }
            : null,
        },
        LOCAL_INSTALL_TIMEOUT_MS,
        { task, hooks },
      )
    },
    async beforeRemove(log) {
      if (!manifest.hasBeforeRemove) return
      const task = { log: (line) => log?.(line), step() {} }
      await child.call('beforeRemove', {}, LOCAL_CALL_TIMEOUT_MS, { task })
    },
    async installAddon(cfg, project, opts = {}) {
      if (!manifest.hasInstallAddon) throw new Error(`${manifest.id} has no installAddon()`)
      let procs = null
      try {
        if (typeof opts.procs === 'function') {
          const set = await opts.procs()
          procs = set instanceof Set ? [...set] : Array.isArray(set) ? set : null
        }
      } catch { /* child will list locally */ }
      return child.call(
        'installAddon',
        { cfg, project, opts: {}, procs },
        LOCAL_INSTALL_TIMEOUT_MS,
        { task: { log: opts.log, step() {} } },
      )
    },
  }

  async function probe(ctx) {
    if (!manifest.hasProbe) return null
    let procs = null
    try {
      if (typeof ctx?.procs === 'function') {
        const set = await ctx.procs()
        procs = set instanceof Set ? [...set] : Array.isArray(set) ? set : null
      }
    } catch { /* child lists locally */ }
    const toolNames = collectToolNames(ctx?.tools, component.serverName)
    return child.call(
      'probe',
      { cfg: ctx?.cfg, env: ctx?.env || {}, toolNames, procs },
      LOCAL_CALL_TIMEOUT_MS,
      { tools: ctx?.tools },
    )
  }

  const mod = {
    meta,
    app,
    probe: manifest.hasProbe ? probe : undefined,
    component,
    default: component,
    /** @internal */
    __localChild: child,
  }

  return { component, mod }
}

/**
 * Load one local component entry in a forked child.
 * @param {string} entryPath absolute path to index.mjs
 * @param {string} dirName folder id
 * @param {string} dir absolute module dir
 * @param {{ log?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ component: object, mod: object }>}
 */
export async function loadLocalComponentSandboxed(entryPath, dirName, dir, options = {}) {
  const log = options.log ?? console.warn
  const timeoutMs = options.timeoutMs ?? LOCAL_DISCOVER_TIMEOUT_MS
  const child = new LocalComponentChild(entryPath, dirName, log)
  try {
    const manifest = await child.start(timeoutMs)
    return buildLocalProxy(manifest, child, dir)
  } catch (error) {
    child.dispose()
    throw error
  }
}

/** Kill every live local-component child (plugin dispose / tests). */
export function disposeAllLocalSandboxes() {
  for (const child of [...liveChildren]) child.dispose()
  liveChildren.clear()
}
