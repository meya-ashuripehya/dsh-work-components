import test from 'node:test'
import assert from 'node:assert/strict'
import { expand } from './blueprint.mjs'
import { posKey } from './model.mjs'
import { rotateBlockState } from './state-rotate.mjs'

const STAIR_LOCAL = { facing: 'south', half: 'bottom', shape: 'straight' }

function stairPlatformSpec(facing) {
  return {
    anchor: { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing },
    parts: [{
      kind: 'platform',
      id: 'stair-cell',
      x: 1,
      y: 1,
      z: 0,
      width: 1,
      depth: 1,
      block_id: 'minecraft:polished_diorite_stairs',
      state: STAIR_LOCAL,
    }],
  }
}

test('anchor east: world position correct and stair facing rotates to west (oracle)', () => {
  const built = expand(stairPlatformSpec('east'))
  const cell = built.cells[0]
  assert.equal(posKey(cell), '100,65,101')
  assert.equal(cell.state.facing, 'west')
  assert.equal(cell.state.half, 'bottom')
  assert.equal(cell.state.shape, 'straight')
})

test('anchor facings: position and facing rotate together (hard-coded oracle)', () => {
  const cases = [
    { facing: 'south', pos: '101,65,100', stairFacing: 'south' },
    { facing: 'north', pos: '99,65,100', stairFacing: 'north' },
    { facing: 'west', pos: '100,65,99', stairFacing: 'east' },
    { facing: 'east', pos: '100,65,101', stairFacing: 'west' },
  ]
  for (const { facing, pos, stairFacing } of cases) {
    const cell = expand(stairPlatformSpec(facing)).cells[0]
    assert.equal(posKey(cell), pos, facing)
    assert.equal(cell.state.facing, stairFacing, facing)
  }
})

test('axis x/z rotates; axis y, vertical facing and half stay put', () => {
  const axisX = expand({
    anchor: { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing: 'east' },
    parts: [{ kind: 'platform', id: 'log', x: 0, y: 0, z: 0, width: 1, depth: 1, block_id: 'minecraft:oak_log', state: { axis: 'x' } }],
  }).cells[0]
  assert.equal(posKey(axisX), '100,64,100')
  assert.equal(axisX.state.axis, 'z')

  const axisZ = expand({
    anchor: { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing: 'east' },
    parts: [{ kind: 'wall', id: 'logz', x: 0, y: 0, z: 0, axis: 'z', length: 1, height: 1, block_id: 'minecraft:oak_log', state: { axis: 'z' } }],
  }).cells[0]
  assert.equal(axisZ.state.axis, 'x')

  const axisY = expand({
    anchor: { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing: 'north' },
    parts: [{ kind: 'platform', id: 'logy', x: 0, y: 0, z: 0, width: 1, depth: 1, block_id: 'minecraft:oak_log', state: { axis: 'y' } }],
  }).cells[0]
  assert.equal(axisY.state.axis, 'y')

  const endRod = { facing: 'up' }
  const kept = expand({
    anchor: { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing: 'west' },
    parts: [{ kind: 'platform', id: 'rod', x: 0, y: 2, z: 0, width: 1, depth: 1, block_id: 'minecraft:end_rod', state: endRod }],
  }).cells[0]
  assert.equal(kept.state.facing, 'up')
  assert.deepEqual(endRod, { facing: 'up' })
  assert.equal(rotateBlockState({ facing: 'down', axis: 'y', half: 'top' }, 'east').facing, 'down')
  assert.equal(rotateBlockState({ facing: 'down', axis: 'y', half: 'top' }, 'east').axis, 'y')
  assert.equal(rotateBlockState({ facing: 'down', axis: 'y', half: 'top' }, 'east').half, 'top')
  assert.throws(() => rotateBlockState({ shape: 'inner_left' }, 'south'), /拐角/)
  assert.throws(() => rotateBlockState({ facing: 'sideways' }, 'south'), /朝向/)
})
