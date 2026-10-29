import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { specFromRawFixture } from './raw-blocks.mjs'
import { placementRefusal } from './build-scope.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'two-block-diorite.json'), 'utf8'))

test('fixture normalizes to local floor [1,0,0] and stair [1,1,0]', () => {
  const spec = specFromRawFixture(fixture, { x: 0, y: 64, z: 0, facing: 'south' })
  const floor = spec.parts.find((p) => p.id === 'two_block_floor')
  const stair = spec.parts.find((p) => p.id === 'two_block_stair')
  assert.deepEqual([floor.x, floor.y, floor.z], [1, 0, 0])
  assert.deepEqual([stair.x, stair.y, stair.z], [1, 1, 0])
  assert.deepEqual(stair.depends_on, ['two_block_floor'])
  assert.deepEqual(stair.state, { half: 'bottom', waterlogged: 'false', shape: 'straight', facing: 'south' })
  assert.equal(placementRefusal('minecraft:polished_diorite', {}), null)
  assert.equal(placementRefusal('minecraft:end_rod', { facing: 'up' }), '本切片不可施工：minecraft:end_rod')
})

test('raw import keeps vertical facing and rejects corners and block entities', () => {
  const anchor = { x: 0, y: 64, z: 0, facing: 'south' }
  const vertical = specFromRawFixture({
    normalization_origin: [0, 0, 0],
    blocks: [{ task_id: 'rod', position: [0, 1, 0], block_id: 'minecraft:end_rod', properties: { facing: 'up' } }],
  }, anchor)
  assert.equal(vertical.parts[0].state.facing, 'up')
  assert.throws(() => specFromRawFixture({
    normalization_origin: [0, 0, 0],
    blocks: [{ task_id: 'corner', position: [0, 0, 0], block_id: 'minecraft:oak_stairs', properties: { facing: 'south', half: 'bottom', shape: 'inner_left' } }],
  }, anchor), /拐角/)
  assert.throws(() => specFromRawFixture({
    normalization_origin: [0, 0, 0],
    blocks: [{ task_id: 'pot', position: [0, 0, 0], block_id: 'minecraft:flower_pot', properties: {} }],
  }, anchor), /block entity/)
  assert.throws(() => specFromRawFixture({
    normalization_origin: [0, 0, 0],
    blocks: [{ task_id: 'banner', position: [1, 0, 0], block_id: 'minecraft:white_banner', properties: {}, nbt: { Patterns: [] } }],
  }, anchor), /NBT/)
})
