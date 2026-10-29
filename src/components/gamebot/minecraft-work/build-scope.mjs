/**
 * Placeable set for this two-block slice only.
 * Distinct from rotation in state-rotate.mjs: rotation may keep vertical facing and axis y,
 * but this exercise only places a plain block and a bottom straight stair.
 * Extra properties on an allowed block (for example waterlogged) are kept and must still match on read-back.
 */

const HORIZONTAL = new Set(['north', 'south', 'east', 'west'])

export function placementRefusal(blockId, state) {
  const id = String(blockId || '')
  const s = state && typeof state === 'object' ? state : {}
  if (id === 'minecraft:polished_diorite') {
    if (s.facing != null) return `本切片的 ${id} 不带 facing`
    return null
  }
  if (id === 'minecraft:polished_diorite_stairs') {
    const facing = s.facing == null ? '' : String(s.facing)
    if (!HORIZONTAL.has(facing)) return `楼梯 facing 必须是水平朝向，收到 ${facing || '(empty)'}`
    if (s.half !== 'bottom') return `本切片楼梯 half 只施工 bottom，收到 ${s.half ?? '(empty)'}`
    if (s.shape !== 'straight') return `本切片楼梯 shape 只施工 straight，收到 ${s.shape ?? '(empty)'}`
    return null
  }
  return `本切片不可施工：${id || '(empty)'}`
}

export function assertPlaceable(blockId, state) {
  const reason = placementRefusal(blockId, state)
  if (reason) throw new Error(reason)
  return true
}
