import { posKey } from './model.mjs'

/** Map block id to item id for material accounting (slice: common building blocks). */
export function itemForBlock(blockId) {
  if (!blockId || blockId === 'minecraft:air') return null
  if (blockId === 'minecraft:red_carpet') return 'minecraft:red_carpet'
  if (blockId.endsWith('_door')) return blockId
  return blockId
}

/** Placement operations that share one item (e.g. both door halves). */
export function workUnitsForCell(cell) {
  const key = posKey(cell)
  if (cell.coupled_group) {
    return [{ group: cell.coupled_group, cells: [key], item_id: itemForBlock(cell.block_id), qty: cell.coupled_qty ?? 1 }]
  }
  return [{ group: key, cells: [key], item_id: itemForBlock(cell.block_id), qty: 1 }]
}

export function normalizeState(state) {
  if (!state || typeof state !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(state)) out[k] = String(v).toLowerCase()
  return out
}

export function blockEquals(expectedId, expectedState, observed) {
  if (!observed) return false
  const id = observed.block_id ?? observed
  if (id !== expectedId) return false
  const want = normalizeState(expectedState)
  const got = normalizeState(observed.state)
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) return false
  }
  return true
}

/**
 * Missing from a nearby list is not air. Air is returned only when the snapshot is a complete
 * in-memory map (omits_air is not set) and the cell is inside the sampled radius.
 */
export function snapshotBlock(snapshot, pos) {
  if (!snapshot?.complete) return { unknown: true, reason: 'snapshot_not_authoritative' }
  const origin = snapshot.origin || snapshot.agent
  const radius = snapshot.radius ?? 16
  if (origin && (
    Math.abs(pos.x - origin.x) > radius
    || Math.abs(pos.y - origin.y) > radius
    || Math.abs(pos.z - origin.z) > radius
  )) {
    return { unknown: true, reason: 'outside_radius' }
  }
  const found = (snapshot.blocks || []).find((b) => b.x === pos.x && b.y === pos.y && b.z === pos.z)
  if (!found && (snapshot.omits_air || snapshot.nearby_truncated)) {
    return { unknown: true, reason: snapshot.nearby_truncated ? 'nearby_truncated' : 'air_not_listed' }
  }
  if (!found) return { block_id: 'minecraft:air', state: {} }
  return { block_id: found.block_id, state: found.state || {} }
}
