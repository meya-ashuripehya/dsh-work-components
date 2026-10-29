import test from 'node:test'
import assert from 'node:assert/strict'
import { expand } from './blueprint.mjs'
import { posKey, testSite } from './model.mjs'

test('5×5 平台、墙和门洞按夹具展开，门洞必须为空且不能拆', () => {
  const built = expand(testSite())
  assert.equal(built.cells.length, 40)
  const specified = built.cells.filter((cell) => cell.kind === 'specified')
  const empty = built.cells.filter((cell) => cell.kind === 'required_empty')
  assert.equal(specified.length, 38)
  assert.equal(empty.length, 2)
  assert.deepEqual(empty.map((cell) => posKey(cell)).sort(), ['2,65,0', '2,66,0'])
  assert.equal(empty.every((cell) => cell.grants_break === false && cell.block_id == null), true)
  const doorTop = built.cells.find((cell) => posKey(cell) === '2,67,0')
  assert.equal(doorTop.kind, 'specified')
  assert.equal(doorTop.block_id, 'minecraft:oak_planks')
})

test('省略朝向时采用 south 并写进默认值；非法朝向、缺材料和无规则重叠都报错', () => {
  const spec = testSite()
  delete spec.anchor.facing
  const built = expand(spec)
  assert.equal(built.anchor.facing, 'south')
  assert.equal(built.applied_defaults.some((item) => item.field === 'anchor.facing' && item.value === 'south'), true)
  assert.throws(() => expand({ ...testSite(), anchor: { ...testSite().anchor, facing: 'up' } }), /朝向无效/)
  const missing = testSite()
  delete missing.parts[0].block_id
  assert.throws(() => expand(missing), /block_id/)
  assert.throws(() => expand({
    anchor: { x: 0, y: 64, z: 0, facing: 'south' },
    parts: [
      { kind: 'platform', id: 'a', x: 0, y: 0, z: 0, width: 2, depth: 2, block_id: 'minecraft:stone' },
      { kind: 'platform', id: 'b', x: 1, y: 0, z: 1, width: 2, depth: 2, block_id: 'minecraft:stone' },
    ],
  }), /重叠没有规则/)
  assert.throws(() => expand({
    anchor: { x: 0, y: 64, z: 0, facing: 'south' },
    parts: [{ kind: 'opening', id: 'door', offset: 0, width: 1, height: 1 }],
  }), /开口必须指明所在的墙/)
})

test('朝北时本地 +x 转到世界 -x', () => {
  const built = expand({
    anchor: { x: 10, y: 64, z: 20, facing: 'north' },
    parts: [{ kind: 'platform', id: 'pad', x: 1, y: 0, z: 0, width: 1, depth: 1, block_id: 'minecraft:stone' }],
  })
  assert.equal(posKey(built.cells[0]), '9,64,20')
})
