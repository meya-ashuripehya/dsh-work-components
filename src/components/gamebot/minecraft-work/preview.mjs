import { posKey } from './model.mjs'

/**
 * 只读预览。现场快照里没写到的格子当作空气（夹具模式）。
 * 必须为空却已有方块时记入冲突，不记入拆除清单。
 */
export function preview(expanded, snapshot = { blocks: [] }) {
  const blocks = new Map()
  for (const block of snapshot.blocks || []) blocks.set(posKey(block), block.block_id)
  const add = []
  const remove = []
  const replace = []
  const conflicts = []
  const materials = {}
  const layers = {}
  for (const cell of expanded.cells) {
    const key = posKey(cell)
    const layer = layers[cell.y] || (layers[cell.y] = [])
    layer.push({ pos: key, kind: cell.kind, block_id: cell.block_id, part_id: cell.part_id, state: cell.state })
    if (cell.kind === 'out_of_scope') continue
    const have = blocks.get(key)
    if (cell.kind === 'specified') {
      materials[cell.block_id] = (materials[cell.block_id] || 0) + 1
      if (!have || have === 'minecraft:air') add.push(key)
      else if (have !== cell.block_id) replace.push({ pos: key, from: have, to: cell.block_id })
    } else if (cell.kind === 'required_empty' && have && have !== 'minecraft:air') {
      conflicts.push({ pos: key, block_id: have, reason: '必须为空的位置上已有方块' })
    }
  }
  return {
    layers,
    materials,
    add,
    remove,
    replace,
    conflicts,
    applied_defaults: expanded.applied_defaults || [],
  }
}
