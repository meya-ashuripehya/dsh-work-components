/**
 * 聊天室里的施工工具。调用者只来自席位。后台循环不经过聊天室调度。
 */
import { readFileSync } from 'node:fs'
import { defineTool } from '../../../../vendor/dsh-tools/schema.js'
import { AGENT_ID, memberIdsFor } from '../members.mjs'
import { assignMembers } from './assign.mjs'
import { authorize } from './auth.mjs'
import { claimWork } from './schedule.mjs'
import { continueTask } from './checkpoints.mjs'
import { decideConflict } from './conflicts.mjs'
import { addNote, requestStop, controlStateToken, controlTokensMatch } from './control.mjs'
import { applyTickWorkState, mergeCommittedWorkState } from './execute.mjs'
import { rebuildProgressFromWorld } from './reconcile.mjs'
import { runUntilPause, step } from './loop.mjs'
import { preview } from './preview.mjs'
import { createProject, publicView } from './project.mjs'
import { resolveUnknown } from './slots.mjs'
import { createStore, ensureClaimKey, workDir } from './store.mjs'
import { expand } from './blueprint.mjs'
import { posKey } from './model.mjs'
import { reserve } from './materials.mjs'

export const WORK_TOOLS = [
  'mc_blueprint_submit',
  'mc_blueprint_preview',
  'mc_task_claim',
  'mc_task_continue',
  'mc_work_stop',
  'mc_work_status',
  'mc_conflict_decide',
  'mc_material_claim',
  'mc_work_resolve',
]

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function requireMember(exec, cfg) {
  const memberId = String(exec?.game?.caller?.memberId || '').trim()
  if (!memberId) throw new Error('仅限聊天室成员')
  if (!AGENT_ID.test(memberId)) throw new Error('席位 id 不能作为 Minecraft NPC id（只允许小写字母、数字、连字符，最长 32）')
  const seats = Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats : []
  const seat = seats.find((item) => item && item.id === memberId)
  if (!seat || seat.enabled === false) throw new Error('这个席位没有启用')
  if (!memberIdsFor(cfg).includes(memberId)) throw new Error('该席位不在绑定聊天室的成员名单中（请在「聊天室」中把该席位加入绑定房间，或在「席位管理」中启用）')
  return memberId
}

function rejectForeign(args, memberId) {
  for (const label of ['agent_id', 'member_id']) {
    if (args?.[label] != null && args[label] !== '' && String(args[label]) !== memberId) {
      throw new Error(`不能代其他成员操作（${label}）`)
    }
  }
}

function worldFrom(initialSnapshot, act, { memberId = null, reloadObservation = null } = {}) {
  let snapshot = initialSnapshot
  const world = {
    member_id: memberId,
    get agent() {
      return { ...(snapshot.agent || snapshot.origin) }
    },
    getBlock(pos) {
      const found = (snapshot.blocks || []).find((b) => b.x === pos.x && b.y === pos.y && b.z === pos.z)
      return found ? { block_id: found.block_id, state: found.state || {} } : { block_id: 'minecraft:air', state: {} }
    },
    observe() {
      return {
        complete: snapshot.complete !== false,
        origin: { ...(snapshot.origin || snapshot.agent) },
        agent: { ...(snapshot.agent || snapshot.origin) },
        member_id: snapshot.member_id || memberId,
        radius: snapshot.radius,
        blocks: (snapshot.blocks || []).map((b) => ({ ...b, state: b.state || {} })),
      }
    },
    async reloadObservation() {
      if (!reloadObservation) return world.observe()
      snapshot = await reloadObservation()
      return world.observe()
    },
    async act(action) {
      if (!act) return { ok: false, effect: 'unavailable', error: '未配置执行器' }
      return await Promise.resolve(act(action))
    },
  }
  return world
}

