/**
 * Rotation capability (not the placeable whitelist).
 * Same horizontal frame as blueprint coordinate rotation (anchor facing).
 *
 * Supported here:
 * - horizontal facing north/south/east/west rotates with the anchor
 * - vertical facing up/down is preserved
 * - axis x/z swaps with a 90-degree anchor; axis y is preserved
 * - stair half and straight shape are preserved
 * - stair corner shapes (inner_left, inner_right, outer_left, outer_right) are rejected
 * Other property keys pass through unchanged. This does not claim every Minecraft state family.
 * Construction scope for the two-block slice lives in build-scope.mjs.
 */

const HORIZONTAL = new Set(['north', 'south', 'east', 'west'])
const VERTICAL = new Set(['up', 'down'])
const AXIS_HORIZONTAL = new Set(['x', 'z'])

function vecForFacing(facing) {
  switch (facing) {
    case 'north': return [0, -1]
    case 'south': return [0, 1]
    case 'east': return [1, 0]
    case 'west': return [-1, 0]
    default: return null
  }
}

function facingForVec(dx, dz) {
  if (dx === 0 && dz === -1) return 'north'
  if (dx === 0 && dz === 1) return 'south'
  if (dx === 1 && dz === 0) return 'east'
  if (dx === -1 && dz === 0) return 'west'
  return null
}

/** Same transform as blueprint local (dx,dz) → world offset for anchor facing. */
export function rotateOffset(dx, dz, anchorFacing) {
  switch (anchorFacing) {
    case 'south': return [dx, dz]
    case 'north': return [-dx, -dz]
    case 'east': return [-dz, dx]
    case 'west': return [dz, -dx]
    default: throw new Error('朝向无效')
  }
}

function rotateHorizontalFacing(localFacing, anchorFacing) {
  const vec = vecForFacing(localFacing)
  if (!vec) return localFacing
  const [rx, rz] = rotateOffset(vec[0], vec[1], anchorFacing)
  return facingForVec(rx, rz) || localFacing
}

function rotateAxis(localAxis, anchorFacing) {
  if (localAxis === 'y') return 'y'
  if (!AXIS_HORIZONTAL.has(localAxis)) return localAxis
  if (localAxis === 'x') {
    const [rx, rz] = rotateOffset(1, 0, anchorFacing)
    if (rx === 0 && Math.abs(rz) === 1) return 'z'
    if (Math.abs(rx) === 1 && rz === 0) return 'x'
  }
  if (localAxis === 'z') {
    const [rx, rz] = rotateOffset(0, 1, anchorFacing)
    if (rx === 0 && Math.abs(rz) === 1) return 'z'
    if (Math.abs(rx) === 1 && rz === 0) return 'x'
  }
  return localAxis
}

const UNSUPPORTED_SHAPE = new Set(['inner_left', 'inner_right', 'outer_left', 'outer_right'])

/**
 * Rotate supported directional properties for anchor placement.
 * Does not mutate the input object. Unsupported stair corner shapes throw.
 */
export function rotateBlockState(localState, anchorFacing) {
  if (!localState || typeof localState !== 'object' || Array.isArray(localState)) return {}
  const out = { ...localState }
  if (out.facing != null) {
    const f = String(out.facing).toLowerCase()
    if (VERTICAL.has(f)) out.facing = f
    else if (HORIZONTAL.has(f)) out.facing = rotateHorizontalFacing(f, anchorFacing)
    else throw new Error(`不支持的朝向属性：${f}`)
  }
  if (out.axis != null) {
    const a = String(out.axis).toLowerCase()
    if (a !== 'x' && a !== 'y' && a !== 'z') throw new Error(`不支持的 axis：${a}`)
    out.axis = rotateAxis(a, anchorFacing)
  }
  if (out.half != null) {
    const h = String(out.half).toLowerCase()
    if (h !== 'top' && h !== 'bottom') throw new Error(`不支持的 half：${h}`)
    out.half = h
  }
  if (out.shape != null) {
    const s = String(out.shape).toLowerCase()
    if (UNSUPPORTED_SHAPE.has(s)) throw new Error(`本切片不支持楼梯拐角形状：${s}`)
    out.shape = s
  }
  return out
}
