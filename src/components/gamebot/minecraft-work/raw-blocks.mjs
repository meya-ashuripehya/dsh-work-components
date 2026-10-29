import { BLOCK_RE, FACINGS } from './model.mjs'

function integer(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} 必须是整数`)
  return value
}

function blockId(value, label) {
  const id = String(value || '')
  if (!BLOCK_RE.test(id)) throw new Error(`${label} 缺少合法的 block_id`)
  return id
}

const CORNER_SHAPES = new Set(['inner_left', 'inner_right', 'outer_left', 'outer_right'])

function normalizeProperties(properties, label) {
  if (properties == null) return {}
  if (typeof properties !== 'object' || Array.isArray(properties)) throw new Error(`${label} 的 properties 必须是对象`)
  const out = {}
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`${label} 的状态名无效`)
    const text = String(value).toLowerCase()
    if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`${label} 的状态值无效`)
    out[key] = text
  }
  if (out.shape && CORNER_SHAPES.has(out.shape)) {
    throw new Error(`${label} 的楼梯拐角形状不支持：${out.shape}`)
  }
  return out
}

function rejectBlockEntity(raw, label) {
  if (raw.block_entity != null || raw.nbt != null) {
    throw new Error(`${label} 含 block entity / NBT，本切片不导入`)
  }
  const id = String(raw.block_id || '')
  if (
    /_banner$/.test(id) || id === 'minecraft:banner'
    || /_sign$/.test(id) || /_bed$/.test(id) || /shulker_box$/.test(id)
    || id.includes('skull') || id.includes('_head')
    || id.endsWith('_chest') || id === 'minecraft:chest'
    || id.startsWith('minecraft:potted_') || id === 'minecraft:flower_pot'
  ) {
    throw new Error(`${label} 是 block entity 方块，本切片不导入：${id}`)
  }
}

/**
 * Convert decoded raw blocks + normalization origin into a blueprint spec.
 * Each block becomes kind:block with explicit task id and depends_on (no geometry inference).
 */
export function specFromRawFixture(fixture, anchor) {
  if (!fixture || typeof fixture !== 'object') throw new Error('缺少 raw 夹具')
  const origin = fixture.normalization_origin
  if (!Array.isArray(origin) || origin.length !== 3) throw new Error('normalization_origin 必须是 [x,y,z]')
  const ox = integer(origin[0], 'origin.x')
  const oy = integer(origin[1], 'origin.y')
  const oz = integer(origin[2], 'origin.z')
  const blocks = fixture.blocks
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks 不能为空')
  if (!anchor || typeof anchor !== 'object') throw new Error('缺少锚点')
  const dimension = anchor.dimension || 'minecraft:overworld'
  const facing = anchor.facing || 'south'
  if (!FACINGS.includes(facing)) throw new Error('朝向无效')
  const anchorOut = {
    dimension,
    x: integer(anchor.x, '锚点 x'),
    y: integer(anchor.y, '锚点 y'),
    z: integer(anchor.z, '锚点 z'),
    facing,
  }

  const seen = new Set()
  const parts = []
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') throw new Error('block 条目无效')
    const taskId = raw.task_id || raw.id
    if (!taskId || typeof taskId !== 'string') throw new Error('每个 block 需要 task_id')
    const pos = raw.position
    if (!Array.isArray(pos) || pos.length !== 3) throw new Error(`${taskId} 的 position 必须是 [x,y,z]`)
    const wx = integer(pos[0], `${taskId}.position[0]`)
    const wy = integer(pos[1], `${taskId}.position[1]`)
    const wz = integer(pos[2], `${taskId}.position[2]`)
    const key = `${wx},${wy},${wz}`
    if (seen.has(key)) throw new Error(`重复的源坐标：${key}`)
    seen.add(key)
    rejectBlockEntity(raw, taskId)
    const local = { x: wx - ox, y: wy - oy, z: wz - oz }
    const depends = Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : []
    parts.push({
      kind: 'block',
      id: taskId,
      x: local.x,
      y: local.y,
      z: local.z,
      block_id: blockId(raw.block_id, taskId),
      state: normalizeProperties(raw.properties, taskId),
      depends_on: depends,
      source_position: [wx, wy, wz],
    })
  }

  const excludes = fixture.excludes
  if (Array.isArray(excludes)) {
    for (const ex of excludes) {
      if (!ex || typeof ex !== 'object') throw new Error('exclude 条目无效')
      const pos = ex.position
      if (!Array.isArray(pos) || pos.length !== 3) throw new Error('exclude.position 必须是 [x,y,z]')
      const wx = integer(pos[0], 'exclude.x')
      const wy = integer(pos[1], 'exclude.y')
      const wz = integer(pos[2], 'exclude.z')
      parts.push({
        kind: 'exclude',
        id: ex.id || `exclude_${wx}_${wy}_${wz}`,
        x: wx - ox,
        y: wy - oy,
        z: wz - oz,
        source_position: [wx, wy, wz],
      })
    }
  }

  return {
    anchor: anchorOut,
    parts,
    provenance: {
      normalization_origin: [ox, oy, oz],
      source: fixture.provenance || fixture.source || null,
      raw_block_count: blocks.length,
    },
  }
}
