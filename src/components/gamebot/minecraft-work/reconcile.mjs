import { posKey } from './model.mjs'
import { blockEquals, snapshotBlock } from './blocks.mjs'
import { itemForBlock } from './blocks.mjs'
import { shortagesForDemand } from './materials.mjs'

/** 扫描盒用切比雪夫距离。盒外是未知，不能当成空气。盒内缺失才是空气。 */
export function classifyCell(cell, snapshot) {
  if (snapshot?.complete === false || snapshot?.omits_air || snapshot?.nearby_truncated) return 'unknown'
  const origin = snapshot?.origin
  const radius = snapshot?.radius
  if (!origin || !Number.isInteger(radius)) return 'unknown'
  if (Math.abs(cell.x - origin.x) > radius || Math.abs(cell.y - origin.y) > radius || Math.abs(cell.z - origin.z) > radius) return 'unknown'
  const found = (snapshot.blocks || []).find((block) => block.x === cell.x && block.y === cell.y && block.z === cell.z)
  if (!found) return 'minecraft:air'
  return found.block_id
}

export function cellSatisfied(cell, snapshot) {
  if (cell.kind === 'required_empty') return classifyCell(cell, snapshot) === 'minecraft:air'
  if (cell.kind !== 'specified') return false
  const observed = snapshotBlock(snapshot, cell)
  return blockEquals(cell.block_id, cell.state, observed)
}

export function unknownCells(project, snapshot) {
  if (snapshot.complete === false) {
    return project.cells
      .filter((cell) => cell.kind !== 'out_of_scope' && !project.progress.done.includes(posKey(cell)))
      .map((cell) => posKey(cell))
  }
  return project.cells
    .filter((cell) => cell.kind !== 'out_of_scope' && !project.progress.done.includes(posKey(cell)))
    .filter((cell) => classifyCell(cell, snapshot) === 'unknown')
    .map((cell) => posKey(cell))
}

/** Rebuild progress.done from authoritative observation, not journal alone. */
export function rebuildProgressFromWorld(project, snapshot) {
  const done = []
  for (const cell of project.cells) {
    if (cell.kind === 'out_of_scope') continue
    if (cellSatisfied(cell, snapshot)) done.push(posKey(cell))
  }
  project.progress.done = [...new Set(done)]
  return project
}

export function materialDemandForTask(project, task, snapshot) {
  const counts = {}
  for (const key of task.cells) {
    const cell = project.cells.find((c) => posKey(c) === key)
    if (!cell || cell.kind !== 'specified') continue
    if (snapshot && cellSatisfied(cell, snapshot)) continue
    const itemId = itemForBlock(cell.block_id)
    if (!itemId) continue
    counts[itemId] = (counts[itemId] || 0) + 1
  }
  return counts
}

export function projectMaterialDemand(project, snapshot) {
  const counts = {}
  for (const cell of project.cells) {
    if (cell.kind !== 'specified') continue
    if (snapshot && cellSatisfied(cell, snapshot)) continue
    const itemId = itemForBlock(cell.block_id)
    if (!itemId) continue
    counts[itemId] = (counts[itemId] || 0) + 1
  }
  return counts
}

export function remainingCells(project, snapshot) {
  return project.cells
    .filter((cell) => cell.kind === 'specified' || cell.kind === 'required_empty')
    .filter((cell) => !cellSatisfied(cell, snapshot))
    .map((cell) => posKey(cell))
}

export function verifySite(project, snapshot) {
  if (!snapshot?.complete) return { ok: false, error: '观察不完整' }
  const unknown = unknownCells(project, snapshot)
  if (unknown.length) return { ok: false, error: '存在未知格子', unknown }
  const remaining = remainingCells(project, snapshot)
  return { ok: remaining.length === 0, remaining }
}

export function handoverRecord(project, snapshot, { reason = null } = {}) {
  const verified = project.cells
    .filter((cell) => cell.kind === 'specified' || cell.kind === 'required_empty')
    .filter((cell) => cellSatisfied(cell, snapshot))
    .map((cell) => posKey(cell))
  const remaining = remainingCells(project, snapshot)
  const shortages = shortagesForDemand(project, projectMaterialDemand(project, snapshot))
  const unresolved = (project.inflight || []).filter((e) => e.status === 'inflight' || e.status === 'unknown')
  return {
    verified_cells: verified,
    remaining_cells: remaining,
    unavailable_materials: shortages,
    unresolved_operations: unresolved.map((e) => e.operation_id),
    stop_reason: reason,
  }
}

export function canCompleteTask(project, task, snapshot) {
  if (!snapshot?.complete) return false
  const keys = new Set(task.cells)
  const cells = project.cells.filter((c) => keys.has(posKey(c)))
  return cells.every((cell) => cellSatisfied(cell, snapshot))
}