export function createWorkRuntime({ dir, observe, act, observeMember, now = () => Math.floor(Date.now() / 1000), manual = false } = {}) {
  const root = dir || workDir()
  let store = null
  let key = null
  const running = new Set()
  const ticking = new Set()
  let timer = null
  let disposed = false

  function storeOf() {
    if (!store) store = createStore(root)
    return store
  }

  function keyOf() {
    if (!key) key = ensureClaimKey(root)
    return key
  }

  function runKey(id, worldId = null) {
    return worldId ? `${worldId}::${id}` : id
  }

  function parseRunKey(key) {
    const sep = key.indexOf('::')
    if (sep < 0) return { id: key, worldId: null }
    return { worldId: key.slice(0, sep), id: key.slice(sep + 2) }
  }

  function resolveRunningKey(id, worldId = null) {
    const explicit = runKey(id, worldId)
    if (running.has(explicit)) return explicit
    const suffix = `::${id}`
    const matches = [...running].filter((k) => k === id || k.endsWith(suffix))
    if (matches.length === 1) return matches[0]
    if (running.has(id)) return id
    return explicit
  }

  const LOOP_PAUSED = new Set(['stopped', 'task_done', 'missing', 'unavailable'])

  async function tick(id, worldId = null) {
    const key = resolveRunningKey(id, worldId)
    const { id: projectId, worldId: scopedWorld } = parseRunKey(key)
    if (disposed || !running.has(key) || ticking.has(key)) return { paused: 'idle' }
    ticking.add(key)
    try {
      const files = storeOf()
      const worldIdUse = scopedWorld || worldId
      if (!observe || !act) return { paused: 'unavailable', acted: false, error: '未配置世界观察或执行器' }

      const prep = await files.update(projectId, (project) => {
        if (!project) return { missing: true }
        if (project.control.execution === 'stopped' || project.loop.phase === 'stopped') {
          return { skip: true, paused: 'stopped' }
        }
        return { token: controlStateToken(project), work: structuredClone(project) }
      }, worldIdUse)

      if (prep.missing) return { paused: 'missing' }
      if (prep.skip) return { paused: prep.paused, acted: false }

      const work = prep.work
      const activeMember = work.claims?.find((c) => c.status === 'active' && c.tid && c.mid)?.mid || null
      const reload = async () => {
        const cur = files.read(projectId, worldIdUse) || work
        const view = work._blocks ? { ...cur, _blocks: work._blocks } : cur
        if (observeMember && activeMember) return await observeMember(view, activeMember)
        return await observe(view)
      }
      const snapshot = await reload()
      const world = worldFrom(snapshot, (action) => {
        const latest = files.read(projectId, worldIdUse) || work
        work.revocations = latest.revocations
        if (latest._blocks) work._blocks = latest._blocks
        world.syncAuthority?.(latest)
        return act(work, action)
      }, {
        memberId: snapshot.member_id || activeMember,
        reloadObservation: reload,
      })
      world.syncAuthority?.(files.read(projectId, worldIdUse) || work)
      const result = await step(work, world, { now: now(), memberId: activeMember })

      let applied = result
      await files.update(projectId, async (current) => {
        if (!current) return { missing: true }
        const snap = await reload()
        if (!controlTokensMatch(controlStateToken(current), prep.token)) {
          rebuildProgressFromWorld(current, snap)
          mergeCommittedWorkState(current, work)
          applied = { ...result, stale: true, acted: false }
          return { project: current }
        }
        applyTickWorkState(current, work)
        rebuildProgressFromWorld(current, snap)
        applied = result
        if (result.paused && LOOP_PAUSED.has(result.paused)) running.delete(key)
        return { project: current }
      }, worldIdUse)

      return applied
    } finally {
      ticking.delete(key)
    }
  }

  function kick() {
    if (manual || timer || disposed) return
    timer = setInterval(() => {
      for (const key of running) {
        const { id, worldId } = parseRunKey(key)
        void tick(id, worldId)
      }
    }, 200)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    get store() { return storeOf() },
    get key() { return keyOf() },
    now,
    running,
    tick,
    start(id, worldId = null) {
      running.add(runKey(id, worldId))
      kick()
    },
    stop(project, at) {
      running.delete(runKey(project.id, project.world_id))
      const receipt = requestStop(project, at)
      for (const claim of project.claims || []) {
        if (claim.status !== 'active') continue
        const tid = claim.tid
        project.revocations = {
          ...project.revocations,
          [tid]: Math.max(project.revocations?.[tid] || 0, claim.gen),
        }
      }
      return receipt
    },
    observeMember: observeMember || null,
    dispose() {
      disposed = true
      running.clear()
      if (timer) clearInterval(timer)
      timer = null
    },
    async run(project, world) {
      return runUntilPause(project, world, { now: now() })
    },
  }
}

