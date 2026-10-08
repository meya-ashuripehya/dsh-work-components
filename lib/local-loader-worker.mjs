/**
 * Local-component loader child process.
 *
 * Runs OUTSIDE the DSH Desktop host so top-level process.exit / tight loops /
 * uncaught crashes in local-components/<id>/index.mjs cannot take down the host.
 * Prefer child_process.fork over Worker: in Node, process.exit inside a Worker
 * still exits the whole process.
 *
 * IPC protocol (JSON):
 *   parent → child:
 *     { type: 'load', entryPath, dirName }
 *     { type: 'call', reqId, op, args }
 *     { type: 'host-result', reqId, ok, value?, error? }
 *     { type: 'shutdown' }
 *   child → parent:
 *     { type: 'ready' }
 *     { type: 'load-ok', manifest }
 *     { type: 'load-err', error }
 *     { type: 'call-ok', reqId, value }
 *     { type: 'call-err', reqId, error }
 *     { type: 'host-call', reqId, op, args }   // needs reply
 *     { type: 'host-event', op, args }         // fire-and-forget (task.step/log)
 *
 * Remaining gaps (honest): native addons in the local module still load in this
 * child (not the host), but can still exhaust CPU/memory of the machine; there
 * is no Windows Electron cgroup. Shared Electron / cordis APIs are NOT available
 * here — local modules should keep using shared.mjs / tools.mjs / connect-lib.
 */
import { pathToFileURL } from 'node:url'
import { listProcesses } from '../connect-lib.mjs'

let mod = null
let component = null
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pendingHost = new Map()
let nextHostReq = 1

function send(msg) {
  try { process.send?.(msg) } catch { /* parent gone */ }
}

function serializeApp(app) {
  if (!app) return null
  const match = app.match
  return {
    name: app.name,
    exe: app.exe,
    match: match instanceof RegExp
      ? { __regexp: true, source: match.source, flags: match.flags }
      : (typeof match === 'string' ? { __regexp: true, source: match, flags: '' } : null),
  }
}

function serializeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  return {
    id: meta.id,
    title: meta.title,
    group: meta.group,
    url: meta.url ?? null,
    serverName: meta.serverName,
    summary: meta.summary,
  }
}

function safeJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, reason: 'non-serializable result from local component' }
  }
}

function hostCall(op, args) {
  return new Promise((resolve, reject) => {
    const reqId = nextHostReq++
    pendingHost.set(reqId, { resolve, reject })
    send({ type: 'host-call', reqId, op, args })
  })
}

function hostEvent(op, args) {
  send({ type: 'host-event', op, args })
}

function buildToolsProxy(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames : []
  const visible = new Map(names.map((n) => [n, true]))
  return {
    view: () => ({ visible }),
    schemas: () => names.map((name) => ({ name })),
    get: (fullName) => ({
      execute: async (callArgs = {}) => hostCall('mcpExecute', { fullName, args: callArgs }),
    }),
  }
}

async function handleCall(op, args = {}) {
  if (!component) throw new Error('component not loaded')
  switch (op) {
    case 'launch':
      return component.launch(args.cfg)
    case 'installed':
      return typeof component.installed === 'function' ? !!component.installed(args.cfg) : false
    case 'spec':
      return typeof component.spec === 'function' ? component.spec(args.cfg) : (component.spec ?? null)
    case 'note':
      return typeof component.note === 'function' ? component.note(args.cfg) : null
    case 'install': {
      const task = {
        proxy: args.taskProxy || '',
        step: (text) => hostEvent('task.step', { text: String(text) }),
        log: (line) => hostEvent('task.log', { line: String(line) }),
      }
      const hooks = {
        npm: args.hooksNpm ?? undefined,
        beforeReplace: async () => { await hostCall('hooks.beforeReplace', {}) },
      }
      return await component.install(args.cfg, task, hooks)
    }
    case 'beforeRemove': {
      if (typeof component.beforeRemove !== 'function') return null
      await component.beforeRemove((line) => hostEvent('task.log', { line: String(line) }))
      return null
    }
    case 'installAddon': {
      if (typeof component.installAddon !== 'function') throw new Error('no installAddon')
      const opts = {
        ...(args.opts || {}),
        log: (line) => hostEvent('task.log', { line: String(line) }),
        procs: async () => {
          if (Array.isArray(args.procs)) return new Set(args.procs)
          return listProcesses()
        },
      }
      return await component.installAddon(args.cfg, args.project, opts)
    }
    case 'probe': {
      const probe = mod?.probe
      if (typeof probe !== 'function') return null
      const ctx = {
        cfg: args.cfg,
        env: args.env || {},
        tools: buildToolsProxy(args.toolNames),
        procs: async () => {
          if (Array.isArray(args.procs)) return new Set(args.procs)
          return listProcesses()
        },
      }
      return await probe.call(component, ctx)
    }
    default:
      throw new Error(`unknown op: ${op}`)
  }
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return
  try {
    if (msg.type === 'shutdown') {
      process.exit(0)
      return
    }
    if (msg.type === 'host-result') {
      const p = pendingHost.get(msg.reqId)
      if (!p) return
      pendingHost.delete(msg.reqId)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error || 'host call failed'))
      return
    }
    if (msg.type === 'load') {
      try {
        const href = pathToFileURL(msg.entryPath).href
        mod = await import(href)
        component = mod.component ?? mod.default
        if (!component?.id) {
          send({ type: 'load-err', error: '未导出 component/default' })
          return
        }
        if (msg.dirName && component.id !== msg.dirName) {
          send({
            type: 'load-err',
            error: `folder "${msg.dirName}" 与 component.id "${component.id}" 不一致`,
          })
          return
        }
        const manifest = {
          id: component.id,
          label: component.label,
          url: component.url ?? null,
          serverName: component.serverName,
          summary: component.summary,
          runtime: component.runtime ?? null,
          keys: Array.isArray(component.keys) ? [...component.keys] : [],
          bin: component.bin ?? null,
          installArgs: Array.isArray(component.installArgs) ? [...component.installArgs] : null,
          hasInstall: typeof component.install === 'function',
          hasNote: typeof component.note === 'function',
          hasSpec: typeof component.spec === 'function',
          hasBeforeRemove: typeof component.beforeRemove === 'function',
          hasInstallAddon: typeof component.installAddon === 'function',
          hasProbe: typeof mod.probe === 'function',
          hasApp: !!mod.app,
          meta: serializeMeta(mod.meta),
          app: serializeApp(mod.app),
        }
        send({ type: 'load-ok', manifest })
      } catch (error) {
        send({ type: 'load-err', error: String(error?.message ?? error) })
      }
      return
    }
    if (msg.type === 'call') {
      try {
        const value = await handleCall(msg.op, msg.args || {})
        send({ type: 'call-ok', reqId: msg.reqId, value: safeJson(value) })
      } catch (error) {
        send({ type: 'call-err', reqId: msg.reqId, error: String(error?.message ?? error) })
      }
    }
  } catch (error) {
    if (msg.type === 'load') send({ type: 'load-err', error: String(error?.message ?? error) })
    else if (msg.type === 'call') send({ type: 'call-err', reqId: msg.reqId, error: String(error?.message ?? error) })
  }
})

send({ type: 'ready' })
process.on('disconnect', () => { try { process.exit(0) } catch { /* ignore */ } })
