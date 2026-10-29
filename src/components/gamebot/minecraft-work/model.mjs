/** 施工项目共用的常数、坐标和名称宽度。凭证里只放成员 id。 */

export const TTL_SECONDS = 900
export const STEP_CAP = 200
export const MEMBER_INFLIGHT = 1
export const PROJECT_BUILD_INFLIGHT = 2
export const GLOBAL_INFLIGHT = 6
export const NAME_WIDTH_MAX = 12
export const CLAIM_BYTES = 1024
export const FACINGS = ['north', 'south', 'west', 'east']
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const BLOCK_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/

export const DEFAULTS = {
  dimension: 'minecraft:overworld',
  facing: 'south',
  state: {},
  axis: 'x',
  opening_grants_break: false,
  ttl_seconds: TTL_SECONDS,
  step_cap: STEP_CAP,
  global_inflight: GLOBAL_INFLIGHT,
  project_build_inflight: PROJECT_BUILD_INFLIGHT,
  member_inflight: MEMBER_INFLIGHT,
}

export function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

export function parseKey(key) {
  const [x, y, z] = String(key).split(',').map((n) => Number(n))
  return { x, y, z }
}

export function samePos(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

export function distance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function nameWidth(name) {
  let n = 0
  for (const ch of String(name ?? '')) n += ch.codePointAt(0) > 0xff ? 2 : 1
  return n
}

export function nameError(name) {
  if (nameWidth(name) > NAME_WIDTH_MAX) return '名称不能超过 12 个宽度（一个汉字占 2）。'
  return ''
}

export function clone(value) {
  return value == null ? value : structuredClone(value)
}

/** 第一版测试工地：5×5 平台、一段墙、一个门洞。 */
/** Offline red-carpet handover fixture: 5 carpet cells on an existing stone path. */
export function redCarpetSite() {
  return {
    anchor: { x: 100, y: 64, z: 200, facing: 'south', dimension: 'minecraft:overworld' },
    parts: [
      { kind: 'platform', id: 'carpet', x: 0, y: 1, z: 0, width: 5, depth: 1, block_id: 'minecraft:red_carpet', state: {} },
    ],
  }
}

export const RED_CARPET_WORLD_ID = 'sim-save-red-carpet-v1'

export function testSite() {
  return {
    anchor: { x: 0, y: 64, z: 0, facing: 'south', dimension: 'minecraft:overworld' },
    parts: [
      { kind: 'platform', id: 'floor', x: 0, y: 0, z: 0, width: 5, depth: 5, block_id: 'minecraft:oak_planks' },
      { kind: 'wall', id: 'front', x: 0, y: 1, z: 0, length: 5, height: 3, axis: 'x', block_id: 'minecraft:oak_planks' },
      { kind: 'opening', id: 'door', wall_id: 'front', offset: 2, width: 1, height: 2 },
    ],
  }
}
