/**
 * 组件运行时管理：挂载 dsh-mcp-client、串行安装队列、「已连接」探测调度、list/install/uninstall API。
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  attachConsole, CANCELLED_TEXT, currentAbortSignal, installNode, installUv, isCancelled, killInstallProcesses, managedPaths, readMarker,
  removeDir, removeInstallLeftovers, withAbortSignal,
} from '../tools.mjs'
import { PROBE_TTL_MS, defaultEnv, probeComponent } from '../connect.mjs'
import { SOURCE_TEXT, resolveNode, resolveNpm, resolveUv } from './shared.mjs'
import { COMPONENTS, componentById, contributeInfo, localComponentsDir, CONTRIBUTE_COMPARE_URL, disposeLocalComponents } from './registry.mjs'

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const LOG_KEEP = 400
const LOG_SHOW = 80

/** 启动门控提示：需要安装的组件在安装完成前不会启动。 */
export const LAUNCH_BLOCK_INSTALLING = '正在安装：安装完成后可启动'
export const LAUNCH_BLOCK_NOT_INSTALLED = '未安装：安装完成后可启动'
/** 状态行正文（客户端会在前面加「未安装：」「未启动：」等状态标签，这里不再重复标签）。 */
const DETAIL_NOT_INSTALLED = '安装完成后可启动'
const DETAIL_INSTALLING = '正在安装，安装完成后可启动'
const STATUS_LABEL = { connected: '已连接', on: '已启动', off: '未启动', error: '出错', missing: '未安装', ready: '可用' }

/** 去掉正文开头与状态标签重复的「<标签>：」，避免显示成「未安装：未安装：…」。 */
export function stripStatusLabel(status, detail) {
  const label = STATUS_LABEL[status]
  const text = String(detail ?? '')
  if (!label) return text
  const m = text.match(new RegExp(`^${label}\\s*[：:]\\s*`))
  return m ? text.slice(m[0].length) : text
}

/**
 * 组件启动前是否必须先完成「下载安装」。
 * builtin 组件（如 GameBot，首次启用时自行准备环境）和没有 install() 的组件不需要；
 * 组件可用 needsInstall(cfg) 声明当前设置下无需安装（远程 / HTTP 模式、设置中指定的路径等）。
 */
export function needsInstall(component, cfg) {
  if (!component || component.builtin) return false
  if (typeof component.needsInstall === 'function') {
    try { return !!component.needsInstall(cfg) } catch { return true }
  }
  return typeof component.install === 'function'
}

function idleInstall() {
  // dependsOn：正在等待的依赖安装（'uv' / 'node'），期间进度与控制台行取自该依赖的任务。
  // cancelling：已请求取消（「正在取消」），等子进程退出、清理文件后回到 idle。
  return { state: 'idle', step: '', log: [], live: '', error: null, startedAt: null, finishedAt: null, dependsOn: null, cancelling: false, percent: null }
}

const CANCELLING_TEXT = '正在取消'

const DEP_LABEL = { uv: 'uv', node: 'Node.js' }

/**
 * 管理所有组件的挂载与安装。getConfig 返回当前设置；每次 sync() 只重挂设置键变化了的组件。
 * 安装串行排队（共用 tools/python 和 uv 缓存），同一组件不能重复排队；装完自动重挂该组件。
 */
