#!/usr/bin/env node
/**
 * Real two-block exercise. Does not choose a site, spawn items, or change gamemode.
 * A cell is done only after a fresh probe_blocks read matches. Action success is not enough.
 * The in-memory simulator is not this script.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { placementRefusal } from './build-scope.mjs'
import { blockEquals } from './blocks.mjs'
import { createMemberBridgeWorld, memberHasPlaceBlock, memberHasProbeBlocks } from './member-bridge-world.mjs'
import { createProjectFromRawFixture } from './project.mjs'
import { claimWork } from './schedule.mjs'
import { runUntilPause } from './loop.mjs'
import { handoverRecord } from './reconcile.mjs'
import { actionGameTime, assessProbe } from './probe.mjs'
import { distance, posKey } from './model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'two-block-diorite.json'), 'utf8'))
const STEP_LIMIT = 50
const REACH = 4.5
const PAUSE_EXIT = {
  denied: 5,
  verify_failed: 5,
  handback: 5,
  conflict: 5,
  unknown: 11,
  cap: 9,
  claim: 4,
  stopped: 5,
  checkpoint: 5,
  frozen: 5,
  blocked: 5,
  reconciling: 5,
  scaffold_unsupported: 5,
}

const USAGE = `Set both variables, then run. The anchor must be an owner-designated disposable pad, not the offline oracle.
  MC_TWO_BLOCK_MEMBER_ID   chatroom seat id
  MC_TWO_BLOCK_ANCHOR      {"dimension":"minecraft:overworld","x":0,"y":64,"z":0,"facing":"east"}
Optional:
  MC_TWO_BLOCK_STOCK       ledger quantities; must match NPC hotbar counts or the run stops
  GAMEBOT_URL              default http://127.0.0.1:8766
Preflight, all required before any placement:
  place_block and probe_blocks capabilities
  solid loaded support directly under the floor cell
  both target cells explicitly air
  stair side and upper neighbors loaded and not stairs
  hotbar (slots 0-8) holds the items; env stock is not a substitute`

export function anchorCells(project) {
  const floor = project.cells.find((cell) => cell.part_id === 'two_block_floor')
  const stair = project.cells.find((cell) => cell.part_id === 'two_block_stair')
  const support = { x: floor.x, y: floor.y - 1, z: floor.z }
  const around = [
    { x: stair.x + 1, y: stair.y, z: stair.z },
    { x: stair.x - 1, y: stair.y, z: stair.z },
    { x: stair.x, y: stair.y, z: stair.z + 1 },
    { x: stair.x, y: stair.y, z: stair.z - 1 },
    { x: stair.x, y: stair.y + 1, z: stair.z },
  ]
  return { floor, stair, support, around, positions: [support, floor, stair, ...around] }
}

function samePos(cell, pos) {
  const point = cell.pos || cell
  return point.x === pos.x && point.y === pos.y && point.z === pos.z
}

export function hotbarCounts(observation) {
  const slots = observation?.extras?.minecraft?.inventory?.slots || observation?.inventory?.slots || []
  const counts = {}
  for (const slot of slots) {
    if (!slot || !Number.isInteger(slot.slot) || slot.slot < 0 || slot.slot > 8 || !slot.item_id) continue
    counts[slot.item_id] = (counts[slot.item_id] || 0) + (slot.count || 0)
  }
  return counts
}

function unacceptableSupport(blockId) {
  if (!blockId || blockId === 'minecraft:air') return 'support is air or unknown'
  if (blockId.endsWith('_stairs') || blockId.endsWith('_slab') || blockId.endsWith('_carpet')) return `support is not a full block: ${blockId}`
  if (blockId.includes('water') || blockId.includes('lava')) return `support is fluid: ${blockId}`
  return null
}

export function authoritativeSnapshot(agent, probe, positions) {
  const origin = {
    x: Math.floor(agent.x),
    y: Math.floor(agent.y),
    z: Math.floor(agent.z),
  }
  let radius = 0
  for (const pos of positions) {
    radius = Math.max(radius, Math.abs(pos.x - origin.x), Math.abs(pos.y - origin.y), Math.abs(pos.z - origin.z))
  }
  return {
    complete: true,
    omits_air: false,
    nearby_truncated: false,
    origin,
    agent: origin,
    radius,
    dimension: probe.dimension,
    blocks: (probe.cells || []).filter((cell) => cell?.loaded && cell.block_id).map((cell) => ({
      x: cell.pos.x,
      y: cell.pos.y,
      z: cell.pos.z,
      block_id: cell.block_id,
      state: cell.state || {},
    })),
  }
}

export function preflightProblems({ probe, anchor, cells, hotbar, envStock, agent }) {
  const problems = []
  const verdict = assessProbe(probe, {
    beforeSeq: probe?.before_seq ?? 0,
    afterGameTime: Number.isFinite(probe?.after_game_time) ? probe.after_game_time : 0,
    dimension: anchor.dimension,
  })
  if (!verdict.ok) {
    problems.push(`probe is not usable: ${verdict.reason}`)
    return problems
  }
  const found = (pos) => verdict.cells.find((cell) => samePos(cell, pos))
  const floorRefusal = placementRefusal(cells.floor.block_id, cells.floor.state)
  const stairRefusal = placementRefusal(cells.stair.block_id, cells.stair.state)
  if (floorRefusal) problems.push(floorRefusal)
  if (stairRefusal) problems.push(stairRefusal)
  const support = found(cells.support)
  const supportReason = !support || support.loaded === false ? 'support was not loaded' : unacceptableSupport(support.block_id)
  if (supportReason) problems.push(supportReason)
  for (const target of [cells.floor, cells.stair]) {
    const got = found(target)
    if (!got || got.loaded === false || got.block_id == null) problems.push(`target ${posKey(target)} is unknown`)
    else if (got.block_id !== 'minecraft:air') problems.push(`target ${posKey(target)} is ${got.block_id}, not air`)
  }
  for (const neighbor of cells.around) {
    const got = found(neighbor)
    if (!got || got.loaded === false || got.block_id == null) problems.push(`neighbor ${posKey(neighbor)} is unknown`)
    else if (String(got.block_id).endsWith('_stairs')) problems.push(`neighbor ${posKey(neighbor)} is a stair and can change shape`)
  }
  const needed = {
    [cells.floor.block_id]: 1,
    [cells.stair.block_id]: 1,
  }
  for (const [itemId, qty] of Object.entries(needed)) {
    if ((hotbar[itemId] || 0) < qty) problems.push(`hotbar lacks ${itemId}`)
  }
  if (envStock) {
    for (const [itemId, qty] of Object.entries(envStock)) {
      if ((hotbar[itemId] || 0) !== qty) problems.push(`ledger stock for ${itemId} does not match hotbar`)
    }
  }
  if (!agent) problems.push('agent position is unknown')
  else {
    if (distance(agent, cells.floor) > REACH) problems.push('floor cell is out of reach')
    if (distance(agent, cells.stair) > REACH) problems.push('stair cell is out of reach')
    if (distance(agent, cells.support) > REACH) problems.push('support block is out of reach')
  }
  return problems
}

export function completionDecision({ paused, steps, stepLimit = STEP_LIMIT, probeOk, matches }) {
  if (PAUSE_EXIT[paused]) return { done: false, exitCode: PAUSE_EXIT[paused], reason: paused }
  if (steps >= stepLimit && paused !== 'task_done' && paused !== 'idle') {
    return { done: false, exitCode: 9, reason: 'step_limit' }
  }
  if (!probeOk) return { done: false, exitCode: 11, reason: 'probe_unknown' }
  if (!matches) return { done: false, exitCode: 10, reason: 'readback_mismatch' }
  return { done: true, exitCode: 0, reason: null }
}

function envJson(name) {
  const raw = process.env[name]
  if (!raw) return null
  return JSON.parse(raw)
}

function agentPoint(obs) {
  const point = obs?.position || obs?.extras?.minecraft?.player?.position
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)) || !Number.isFinite(Number(point.z))) return null
  return { x: Number(point.x), y: Number(point.y), z: Number(point.z) }
}

function createProbeWorld(inner, { agent, dimension, positions }) {
  const origin = { x: Math.floor(agent.x), y: Math.floor(agent.y), z: Math.floor(agent.z) }
  const state = { snapshot: null, lastActionGameTime: undefined, dimension, origin, rawAgent: agent, positions }
  const world = {
    member_id: inner.member_id,
    get agent() {
      return state.rawAgent
    },
    currentProbeSeq: () => inner.currentProbeSeq(),
    lastActionGameTime: () => state.lastActionGameTime,
    observe: () => state.snapshot || {
      complete: false,
      omits_air: true,
      nearby_truncated: true,
      origin: state.origin,
      agent: state.origin,
      radius: 0,
      blocks: [],
    },
    async probeBlocks(request) {
      return inner.probeBlocks(request)
    },
    async refresh() {
      const beforeSeq = inner.currentProbeSeq()
      const probe = await inner.probeBlocks({ positions: state.positions })
      const afterGameTime = Number.isFinite(state.lastActionGameTime) ? state.lastActionGameTime : 0
      const verdict = assessProbe(probe, { beforeSeq, afterGameTime, dimension: state.dimension })
      if (!verdict.ok) {
        state.snapshot = {
          complete: false,
          omits_air: true,
          nearby_truncated: true,
          origin: state.origin,
          agent: state.origin,
          radius: 16,
          dimension: probe?.dimension || null,
          blocks: [],
        }
      } else {
        state.snapshot = authoritativeSnapshot(state.origin, { ...probe, cells: verdict.cells }, state.positions)
      }
      return { probe, beforeSeq, afterGameTime, verdict }
    },
    async act(action) {
      const outcome = await inner.act(action)
      const stamped = actionGameTime(outcome)
      if (Number.isFinite(stamped)) state.lastActionGameTime = stamped
      if (action.action === 'place_block' || action.action === 'move_to') await world.refresh()
      return outcome
    },
  }
  return world
}

function retainVerified(project, record, comparisons = []) {
  const failed = new Set(comparisons.filter((item) => !item.match).map((item) => item.key))
  const kept = project.progress.done.filter((key) => !failed.has(key))
  record.verified_cells = [...new Set([...kept, ...record.verified_cells.filter((key) => !failed.has(key))])]
  record.remaining_cells = record.remaining_cells.filter((key) => !kept.includes(key))
  for (const key of failed) {
    if (!record.remaining_cells.includes(key)) record.remaining_cells.push(key)
  }
  return record
}

async function main() {
  const memberId = process.env.MC_TWO_BLOCK_MEMBER_ID
  const anchor = envJson('MC_TWO_BLOCK_ANCHOR')
  if (!memberId || !anchor) {
    console.error(USAGE)
    process.exit(2)
  }
  const getConfig = () => ({ gamebotUrl: process.env.GAMEBOT_URL || 'http://127.0.0.1:8766' })
  const { memberRequest } = await import('../members.mjs')
  const obs = await memberRequest(getConfig(), `/v1/minecraft/members/${encodeURIComponent(memberId)}/observe`)
  if (!memberHasPlaceBlock(obs) || !memberHasProbeBlocks(obs)) {
    console.error('Member lacks minecraft.world.place_block or minecraft.world.probe_blocks. Real integration not run.')
    process.exit(3)
  }
  const agent = agentPoint(obs)
  const now = Math.floor(Date.now() / 1000)
  const envStock = envJson('MC_TWO_BLOCK_STOCK')
  const hotbar = hotbarCounts(obs)
  const ledger = envStock || {
    'minecraft:polished_diorite': hotbar['minecraft:polished_diorite'] || 0,
    'minecraft:polished_diorite_stairs': hotbar['minecraft:polished_diorite_stairs'] || 0,
  }
  const project = createProjectFromRawFixture(fixture, anchor, {
    id: process.env.MC_TWO_BLOCK_PROJECT_ID || 'two-block-live',
    now,
    world_id: process.env.MC_TWO_BLOCK_WORLD_ID || 'live-scratch',
    material_stock: ledger,
  })
  project.loop.cap = STEP_LIMIT
  const cells = anchorCells(project)
  const inner = createMemberBridgeWorld({ getConfig, memberId })
  const world = agent
    ? createProbeWorld(inner, { agent, dimension: anchor.dimension, positions: cells.positions })
    : null
  const opened = world ? await world.refresh() : { probe: { ok: false }, beforeSeq: 0, afterGameTime: 0 }
  const problems = preflightProblems({
    probe: { ...opened.probe, before_seq: opened.beforeSeq, after_game_time: opened.afterGameTime },
    anchor,
    cells,
    hotbar,
    envStock,
    agent,
  })
  if (problems.length) {
    console.log(JSON.stringify({ phase: 'preflight_failed', real_integration: 'not_run', problems }, null, 2))
    process.exit(4)
  }
  const readPositions = project.cells
    .filter((cell) => cell.kind === 'specified')
    .map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }))
  for (const taskId of ['two_block_floor', 'two_block_stair']) {
    const beforeTask = await world.refresh()
    const snap = world.observe()
    if (!beforeTask.verdict.ok || snap.complete !== true) {
      console.log(JSON.stringify({
        phase: 'probe_unknown',
        taskId,
        reason: beforeTask.verdict.reason || 'snapshot_not_authoritative',
        handover: retainVerified(project, handoverRecord(project, snap, { reason: 'probe_unknown' })),
      }, null, 2))
      process.exit(11)
    }
    const claimed = claimWork(project, {
      member_id: memberId,
      task_id: taskId,
      now,
      ttl_seconds: 900,
      key: Buffer.from('two-block-live'),
      agent_pos: snap.agent,
      snapshot: snap,
    })
    if (!claimed.ok) {
      console.log(JSON.stringify({
        phase: 'claim_failed',
        taskId,
        error: claimed.error,
        handover: retainVerified(project, handoverRecord(project, snap, { reason: claimed.error })),
      }, null, 2))
      process.exit(4)
    }
    Object.assign(project, claimed.project)
    const task = project.tasks.find((item) => item.id === taskId)
    task.status = 'running'
    const result = await runUntilPause(project, world, { now, memberId, globalInflight: project.inflight })
    const paused = result.paused
    const read = await world.probeBlocks({ positions: readPositions })
    const actionTime = world.lastActionGameTime()
    const verdict = assessProbe(read, {
      beforeSeq: beforeTask.beforeSeq,
      afterGameTime: Number.isFinite(actionTime) ? actionTime : beforeTask.afterGameTime,
      dimension: anchor.dimension,
    })
    const comparisons = []
    let matches = verdict.ok
    for (const key of task.cells) {
      const cell = project.cells.find((item) => posKey(item) === key)
      const observed = verdict.ok ? verdict.cells.find((item) => posKey(item.pos) === key) : null
      const match = Boolean(observed) && blockEquals(cell.block_id, cell.state, observed)
      if (!match) matches = false
      comparisons.push({
        key,
        expected: { block_id: cell.block_id, state: cell.state },
        observed: observed ? { block_id: observed.block_id, state: observed.state || {} } : { unknown: true, reason: verdict.reason },
        match,
      })
    }
    const decision = completionDecision({ paused, steps: project.loop.steps, probeOk: verdict.ok, matches })
    console.log(JSON.stringify({ phase: 'readback', taskId, decision, comparisons }, null, 2))
    if (!decision.done) {
      task.status = 'claimable'
      project.progress.done = project.progress.done.filter((key) => !comparisons.some((item) => item.key === key && !item.match))
      const handoverSnap = verdict.ok
        ? authoritativeSnapshot(snap.agent, { ...read, cells: verdict.cells }, readPositions)
        : { complete: false, omits_air: true, origin: snap.agent, agent: snap.agent, radius: 16, blocks: [] }
      console.log(JSON.stringify({
        phase: 'handover',
        taskId,
        handover: retainVerified(project, handoverRecord(project, handoverSnap, { reason: decision.reason }), comparisons),
      }, null, 2))
      process.exit(decision.exitCode)
    }
    task.status = 'done'
  }
  console.log(JSON.stringify({ phase: 'complete', real_integration: 'verified_by_probe' }, null, 2))
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
