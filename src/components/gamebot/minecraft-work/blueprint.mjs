import { BLOCK_RE, DEFAULTS, FACINGS, posKey } from './model.mjs'
import { rotateBlockState, rotateOffset } from './state-rotate.mjs'

export { rotateBlockState, rotateOffset } from './state-rotate.mjs'

function integer(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} 必须是整数`)
  return value
}

function blockId(value, label) {
  const id = String(value || '')
  if (!BLOCK_RE.test(id)) throw new Error(`${label} 缺少合法的 block_id`)
  return id
}

function stateOf(part, applied) {
  if (part.state == null) {
    applied.push({ field: `${part.id}.state`, value: {} })
    return {}
  }
  if (typeof part.state !== 'object' || Array.isArray(part.state)) throw new Error(`${part.id} 的 state 必须是对象`)
  const out = {}
  for (const [key, value] of Object.entries(part.state)) {
    if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`${part.id} 的状态名无效`)
    const text = String(value).toLowerCase()
    if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`${part.id} 的状态值无效`)
    out[key] = text
  }
  return out
}

function toWorld(anchor, local) {
  const [x, z] = rotateOffset(local.x, local.z, anchor.facing)
  return { x: anchor.x + x, y: anchor.y + local.y, z: anchor.z + z }
}

function worldState(localState, anchorFacing) {
  return rotateBlockState(localState, anchorFacing)
}

function put(cells, cell) {
  const key = posKey(cell)
  if (cells.has(key)) throw new Error(`重叠没有规则：${key}`)
  cells.set(key, cell)
}

/**
 * 展开平台、墙段、开口。开口必须指向一面墙，展开后是「必须为空」且不含拆除许可。
 * 省略的默认值写入 applied_defaults。缺 block_id、非法朝向、无规则重叠直接报错。
 */
export function expand(spec) {
  const applied = []
  const anchorIn = spec?.anchor
  if (!anchorIn) throw new Error('缺少锚点')
  const x = integer(anchorIn.x, '锚点 x')
  const y = integer(anchorIn.y, '锚点 y')
  const z = integer(anchorIn.z, '锚点 z')
  let dimension = anchorIn.dimension
  if (!dimension) {
    dimension = DEFAULTS.dimension
    applied.push({ field: 'anchor.dimension', value: dimension })
  }
  let facing = anchorIn.facing
  if (!facing) {
    facing = DEFAULTS.facing
    applied.push({ field: 'anchor.facing', value: facing })
  }
  if (!FACINGS.includes(facing)) throw new Error('朝向无效')
  const anchor = { dimension, x, y, z, facing }
  const parts = spec.parts
  if (!Array.isArray(parts) || !parts.length) throw new Error('图纸至少需要一个部件')
  const cells = new Map()
  const byId = new Map()

  for (const part of parts) {
    if (!part || typeof part !== 'object') throw new Error('部件无效')
    if (!part.id || typeof part.id !== 'string') throw new Error('部件缺少 id')
    if (byId.has(part.id)) throw new Error(`部件 id 重复：${part.id}`)
    byId.set(part.id, part)
    if (part.kind === 'opening') continue
    if (part.kind === 'platform') {
      const width = integer(part.width, `${part.id} 的宽度`)
      const depth = integer(part.depth, `${part.id} 的深度`)
      if (width < 1 || depth < 1) throw new Error(`${part.id} 的尺寸必须大于 0`)
      const ox = integer(part.x, `${part.id}.x`)
      const oy = integer(part.y, `${part.id}.y`)
      const oz = integer(part.z, `${part.id}.z`)
      const block = blockId(part.block_id, part.id)
      const state = worldState(stateOf(part, applied), anchor.facing)
      for (let dx = 0; dx < width; dx++) {
        for (let dz = 0; dz < depth; dz++) {
          const world = toWorld(anchor, { x: ox + dx, y: oy, z: oz + dz })
          put(cells, { ...world, kind: 'specified', block_id: block, state, part_id: part.id, grants_break: false })
        }
      }
      continue
    }
    if (part.kind === 'block') {
      const ox = integer(part.x, `${part.id}.x`)
      const oy = integer(part.y, `${part.id}.y`)
      const oz = integer(part.z, `${part.id}.z`)
      const block = blockId(part.block_id, part.id)
      const state = worldState(stateOf(part, applied), anchor.facing)
      const world = toWorld(anchor, { x: ox, y: oy, z: oz })
      const cell = {
        ...world,
        kind: 'specified',
        block_id: block,
        state,
        part_id: part.id,
        grants_break: false,
      }
      if (part.source_position) cell.source_position = part.source_position
      put(cells, cell)
      continue
    }
    if (part.kind === 'wall') {
      let axis = part.axis
      if (!axis) {
        axis = DEFAULTS.axis
        applied.push({ field: `${part.id}.axis`, value: axis })
      }
      if (axis !== 'x' && axis !== 'z') throw new Error(`${part.id} 的 axis 只能是 x 或 z`)
      const length = integer(part.length, `${part.id} 的长度`)
      const height = integer(part.height, `${part.id} 的高度`)
      if (length < 1 || height < 1) throw new Error(`${part.id} 的尺寸必须大于 0`)
      const ox = integer(part.x, `${part.id}.x`)
      const oy = integer(part.y, `${part.id}.y`)
      const oz = integer(part.z, `${part.id}.z`)
      const block = blockId(part.block_id, part.id)
      const state = worldState(stateOf(part, applied), anchor.facing)
      for (let i = 0; i < length; i++) {
        for (let h = 0; h < height; h++) {
          const local = axis === 'x' ? { x: ox + i, y: oy + h, z: oz } : { x: ox, y: oy + h, z: oz + i }
          const world = toWorld(anchor, local)
          put(cells, { ...world, kind: 'specified', block_id: block, state, part_id: part.id, grants_break: false, along: i, up: h })
        }
      }
      continue
    }
    if (part.kind === 'exclude') {
      const world = toWorld(anchor, { x: integer(part.x, `${part.id}.x`), y: integer(part.y, `${part.id}.y`), z: integer(part.z, `${part.id}.z`) })
      put(cells, { ...world, kind: 'out_of_scope', block_id: null, state: {}, part_id: part.id, grants_break: false })
      continue
    }
    throw new Error(`不支持的部件：${part.kind || '(empty)'}`)
  }

  for (const part of parts) {
    if (part.kind !== 'opening') continue
    const wall = byId.get(part.wall_id)
    if (!wall || wall.kind !== 'wall') throw new Error('开口必须指明所在的墙')
    const offset = integer(part.offset, `${part.id} 的 offset`)
    const width = integer(part.width, `${part.id} 的宽度`)
    const height = integer(part.height, `${part.id} 的高度`)
    if (offset < 0 || width < 1 || height < 1) throw new Error(`${part.id} 的尺寸无效`)
    applied.push({ field: `${part.id}.grants_break`, value: DEFAULTS.opening_grants_break })
    for (let i = 0; i < width; i++) {
      for (let h = 0; h < height; h++) {
        const along = offset + i
        const found = [...cells.values()].find((cell) => cell.part_id === wall.id && cell.along === along && cell.up === h)
        if (!found) throw new Error(`开口超出墙：${part.id}`)
        if (found.kind === 'required_empty') throw new Error(`开口重叠没有规则：${posKey(found)}`)
        found.kind = 'required_empty'
        found.block_id = null
        found.state = {}
        found.grants_break = false
        found.opening_id = part.id
      }
    }
  }

  return { anchor, applied_defaults: applied, cells: [...cells.values()], parts }
}