export function createComponentManager(ctx, getConfig, options = {}) {
  const state = new Map(COMPONENTS.map((c) => [c.id, { key: null, fork: null, status: 'off', detail: '尚未启动', command: null, source: null, generation: 0, rev: 0, suspended: false }]))
  // 「已连接」探测结果，按组件记；gen 对不上 state.generation（组件重挂 / 停掉过）就作废。
  const conns = new Map(COMPONENTS.map((c) => [c.id, { gen: -1, state: 'checking', detail: '正在检查连接', via: null, checkedAt: 0, inflight: null }]))
  const probeEnv = { ...defaultEnv, ...(options.probeEnv ?? {}) }
  const installs = new Map(['uv', 'node', ...COMPONENTS.map((c) => c.id)].map((id) => [id, idleInstall()]))
  let queue = Promise.resolve()
  let mcpClient = null
  let disposed = false
  const addonBusy = new Set() // 正在「安装插件到项目」的组件

  async function loadMcpClient() {
    if (mcpClient) return mcpClient
    const loader = ctx.get('loader')
    if (!loader || typeof loader.import !== 'function') throw new Error('宿主没有 loader 服务，无法挂载 dsh-mcp-client')
    const mod = await loader.import('@deepseek-ai/dsh-mcp-client')
    mcpClient = typeof loader.unwrapExports === 'function' ? loader.unwrapExports(mod) : (mod.default ?? mod)
    return mcpClient
  }

  function stop(s) {
    s.generation++
    try { s.fork?.dispose?.() } catch {}
    s.fork = null
    s.command = null
  }

  /**
   * 启动门控：需要安装的组件在安装完成（installed 为真且没有进行中的安装任务）之前不允许启动。
   * 返回 null 表示可以启动，否则返回 { missing, reason }。
   */
  async function launchBlock(component, cfg, known) {
    const job = installs.get(component.id)
    if (job && (job.state === 'installing' || job.state === 'queued')) return { missing: false, reason: LAUNCH_BLOCK_INSTALLING }
    if (!needsInstall(component, cfg)) return null
    let installed = known
    if (installed === undefined) {
      installed = false
      try {
        const raw = component.installed(cfg)
        installed = !!(typeof raw?.then === 'function' ? await raw : raw)
      } catch {}
    }
    return installed ? null : { missing: true, reason: LAUNCH_BLOCK_NOT_INSTALLED }
  }

  async function syncOne(component) {
    const s = state.get(component.id)
    if (s.suspended || disposed) return
    const cfg = getConfig()
    const key = JSON.stringify([s.rev, ...component.keys.map((k) => cfg[k])])
    if (key === s.key) return
    s.key = key
    stop(s)
    const generation = s.generation
    // 已启用但未安装 / 正在安装：不启动（status 记为 missing / off，安装完成后 resume 会重新同步）。
    if (cfg[`${component.id}Enabled`] === true) {
      const block = await launchBlock(component, cfg)
      if (generation !== s.generation) return
      if (block) {
        s.status = block.missing ? 'missing' : 'off'
        s.detail = block.missing ? DETAIL_NOT_INSTALLED : DETAIL_INSTALLING
        s.source = null
        return
      }
    }
    let plan
    try {
      const raw = component.launch(cfg)
      plan = typeof raw?.then === 'function' ? await raw : raw
    } catch (error) { plan = { ok: false, reason: String(error?.message ?? error) } }
    if (!plan.ok) {
      s.status = plan.missing ? 'missing' : 'off'
      s.detail = plan.reason
      s.source = null
      return
    }
    try {
      const plugin = await loadMcpClient()
      if (generation !== s.generation) return
      s.fork = ctx.plugin(plugin, plan.config)
      s.status = 'on'
      s.source = plan.source
      s.command = plan.config.transport === 'streamable-http' ? plan.config.url : [plan.config.command, ...plan.config.args].join(' ')
      const via = plan.via ?? (plan.viaUvx ? 'uvx' : null)
      const how = plan.source === 'remote'
        ? `连接 ${plan.config.url}`
        : via ? `${SOURCE_TEXT[plan.source]}的 ${via} 临时运行` : SOURCE_TEXT[plan.source] + (plan.runtime ? `，${plan.runtime}` : '')
      s.detail = `已挂载（${how}），工具名前缀 mcp__${component.serverName}__`
    } catch (error) {
      if (generation !== s.generation) return
      s.status = 'error'
      s.detail = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-workbench: failed to start ${component.id}`, error)
    }
  }

  /** 停掉组件并暂停同步（安装时替换文件前调用），等子进程退出释放文件。 */
  async function suspend(id, detail = '正在安装，完成后自动重新挂载') {
    const s = state.get(id)
    if (!s) return
    const wasRunning = !!s.fork
    s.suspended = true
    stop(s)
    s.key = null
    s.status = 'off'
    s.detail = detail
    if (wasRunning) await delay(1500)
  }

  async function resume(id) {
    const s = state.get(id)
    if (!s) return
    s.suspended = false
    s.key = null
    s.rev++
    await syncOne(componentById(id))
  }

  /** 正在用 dir 里的程序运行的组件（替换 / 删除 tools/uv、tools/node 前要先停）。 */
  function componentsUsing(dir) {
    const d = dir.toLowerCase()
    return COMPONENTS.filter((c) => state.get(c.id).command?.toLowerCase().startsWith(d)).map((c) => c.id)
  }
  const componentsUsingManagedUv = () => componentsUsing(dirname(managedPaths().uv))
  const componentsUsingManagedNode = () => componentsUsing(managedPaths().node)

  function makeTask(job, proxy) {
    const consoleOut = attachConsole(job)
    const pushLog = (line) => {
      job.log.push(String(line))
      if (job.log.length > LOG_KEEP) job.log.splice(0, job.log.length - LOG_KEEP)
    }
    return {
      proxy: proxy || '',
      step(text) { job.step = text },
      log: pushLog,
      /** 子进程最新一行，不进日志。没有字节进度时 percent 为空，客户端整行用流光。 */
      live(line) { job.percent = null; consoleOut.live(line) },
      /** 下载字节进度，只刷新 live。percent 为 0–100；未知总长时为 null。 */
      progress(line, percent) {
        job.percent = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null
        consoleOut.progress(line)
      },
      /** 失败：把最近的控制台行追加进日志，并清掉 live。 */
      dumpConsole() { consoleOut.dump() },
      clearConsole() { consoleOut.clear() },
    }
  }

  /**
   * 下载前置工具（uv / Node.js）到 tools/，进度记在 job 上；失败时抛错（错误已记进 job）。
   * 被取消时（自身被取消，或作为依赖时发起它的组件被取消）删除这次下载的临时文件，任务回到 idle 后抛出取消错误；
   * tools/uv、tools/node 本身只在取消的就是 uv / Node.js 任务时由 runPrereqJob 删除。
   */
  async function runPrereqInstall(id, job, cfg, installer) {
    job.state = 'installing'
    job.startedAt ??= Date.now()
    const task = makeTask(job, cfg.proxy)
    try {
      await installer(task)
      job.state = 'done'
      job.step = '安装完成'
      task.log('安装完成')
    } catch (error) {
      if (isCancelled(error)) {
        task.clearConsole()
        try { await removeInstallLeftovers(id) } catch {}
        task.log(CANCELLED_TEXT)
        Object.assign(job, { state: 'idle', step: '', live: '', error: null, cancelling: false })
        throw error
      }
      job.state = 'error'
      job.error = String(error?.message ?? error)
      job.step = '安装失败'
      task.log(`错误：${job.error}`)
      task.dumpConsole()
      throw error
    } finally {
      if (job.state === 'done') task.clearConsole()
      job.finishedAt = Date.now()
    }
  }

  const runUvInstall = (job, cfg) => runPrereqInstall('uv', job, cfg, (task) => installUv(task))
  // Node.js：替换 tools/node 前先停掉正在用它的组件（只有在 beforeReplace 时才停，下载期间组件照常运行）。
  function runNodeInstall(job, cfg) {
    let users = []
    const done = runPrereqInstall('node', job, cfg, (task) => installNode(task, {
      beforeReplace: async () => {
        users = componentsUsingManagedNode()
        for (const u of users) await suspend(u, '正在更新 Node.js，完成后自动重新挂载')
      },
    }))
    return done.finally(async () => { for (const u of users) await resume(u) })
  }

  async function runPrereqJob(id, job) {
    const cfg = getConfig()
    const users = id === 'uv' ? componentsUsingManagedUv() : []
    for (const u of users) await suspend(u, '正在更新 uv，完成后自动重新挂载')
    try {
      await (id === 'uv' ? runUvInstall(job, cfg) : runNodeInstall(job, cfg))
    } catch (error) {
      // 取消的就是 uv / Node.js 本身：连同 tools/uv、tools/node 一并删除（先停掉正在用它的组件）。
      if (isCancelled(error)) await removePrereqDir(id, job)
      else ctx.logger?.warn?.(`dsh-workbench: install ${id} failed`, error)
    } finally {
      for (const u of users) await resume(u)
    }
    // uv / Node 到位后，之前「未安装」的组件可以用 uvx / npx 回退启动了。
    for (const c of COMPONENTS) if (state.get(c.id).status === 'missing') await resume(c.id)
  }

  /** 删除 tools/uv 或 tools/node（取消 uv / Node.js 任务时）。 */
  async function removePrereqDir(id, job) {
    const m = managedPaths()
    const dir = id === 'uv' ? dirname(m.uv) : m.node
    const users = id === 'uv' ? componentsUsingManagedUv() : componentsUsingManagedNode()
    for (const u of users) await suspend(u, '正在取消下载')
    try {
      await removeDir(dir)
      job.log.push(`已删除 ${dir}`)
    } catch (error) {
      job.log.push(`未能删除 ${dir}：${error.message}`)
    } finally {
      for (const u of users) await resume(u)
    }
  }

  /** 删除组件在 tools/ 里的安装目录和临时文件；partialOnly 时已安装完整的目录保留（排队中取消）。 */
  async function removeComponentFiles(id, job, { partialOnly = false } = {}) {
    const m = managedPaths()
    const component = componentById(id)
    let installed = false
    if (partialOnly) {
      try {
        const raw = component.installed(getConfig())
        installed = !!(typeof raw?.then === 'function' ? await raw : raw)
      } catch {}
    }
    try { await removeInstallLeftovers(id) } catch {}
    if (installed) return
    const dir = id === 'office' ? m.officeRepo : m.dir(id)
    if (!existsSync(dir)) return
    try {
      await component?.beforeRemove?.((line) => ctx.logger?.info?.(`dsh-workbench: ${line}`))
      await removeDir(dir)
      job.log.push(`已删除 ${dir}`)
    } catch (error) {
      job.log.push(`未能删除 ${dir}：${error.message}`)
    }
  }

  /** 组件安装被取消：停掉组件、删除它的工具目录与临时文件，任务回到 idle（卡片显示「未安装」）。 */
  async function finishCancelled(id, job, { partialOnly = false } = {}) {
    job.step = CANCELLING_TEXT
    job.live = ''
    if (!partialOnly) await suspend(id, '正在取消下载')
    try {
      await removeComponentFiles(id, job, { partialOnly })
    } finally {
      job.log.push(CANCELLED_TEXT)
      Object.assign(job, { state: 'idle', step: '', live: '', error: null, dependsOn: null, cancelling: false, finishedAt: Date.now() })
      if (!partialOnly) await resume(id)
    }
  }

  async function runInstall(id, job) {
    if (disposed) return
    if (id === 'uv' || id === 'node') return runPrereqJob(id, job)
    const cfg = getConfig()
    const component = componentById(id)
    job.state = 'installing'
    job.startedAt = Date.now()
    const task = makeTask(job, cfg.proxy)
    let suspended = false
    let ok = false
    let cancelled = false
    const hooks = { beforeReplace: async () => { suspended = true; await suspend(id) } }
    try {
      if (component.runtime === 'node') {
        let npm = resolveNpm(cfg)
        if (!npm) {
          task.step('正在下载依赖：Node.js')
          task.log('未检测到可用的 Node.js 20.19+ / 22.12+（含 npm），正在下载依赖：Node.js')
          const nodeJob = installs.get('node')
          Object.assign(nodeJob, idleInstall(), { state: 'installing', step: '正在作为依赖安装', startedAt: Date.now() })
          job.dependsOn = 'node'
          try { await runNodeInstall(nodeJob, cfg) } catch (error) { throw new Error(`依赖安装失败（Node.js）：${error.message}`) } finally { job.dependsOn = null }
          npm = resolveNpm(cfg)
          if (!npm) throw new Error('Node.js 已安装，但未找到 npm')
          task.log('依赖就绪：Node.js')
        }
        task.log(`使用 npm：${SOURCE_TEXT[npm.source]} ${npm.node}（Node ${npm.version}）`)
        hooks.npm = npm
      } else if (!existsSync(managedPaths().uv)) {
        task.step('正在下载依赖：uv')
        task.log('未检测到 uv，正在下载依赖：uv')
        const uvJob = installs.get('uv')
        Object.assign(uvJob, idleInstall(), { state: 'installing', step: '正在作为依赖安装', startedAt: Date.now() })
        job.dependsOn = 'uv'
        try { await runUvInstall(uvJob, cfg) } catch (error) { throw new Error(`依赖安装失败（uv）：${error.message}`) } finally { job.dependsOn = null }
        task.log('依赖就绪：uv')
      }
      await component.install(cfg, task, hooks)
      ok = true
      task.log('安装完成')
    } catch (error) {
      if (isCancelled(error)) cancelled = true
      else {
        ctx.logger?.warn?.(`dsh-workbench: install ${id} failed`, error)
        job.state = 'error'
        job.error = String(error?.message ?? error)
        job.step = '安装失败'
        task.log(`错误：${job.error}`)
        task.dumpConsole()
      }
    }
    // 安装结束的同时收到取消：同样按取消处理（删除这次装的文件）。
    if (currentAbortSignal()?.aborted) cancelled = true
    if (cancelled) {
      task.clearConsole()
      await finishCancelled(id, job)
      return
    }
    // 装好（或替换过文件）后重挂这个组件：设置里启用着就会改用 tools/ 里的新安装启动。
    // 先标记安装完成，启动门控才会放行这次重新挂载。
    if (ok) {
      job.state = 'done'
      job.step = '安装完成'
      task.clearConsole()
    }
    job.finishedAt = Date.now()
    if (ok || suspended) await resume(id)
    // 其他组件可能共用刚装好的文件（如 Notion / Cloudflare 共用 mcp-remote），之前「未安装」的一并重新同步。
    if (ok) for (const c of COMPONENTS) if (c.id !== id && state.get(c.id).status === 'missing') await resume(c.id)
  }

  function checkId(id) {
    if (!installs.has(id)) throw httpError(404, `未知组件：${id}`)
    const job = installs.get(id)
    if (job.state === 'installing' || job.state === 'queued') throw httpError(409, `${id} 正在安装，请在安装完成后重试`)
    return job
  }

  function publicInstall(id) {
    const j = installs.get(id)
    const busy = j.state === 'installing' || j.state === 'queued'
    let step = j.step
    let live = busy ? (j.live || '') : ''
    // 正在下载 / 安装依赖（uv、Node.js）时，进度和控制台行跟随依赖任务，与依赖卡片显示一致。
    const dep = busy && j.dependsOn && !j.cancelling ? installs.get(j.dependsOn) : null
    if (dep && (dep.state === 'installing' || dep.state === 'queued')) {
      const label = DEP_LABEL[j.dependsOn] || j.dependsOn
      if (dep.step && dep.step !== '正在作为依赖安装') step = `依赖 ${label}：${dep.step}`
      live = dep.live || live
    }
    let percent = busy ? (j.percent ?? null) : null
    if (dep && (dep.state === 'installing' || dep.state === 'queued') && dep.live) percent = dep.percent ?? null
    if (j.cancelling) { step = CANCELLING_TEXT; live = ''; percent = null }
    return { state: j.state, step, log: j.log.slice(-LOG_SHOW), live, percent, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt, cancelling: !!j.cancelling }
  }

  async function describe(id) {
    return (await api.list()).find((c) => c.id === id)
  }

  /** 当前代的探测记录（组件重挂过就换一条新的「正在检查」）。 */
  function connOf(id) {
    const s = state.get(id)
    let c = conns.get(id)
    if (c.gen !== s.generation) {
      c = { gen: s.generation, state: 'checking', detail: '正在检查连接', via: null, checkedAt: 0, inflight: null }
      conns.set(id, c)
    }
    return c
  }

  function startProbe(component, c, round) {
    const s = state.get(component.id)
    const gen = s.generation
    const prev = c.state
    c.inflight = probeComponent(component, round).then((r) => {
      if (!r || disposed || state.get(component.id).generation !== gen || conns.get(component.id) !== c) return
      // 工具调用超时（服务器可能正忙着执行模型的调用）时，上一次是已连接就先保持，下次再查。
      if (r.timeout && prev === 'connected') r = { ...r, state: 'connected', detail: `${c.detail.replace(/（最近一次检查超时，可能正忙）$/, '')}（最近一次检查超时，可能正忙）` }
      c.state = r.state
      c.detail = r.detail
      c.via = r.via
    }).catch(() => {}).finally(() => {
      c.checkedAt = Date.now()
      c.inflight = null
    })
    return c.inflight
  }

  const api = {
    sync: () => Promise.all(COMPONENTS.map(syncOne)),

    /**
     * 设置补丁里把组件从未启用改为启用时，检查启动门控；被拦下时返回错误文本（否则 null）。
     * prev / next 为应用补丁前后的设置。
     */
    async enableBlocked(prev, next) {
      for (const c of COMPONENTS) {
        const k = `${c.id}Enabled`
        if (next[k] !== true || prev[k] === true) continue
        const block = await launchBlock(c, next)
        if (block) return `无法启用「${c.label}」：${block.reason}`
      }
      return null
    },

    /**
     * 探测已启动组件的连接（结果缓存 PROBE_TTL_MS，同一组件不会并发探测）。
     * 一轮探测共用一次进程列表。waitMs：最多等这么久就返回（探测照常在后台跑完，下次 list() 就能看到）。
     */
    refreshConnections({ force = false, waitMs } = {}) {
      if (disposed) return Promise.resolve()
      const cfg = getConfig()
      let procs = null
      const round = {
        cfg,
        tools: typeof ctx.get === 'function' ? (ctx.get('tools') ?? ctx.tools) : ctx.tools,
        env: probeEnv,
        procs: () => (procs ??= Promise.resolve().then(() => probeEnv.processes()).catch(() => new Set())),
      }
      const now = Date.now()
      const pending = []
      for (const c of COMPONENTS) {
        const s = state.get(c.id)
        if (s.status !== 'on' || !s.fork) continue
        const conn = connOf(c.id)
        if (conn.inflight) pending.push(conn.inflight)
        else if (force || now - conn.checkedAt >= PROBE_TTL_MS) pending.push(startProbe(c, conn, round))
      }
      const all = Promise.all(pending).then(() => {})
      if (!waitMs) return all
      return Promise.race([all, new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.() })])
    },

    dispose() {
      disposed = true
      killInstallProcesses()
      for (const s of state.values()) stop(s)
      try { disposeLocalComponents() } catch {}
    },

    /** 排队安装（或重新安装）；立刻返回，进度看 list() 里的 install 字段。done 是完成时 resolve 的 Promise。 */
    async install(id) {
      const job = checkId(id)
      // 每次排队一个独立的 AbortController：取消只影响这一次安装；排队中取消时轮到它会直接跳过。
      const ctrl = new AbortController()
      Object.assign(job, idleInstall(), { state: 'queued', step: '排队中' })
      job.ctrl = ctrl
      const done = queue.then(() => (ctrl.signal.aborted || disposed ? undefined : withAbortSignal(ctrl.signal, () => runInstall(id, job))))
      queue = done.catch(() => {})
      return { component: await describe(id), done }
    },

    /**
     * 取消下载：正在安装的结束它的子进程树（含为它下载的 uv / Node.js），删除它的工具目录和临时文件；
     * 排队中的移出队列，只删除未装完的残留，不影响正在为其他组件运行的安装。
     */
    async cancel(id) {
      if (!installs.has(id)) throw httpError(404, `未知组件：${id}`)
      const job = installs.get(id)
      if (job.state !== 'installing' && job.state !== 'queued') throw httpError(409, '当前没有进行中的下载')
      if (job.cancelling) return describe(id)
      const queued = job.state === 'queued'
      job.cancelling = true
      job.step = CANCELLING_TEXT
      job.ctrl?.abort()
      if (queued) {
        // 还没开始运行：队列轮到它时会跳过，这里直接清理残留。
        if (id === 'uv' || id === 'node') {
          try { await removeInstallLeftovers(id) } catch {}
          job.log.push(CANCELLED_TEXT)
          Object.assign(job, { state: 'idle', step: '', live: '', error: null, cancelling: false, finishedAt: Date.now() })
        } else {
          await finishCancelled(id, job, { partialOnly: true })
        }
      }
      return describe(id)
    },

    /** 删除插件 tools/ 里的安装（共享的 tools/python 与缓存保留）。 */
    async uninstall(id) {
      const job = checkId(id)
      const m = managedPaths()
      if (id === 'uv') {
        const users = componentsUsingManagedUv()
        for (const u of users) await suspend(u, '正在删除 uv')
        try { await removeDir(dirname(m.uv)) } finally { for (const u of users) await resume(u) }
      } else if (id === 'node') {
        const users = componentsUsingManagedNode()
        for (const u of users) await suspend(u, '正在删除 Node.js')
        try { await removeDir(m.node) } finally { for (const u of users) await resume(u) }
      } else {
        await suspend(id, '正在卸载')
        try {
          await componentById(id)?.beforeRemove?.((line) => ctx.logger?.info?.(`dsh-workbench: ${line}`))
          await removeDir(id === 'office' ? m.officeRepo : m.dir(id))
        } finally { await resume(id) }
      }
      Object.assign(job, idleInstall(), { step: '已卸载', finishedAt: Date.now() })
      return describe(id)
    },

    /**
     * 组件自带的「装进项目」动作（目前只有 Godot：把同版本插件装进 Godot 项目的 addons/godot_ai）。
     * 返回 { action: installed / replaced / same, target, version, message, … }；参数不对抛带 status 的错误。
     */
    async installAddon(id, project) {
      const component = componentById(id)
      if (!component?.installAddon) throw httpError(404, `${id} 不支持安装插件到项目`)
      const job = installs.get(id)
      if (job.state === 'installing' || job.state === 'queued') throw httpError(409, `${id} 正在安装，请在安装完成后重试`)
      if (addonBusy.has(id)) throw httpError(409, '「安装插件到项目」正在进行，请稍后重试')
      addonBusy.add(id)
      try {
        return await component.installAddon(getConfig(), project, {
          procs: () => probeEnv.processes(),
          log: (line) => ctx.logger?.info?.(`dsh-workbench: ${line}`),
        })
      } finally {
        addonBusy.delete(id)
      }
    },

    /** 完整安装日志（list() 里只带最后 80 行）。 */
    installLog(id) { return installs.get(id)?.log ?? [] },

    /** 本地组件贡献说明（bundled 返回 null）。 */
    contribute(id) {
      return contributeInfo(id)
    },

    localComponentsDir() {
      return localComponentsDir()
    },

    contributeCompareUrl() {
      return CONTRIBUTE_COMPARE_URL
    },



    async list() {
      const cfg = getConfig()
      const m = managedPaths()
      const uv = resolveUv(cfg)
      const uvMarker = readMarker(dirname(m.uv))
      const uvItem = {
        id: 'uv',
        label: 'uv',
        url: 'https://github.com/astral-sh/uv',
        kind: 'prerequisite',
        summary: 'Python 包管理器，用于安装和运行 Office / Blender / Unity / Godot 等组件；安装这些组件时将自动下载。',
        enabled: true,
        installed: existsSync(m.uv),
        status: uv ? 'ready' : 'missing',
        source: uv?.source ?? null,
        detail: uv
          ? `${SOURCE_TEXT[uv.source]}：${uv.path}${uv.source === 'managed' && uvMarker?.version ? `（${uvMarker.version}）` : ''}`
          : '未安装。安装 Office / Blender / Unity / Godot 等组件时将自动下载，也可点击「下载安装」',
        command: uv?.path ?? null,
        install: publicInstall('uv'),
      }
      const node = resolveNode(cfg)
      const npm = resolveNpm(cfg)
      const nodeItem = {
        id: 'node',
        label: 'Node.js',
        url: 'https://nodejs.org/',
        kind: 'prerequisite',
        summary: '用于运行和安装 Chrome / Figma / Photoshop 等 npm 组件；系统中没有带 npm 的 Node.js 时，安装这些组件将自动下载 Node.js。',
        enabled: true,
        installed: existsSync(m.nodeExe),
        status: npm || node ? 'ready' : 'missing',
        source: npm?.source ?? node?.source ?? null,
        detail: npm
          ? `${SOURCE_TEXT[npm.source]}：${npm.node}（${npm.version}，带 npm）`
          : node
            ? `${SOURCE_TEXT[node.source]}：${node.path}（${node.version}）可运行组件，但缺少 npm；安装 npm 组件时将自动下载 Node.js`
            : '未检测到 Node.js 20.19+ / 22.12+。安装 npm 组件时将自动下载，也可点击「下载安装」',
        command: npm?.node ?? node?.path ?? null,
        install: publicInstall('node'),
      }
      const componentItems = await Promise.all(COMPONENTS.map(async (c) => {
        const s = state.get(c.id)
        let installed = false
        try {
          const raw = c.installed(cfg)
          installed = !!(typeof raw?.then === 'function' ? await raw : raw)
        } catch {}
        let note = null
        try {
          if (c.note) {
            const raw = c.note(cfg)
            note = typeof raw?.then === 'function' ? await raw : raw
          }
        } catch {}
        const version = installed && c.id !== 'office' ? (readMarker(m.dir(c.id))?.version || null) : null
        // 已启动的组件带上连接探测结果；探测到已连接时 status 升为 connected（已连接 > 已启动 > 已安装 / 未安装）。
        let connection = null
        if (s.status === 'on') {
          const conn = connOf(c.id)
          connection = { state: conn.state, detail: conn.detail, via: conn.via, checkedAt: conn.checkedAt || null }
        }
        const enabledKey = `${c.id}Enabled`
        const enabled = Object.prototype.hasOwnProperty.call(cfg, enabledKey) ? !!cfg[enabledKey] : false
        const block = await launchBlock(c, cfg, installed)
        // 未启用的组件不会走到 launch 门控，s.status 停在 off；需要安装但未安装时应显示「未安装」而不是「未启动」。
        let status = s.status === 'on' && connection?.state === 'connected' ? 'connected' : s.status
        let detail = s.detail
        if (status === 'off' && block?.missing) { status = 'missing'; detail = DETAIL_NOT_INSTALLED }
        detail = stripStatusLabel(status, detail)
        return {
          id: c.id,
          label: c.label,
          url: c.url || null,
          kind: 'component',
          summary: c.summary,
          serverName: c.serverName,
          moduleSource: c.moduleSource === 'local' ? 'local' : 'bundled',
          moduleDir: c.moduleDir || null,
          enabled,
          installed,
          builtin: !!c.builtin,
          needsInstall: needsInstall(c, cfg),
          // 非 null 时客户端禁用启用开关（仍允许关闭），文本作为提示。
          launchBlocked: block ? block.reason : null,
          status,
          source: s.source,
          detail,
          command: s.command,
          connection,
          version,
          note,
          install: publicInstall(c.id),
        }
      }))
      return [uvItem, nodeItem, ...componentItems]
    },
  }
  return api
}