export function createWorkTools({ getConfig, runtime }) {
  const cfgOf = () => getConfig?.() || {}
  const clock = () => (typeof runtime?.now === 'function' ? runtime.now() : Math.floor(Date.now() / 1000))

  function roster(project) {
    const origin = project?.anchor || { x: 0, y: 64, z: 0 }
    return memberIdsFor(cfgOf()).map((id, index) => ({ id, pos: origin, idle: 0, queue: index }))
  }

  function tool(name, description, parameters, execute) {
    return defineTool({
      name,
      description,
      parameters,
      output: OUTPUT,
      async execute(args, exec) {
        const cfg = cfgOf()
        const memberId = requireMember(exec, cfg)
        rejectForeign(args, memberId)
        return execute(args || {}, memberId)
      },
    })
  }

  const submit = tool('mc_blueprint_submit', 'Submit a structured Minecraft blueprint. Missing defaults are returned. Illegal parameters are rejected.', {
    project_id: { type: 'string', required: true },
    world_id: { type: 'string', required: true },
    anchor: { type: 'json', required: true },
    parts: { type: 'json', required: true },
  }, (args) => {
    if (runtime.store.read(args.project_id, args.world_id)) throw new Error('项目已存在')
    const project = createProject({ anchor: args.anchor, parts: args.parts }, { id: args.project_id, world_id: args.world_id, now: clock() })
    runtime.store.write(project)
    return { ok: true, project_id: project.id, applied_defaults: project.applied_defaults, tasks: project.tasks.map((task) => ({ id: task.id, status: task.status })) }
  })

  const look = tool('mc_blueprint_preview', 'Preview a saved blueprint against a block snapshot. Does not change the world.', {
    project_id: { type: 'string', required: true },
    snapshot: { type: 'json' },
  }, (args) => {
    const project = runtime.store.read(args.project_id)
    if (!project) throw new Error('没有这个项目')
    const expanded = expand({ anchor: project.anchor, parts: project.parts })
    return { ok: true, preview: preview(expanded, args.snapshot || { blocks: [] }) }
  })

  const claim = tool('mc_task_claim', 'Claim one shared task. The receipt includes ttl_seconds and expires_at.', {
    project_id: { type: 'string', required: true },
    world_id: { type: 'string' },
    task_id: { type: 'string', required: true },
    ttl_seconds: { type: 'integer' },
  }, async (args, memberId) => {
    const existing = runtime.store.read(args.project_id, args.world_id)
    const snap = runtime.observeMember
      ? await runtime.observeMember(existing, memberId)
      : {
        complete: true,
        origin: existing?.anchor,
        agent: existing?.anchor,
        radius: 16,
        blocks: existing?._blocks || [],
        member_id: memberId,
      }
    const result = runtime.store.update(args.project_id, (project) => {
      if (!project) throw new Error('没有这个项目')
      const claimed = claimWork(project, {
        member_id: memberId,
        task_id: args.task_id,
        now: clock(),
        ttl_seconds: args.ttl_seconds,
        key: runtime.key,
        agent_pos: snap.agent,
        snapshot: snap,
        roster: roster(project),
      })
      if (!claimed.ok) throw new Error(claimed.error)
      return claimed
    }, existing?.world_id || args.world_id)
    return result.then((claimed) => {
      runtime.start(args.project_id, claimed.project?.world_id || args.world_id)
      const claimView = { ...claimed.claim }
      return { ok: true, claim: claimView, ttl_seconds: claimView.ttl_seconds, expires_at: claimView.expires_at }
    })
  })

  const cont = tool('mc_task_continue', 'Leave a checkpoint and allow the next stage. A clock does not do this.', {
    project_id: { type: 'string', required: true },
    task_id: { type: 'string', required: true },
  }, (args, memberId) => runtime.store.update(args.project_id, (project) => {
    const next = continueTask(project, { task_id: args.task_id, member_id: memberId, now: clock() })
    if (!next.ok) throw new Error(next.error)
    next.project.loop.phase = 'running'
    runtime.start(args.project_id, next.project.world_id)
    return { ok: true, project: next.project }
  }).then(() => ({ ok: true })))

  const stop = tool('mc_work_stop', 'Emergency stop. The receipt has received and stopped.', {
    project_id: { type: 'string', required: true },
  }, (args) => runtime.store.update(args.project_id, (project) => {
    const receipt = runtime.stop(project, clock())
    return { ok: true, project, receipt }
  }).then((saved) => ({
    ok: true,
    received: true,
    stopped: saved.receipt.stopped,
    stop: saved.receipt.stop,
  })))

  const status = tool('mc_work_status', 'Read project progress. This does not post into the chat.', {
    project_id: { type: 'string', required: true },
  }, (args) => runtime.store.update(args.project_id, (project) => {
    if (!project) throw new Error('没有这个项目')
    assignMembers(project, roster(project))
    return { ok: true, project }
  }).then((saved) => ({ ok: true, project: publicView(saved.project) })))

  const decide = tool('mc_conflict_decide', 'Record a human decision for a frozen cell: accept_site, authorize_restore, or exclude.', {
    project_id: { type: 'string', required: true },
    pos: { type: 'string', required: true },
    decision: { type: 'string', required: true },
  }, (args) => runtime.store.update(args.project_id, (project) => {
    const result = decideConflict(project, { pos: args.pos, decision: args.decision, now: clock() })
    if (!result.ok) throw new Error(result.error)
    return result
  }).then(() => ({ ok: true })))

  const material = tool('mc_material_claim', 'Reserve an exact quantity from the material gap.', {
    project_id: { type: 'string', required: true },
    item_id: { type: 'string', required: true },
    qty: { type: 'integer', required: true },
  }, (args, memberId) => runtime.store.update(args.project_id, (project) => {
    const result = reserve(project, { member_id: memberId, item_id: args.item_id, qty: args.qty, now: clock() })
    if (!result.ok) throw new Error(result.error)
    return result
  }).then((result) => ({ ok: true, open: result.open })))

  const resolve = tool('mc_work_resolve', 'Settle an unknown in-flight action. It is not replayed.', {
    project_id: { type: 'string', required: true },
    operation_id: { type: 'string', required: true },
  }, (args) => runtime.store.update(args.project_id, (project) => {
    const result = resolveUnknown(project, args.operation_id)
    if (!result.ok) throw new Error(result.error)
    addNote(project, `resolved ${args.operation_id}`)
    return { ok: true, project, replay: false }
  }).then((result) => ({ ok: true, replay: result.replay })))

  return [submit, look, claim, cont, stop, status, decide, material, resolve]
}

export function workModulesStayOffScheduler() {
  const source = readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8')
  const loop = readFileSync(new URL('./loop.mjs', import.meta.url), 'utf8')
  const imported = (text) => /from\s+['"][^'"]*(?:scheduler|moderator)[^'"]*['"]/.test(text)
  return !imported(source) && !imported(loop)
}

export { authorize }
