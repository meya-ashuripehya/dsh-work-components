import test from 'node:test'
import assert from 'node:assert/strict'
import { expand } from './blueprint.mjs'
import { testSite } from './model.mjs'
import { preview } from './preview.mjs'

test('门洞上的箱子标为冲突，不进入拆除清单', () => {
  const built = expand(testSite())
  const view = preview(built, { blocks: [{ x: 2, y: 65, z: 0, block_id: 'minecraft:chest' }] })
  assert.deepEqual(view.conflicts, [{ pos: '2,65,0', block_id: 'minecraft:chest', reason: '必须为空的位置上已有方块' }])
  assert.equal(view.remove.length, 0)
  assert.equal(view.remove.some((item) => item.pos === '2,65,0'), false)
  assert.equal(view.materials['minecraft:oak_planks'], 38)
  assert.equal(view.add.includes('0,64,0'), true)
})
