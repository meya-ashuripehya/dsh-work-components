import test from 'node:test'
import assert from 'node:assert/strict'
import { claimTask } from './claims.mjs'
import { requestStop } from './control.mjs'
import { runUntilPause } from './loop.mjs'
import { parseKey, posKey, testSite } from './model.mjs'
import { createProject } from './project.mjs'
import { classifyCell } from './reconcile.mjs'
import { reserve } from './materials.mjs'

const NOW = 1_700_000_000
const KEY = Buffer.from('k')
const WORLD = 'test-world'

function projectOf(spec = testSite(), id = 'site') {
  return createProject(spec, { id, now: NOW, world_id: WORLD, fill_test_stock: true })
}

function armMaterials(project, memberId) {
  for (const [itemId, item] of Object.entries(project.materials.items)) {
    if (item.gap > 0) reserve(project, { member_id: memberId, item_id: itemId, qty: item.gap, now: NOW, collect: true })
  }
}

function worldAt(agent, blocks = [], radius = 16) {
  const blocksMap = new Map(blocks.map((block) => [posKey(block), block.block_id]))
  return {
    agent: { ...agent },
    blocks: blocksMap,
    acts: [],
    act(action) {
      this.acts.push(action)
      if (action.action === 'move_to') this.agent = { x: action.params.x, y: action.params.y, z: action.params.z }
      if (action.action === 'place_block') this.blocks.set(posKey(action.params.pos), action.params.block_id)
      return { ok: true, effect: 'confirmed' }
    },
    observe() {
      return {
        complete: true,
        origin: { x: this.agent.x, y: this.agent.y, z: this.agent.z },
        radius,
        blocks: [...this.blocks].map(([key, block_id]) => ({ ...parseKey(key), block_id, state: {} })),
      }
    },
  }
}

test('平台做完停在检查点，墙上的方块一次都没放', async () => {
  const project = projectOf()
  claimTask(project, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  armMaterials(project, 'alpha')
  const world = worldAt({ x: -1, y: 64, z: 0 })
  const result = await runUntilPause(project, world, { now: NOW })
  assert.equal(result.paused, 'checkpoint')
  assert.equal(project.tasks.find((task) => task.id === 'floor').status, 'checkpoint')
  assert.equal(world.acts.some((action) => action.action === 'place_block' && action.params.pos.y !== 64), false)
  assert.equal(world.acts.filter((action) => action.action === 'break_block').length, 0)
})

test('门洞箱子不会被拆；扫描盒外的格子让循环停住', async () => {
  const project = projectOf()
  project.tasks.find((task) => task.id === 'floor').status = 'done'
  project.tasks.find((task) => task.id === 'front').status = 'claimable'
  claimTask(project, { member_id: 'alpha', task_id: 'front', now: NOW, key: KEY })
  armMaterials(project, 'alpha')
  const world = worldAt({ x: 2, y: 65, z: 1 }, [{ x: 2, y: 65, z: 0, block_id: 'minecraft:chest' }])
  const conflict = await runUntilPause(project, world, { now: NOW })
  assert.equal(conflict.paused, 'conflict')
  assert.equal(world.acts.filter((action) => action.action === 'break_block' || action.action === 'attack_block').length, 0)
  assert.equal(world.acts.some((action) => action.params?.pos && posKey(action.params.pos) === '2,65,0'), false)
  const again = projectOf(testSite(), 'far')
  claimTask(again, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  armMaterials(again, 'alpha')
  const far = worldAt({ x: 100, y: 64, z: 100 }, [], 1)
  const unknown = await runUntilPause(again, far, { now: NOW })
  assert.equal(unknown.paused, 'unknown')
  assert.equal(far.acts.length, 0)
  assert.equal(classifyCell({ x: 2, y: 65, z: 0 }, far.observe()), 'unknown')
})

test('停止之后不再动作；超过步数上限的下一步不发出', async () => {
  const project = projectOf()
  claimTask(project, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  armMaterials(project, 'alpha')
  const world = worldAt({ x: 0, y: 64, z: 1 })
  project.loop.cap = 1
  const first = await runUntilPause(project, world, { now: NOW })
  assert.equal(first.paused, 'cap')
  assert.equal(world.acts.length, 1)
  const stopped = projectOf(testSite(), 'stop')
  claimTask(stopped, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  armMaterials(stopped, 'alpha')
  const site = worldAt({ x: 0, y: 64, z: 1 })
  requestStop(stopped, NOW)
  const after = await runUntilPause(stopped, site, { now: NOW })
  assert.equal(after.paused, 'stopped')
  assert.equal(site.acts.length, 0)
})

test('四周被占满且没有脚手架时交回，不放置图纸方块', async () => {
  const project = projectOf({
    anchor: { x: 0, y: 64, z: 0, facing: 'south' },
    parts: [{ kind: 'platform', id: 'floor', x: 0, y: 0, z: 0, width: 1, depth: 1, block_id: 'minecraft:stone' }],
  }, { id: 'tight', now: NOW })
  claimTask(project, { member_id: 'alpha', task_id: 'floor', now: NOW, key: KEY })
  armMaterials(project, 'alpha')
  const blocks = [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [
    { x: dx, y: 64, z: dz, block_id: 'minecraft:stone' },
    { x: dx, y: 63, z: dz, block_id: 'minecraft:stone' },
  ])
  const world = worldAt({ x: 8, y: 64, z: 8 }, blocks, 16)
  const result = await runUntilPause(project, world, { now: NOW })
  assert.equal(result.paused, 'handback')
  assert.equal(world.acts.some((action) => action.action === 'place_block'), false)
})
