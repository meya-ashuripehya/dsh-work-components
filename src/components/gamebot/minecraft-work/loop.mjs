import { distance, posKey } from './model.mjs'
import { usableClaim } from './ownership.mjs'
import { diffSite } from './conflicts.mjs'
import { markCheckpoint } from './checkpoints.mjs'
import { unknownCells, cellSatisfied, rebuildProgressFromWorld } from './reconcile.mjs'
import { dispatchPlace } from './execute.mjs'
import { tickOwnership } from './ownership.mjs'
import { releaseWorkspace } from './workspace.mjs'

const REACH = 4.5

function neighbors(cell) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [
    { x: cell.x + dx, y: cell.y, z: cell.z + dz },
    { x: cell.x + dx, y: cell.y - 1, z: cell.z + dz },
  ])
}

function blockAt(world, pos) {
  if (world.getBlock) return world.getBlock(pos).block_id
  return world.blocks?.get(posKey(pos))?.block_id || world.blocks?.get(posKey(pos)) || 'minecraft:air'
}

/** 先站到已有空位，再试已登记的脚手架，否则交回。 */
export function planApproach(project, cell, world) {
  if (distance(world.agent, cell) <= REACH) return { kind: 'place' }
  const stands = neighbors(cell).filter((pos) => {
    const id = blockAt(world, pos)
    return id === 'minecraft:air' || id === 'minecraft:scaffolding'
  })
  if (stands.length) {
    stands.sort((a, b) => distance(world.agent, a) - distance(world.agent, b))
    return { kind: 'move', pos: stands[0] }
  }
  const pad = (project.scaffolds || []).find((item) => item.status === 'up' && blockAt(world, item) === 'minecraft:air' && distance(item, cell) <= 2)
  if (pad) return { kind: 'scaffold', pos: { x: pad.x, y: pad.y, z: pad.z }, scaffold: pad }
  return { kind: 'handback', reason: '没有合法站位' }
}

function nextCell(project, task, snapshot) {
  const cells = task.cells
    .map((key) => project.cells.find((cell) => posKey(cell) === key))
    .filter((cell) => cell && !cellSatisfied(cell, snapshot))
    .filter((cell) => !project.conflicts.some((item) => item.status === 'frozen' && item.pos === posKey(cell)))
  cells.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
  return cells[0] || null
}

function runningTaskFor(project, memberId, now) {
  const running = project.tasks.filter((item) => item.status === 'running' && item.kind === 'build')
  if (!memberId) return running[0] || null
  for (const task of running) {
    const claim = usableClaim(project, task.id, now, memberId)
    if (claim.ok) return task
  }
  return null
}

export async function step(project, world, { now, memberId = null, globalInflight = [] }) {
  tickOwnership(project, now)
  if (project.control.execution === 'stopped' || project.loop.phase === 'stopped') return { paused: 'stopped', acted: false }
  if (['checkpoint', 'unknown', 'frozen', 'blocked', 'reconciling'].includes(project.loop.phase)) {
    return { paused: project.loop.phase, acted: false }
  }
  if (project.loop.steps >= project.loop.cap) {
    project.loop.phase = 'checkpoint'
    project.journal.push({ kind: 'cap', steps: project.loop.steps })
    return { paused: 'cap', acted: false }
  }
  const snapshot = world.observe()
  rebuildProgressFromWorld(project, snapshot)
  const unknown = unknownCells(project, snapshot)
  if (unknown.length) {
    project.loop.phase = 'unknown'
    project.journal.push({ kind: 'unknown', cells: unknown })
    return { paused: 'unknown', acted: false }
  }
  const task = runningTaskFor(project, memberId || world.member_id, now)
  if (!task) return { paused: 'idle', acted: false }
  const claim = usableClaim(project, task.id, now, memberId || world.member_id)
  if (!claim.ok) return { paused: 'claim', error: claim.error, acted: false }
  const cell = nextCell(project, task, snapshot)
  if (!cell) {
    if (task.checkpoint) {
      markCheckpoint(project, task.id)
      return { paused: 'checkpoint', acted: false }
    }
    task.status = 'done'
    releaseWorkspace(project, claim.claim.mid, task.id)
    const active = project.claims.find((c) => c.tid === task.id && c.mid === claim.claim.mid && c.status === 'active')
    if (active) active.status = 'revoked'
    return { paused: 'task_done', acted: false }
  }
  if (cell.kind === 'required_empty') {
    if (!cellSatisfied(cell, snapshot)) {
      diffSite(project, snapshot, now)
      project.loop.phase = 'frozen'
      return { paused: 'conflict', acted: false }
    }
    return { skipped: true }
  }
  if (cellSatisfied(cell, snapshot)) return { skipped: true }
  if (classifyOccupied(cell, snapshot)) {
    diffSite(project, snapshot, now)
    project.loop.phase = 'frozen'
    return { paused: 'conflict', acted: false }
  }
  const approach = planApproach(project, cell, world)
  if (approach.kind === 'handback') {
    project.loop.phase = 'blocked'
    project.journal.push({ kind: 'handback', pos: posKey(cell), reason: approach.reason })
    return { paused: 'handback', acted: false }
  }
  if (approach.kind === 'move') {
    const outcome = await Promise.resolve(world.act({ action: 'move_to', params: approach.pos }))
    project.loop.steps += 1
    return { acted: true, action: 'move_to', outcome }
  }
  if (approach.kind === 'scaffold') {
    return { paused: 'scaffold_unsupported', acted: false }
  }
  const placed = await dispatchPlace(project, world, claim.claim, cell, {
    now,
    globalInflight,
    delay: world._delay,
    dropAck: world._dropAck,
  })
  if (placed.unknown) {
    project.loop.phase = 'unknown'
    project.loop.steps += 1
    return { paused: 'unknown', acted: true, replay: false }
  }
  if (!placed.ok) {
    if (placed.stale || placed.duplicate) return { paused: 'denied', error: placed.error, acted: false }
    if (placed.error === '世界状态未匹配') {
      project.loop.phase = 'blocked'
      return { paused: 'verify_failed', error: placed.error, acted: false }
    }
    return { paused: 'denied', error: placed.error, acted: false }
  }
  project.loop.steps += 1
  project.loop.phase = 'running'
  project.control.execution = 'running'
  return { acted: true, action: 'place_block', operation_id: placed.operation_id }
}

function classifyOccupied(cell, snapshot) {
  const found = (snapshot.blocks || []).find((b) => b.x === cell.x && b.y === cell.y && b.z === cell.z)
  if (!found) return false
  return found.block_id !== 'minecraft:air' && found.block_id !== cell.block_id
}

export async function runUntilPause(project, world, ctx) {
  let last = { paused: null }
  for (let guard = 0; guard < 500; guard++) {
    last = await step(project, world, ctx)
    if (last.paused || last.skipped) {
      if (!last.skipped) return last
    }
    if (last.skipped) continue
  }
  return last
}
