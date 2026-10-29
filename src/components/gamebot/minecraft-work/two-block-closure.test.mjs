import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expand } from './blueprint.mjs'
import { specFromRawFixture } from './raw-blocks.mjs'
import { createProjectFromRawFixture } from './project.mjs'
import { posKey } from './model.mjs'
import { scheduledClaim } from './schedule.mjs'
import { runUntilPause } from './loop.mjs'
import { createSimWorld, bindSimToMember, resetSimOpIds } from './simulation.mjs'
import { resetExecuteOpIds } from './execute.mjs'
import { handoverRecord, verifySite } from './reconcile.mjs'
import { authoritativeSnapshot, completionDecision, preflightProblems } from './two-block-live.mjs'
import { snapshotBlock } from './blocks.mjs'

const KEY = Buffer.from('two-block-closure')
const NOW = 1_900_000_000
const ORACLE_ANCHOR = { dimension: 'minecraft:overworld', x: 100, y: 64, z: 100, facing: 'east' }
const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'two-block-diorite.json'), 'utf8'))

test('raw fixture import expands to oracle cells at anchor east', () => {
  const spec = specFromRawFixture(fixture, ORACLE_ANCHOR)
  const built = expand(spec)
  const floor = built.cells.find((c) => c.part_id === 'two_block_floor')
  const stair = built.cells.find((c) => c.part_id === 'two_block_stair')
  assert.equal(posKey(floor), '100,64,101')
  assert.equal(floor.block_id, 'minecraft:polished_diorite')
  assert.equal(posKey(stair), '100,65,101')
  assert.equal(stair.block_id, 'minecraft:polished_diorite_stairs')
  assert.deepEqual(stair.state, { half: 'bottom', waterlogged: 'false', shape: 'straight', facing: 'west' })
  const out = built.cells.filter((c) => c.kind === 'out_of_scope')
  assert.equal(out.length, fixture.excludes.length)
})

test('offline e2e: floor placed, missing stair stock stops claim with handover (in-memory sim world)', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  const project = createProjectFromRawFixture(fixture, ORACLE_ANCHOR, {
    id: 'two-block',
    now: NOW,
    world_id: 'test-two-block-v1',
    fill_test_stock: false,
    material_stock: {
      'minecraft:polished_diorite': 1,
      'minecraft:polished_diorite_stairs': 0,
    },
  })
  assert.equal(project.tasks.find((t) => t.id === 'two_block_stair').status, 'blocked')
  const support = { x: 100, y: 63, z: 101, block_id: 'minecraft:stone', state: {} }
  const sim = createSimWorld({
    clock: () => NOW,
    blocks: [support],
    agents: { builder: { x: 99, y: 64, z: 101 } },
  })
  const world = bindSimToMember(sim, 'builder')
  let snap = sim.observeFor('builder')
  const floorClaim = scheduledClaim(project, {
    member_id: 'builder',
    task_id: 'two_block_floor',
    now: NOW,
    key: KEY,
    agent_pos: snap.agent,
    snapshot: snap,
  })
  assert.equal(floorClaim.ok, true)
  Object.assign(project, floorClaim.project)
  project.tasks.find((t) => t.id === 'two_block_floor').status = 'running'
  await runUntilPause(project, world, { now: NOW, memberId: 'builder', globalInflight: project.inflight })
  snap = sim.observeFor('builder')
  const floorKey = '100,64,101'
  assert.equal(project.progress.done.includes(floorKey), true)
  project.tasks.find((t) => t.id === 'two_block_floor').status = 'done'
  const stairClaim = scheduledClaim(project, {
    member_id: 'builder',
    task_id: 'two_block_stair',
    now: NOW,
    key: KEY,
    agent_pos: snap.agent,
    snapshot: snap,
  })
  assert.equal(stairClaim.ok, false)
  assert.match(stairClaim.error, /仓库库存不足/)
  const record = handoverRecord(project, snap, { reason: 'material_shortage' })
  assert.equal(record.verified_cells.includes(floorKey), true)
  assert.equal(record.remaining_cells.includes('100,65,101'), true)
  assert.equal(record.unavailable_materials.some((s) => s.item_id === 'minecraft:polished_diorite_stairs'), true)
  assert.equal(record.stop_reason, 'material_shortage')
  assert.deepEqual(record.unresolved_operations, [])
  const placed = sim.getBlock({ x: 100, y: 65, z: 101 })
  assert.equal(placed.block_id, 'minecraft:air')
})

test('resume with stair material does not re-place floor', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  const project = createProjectFromRawFixture(fixture, ORACLE_ANCHOR, {
    id: 'two-block-resume',
    now: NOW,
    world_id: 'test-two-block-v2',
    fill_test_stock: false,
    material_stock: { 'minecraft:polished_diorite': 1, 'minecraft:polished_diorite_stairs': 1 },
  })
  const support = { x: 100, y: 63, z: 101, block_id: 'minecraft:stone', state: {} }
  const floorPlaced = { x: 100, y: 64, z: 101, block_id: 'minecraft:polished_diorite', state: {} }
  const sim = createSimWorld({
    clock: () => NOW,
    blocks: [support, floorPlaced],
    agents: { builder: { x: 99, y: 64, z: 101 } },
  })
  const world = bindSimToMember(sim, 'builder')
  project.progress.done = ['100,64,101']
  project.tasks.find((t) => t.id === 'two_block_floor').status = 'done'
  const snap = sim.observeFor('builder')
  const stairClaim = scheduledClaim(project, {
    member_id: 'builder',
    task_id: 'two_block_stair',
    now: NOW,
    key: KEY,
    agent_pos: snap.agent,
    snapshot: snap,
  })
  assert.equal(stairClaim.ok, true)
  Object.assign(project, stairClaim.project)
  project.tasks.find((t) => t.id === 'two_block_stair').status = 'running'
  let placeCount = 0
  const origAct = world.act.bind(world)
  world.act = async (action) => {
    if (action.action === 'place_block') placeCount += 1
    return origAct(action)
  }
  await runUntilPause(project, world, { now: NOW, memberId: 'builder', globalInflight: project.inflight })
  assert.equal(placeCount, 1)
  const finalSnap = sim.observeFor('builder')
  const verified = verifySite(project, finalSnap)
  assert.equal(verified.ok, true)
  const stair = sim.getBlock({ x: 100, y: 65, z: 101 })
  assert.equal(stair.block_id, 'minecraft:polished_diorite_stairs')
  assert.equal(stair.state.facing, 'west')
  assert.equal(stair.state.half, 'bottom')
  assert.equal(stair.state.shape, 'straight')
  assert.equal(stair.state.waterlogged, 'false')
})

test('live completion refuses mismatch, unknown, and step exhaustion without marking done', () => {
  assert.deepEqual(completionDecision({ paused: 'task_done', steps: 2, probeOk: true, matches: false }), {
    done: false, exitCode: 10, reason: 'readback_mismatch',
  })
  assert.deepEqual(completionDecision({ paused: 'task_done', steps: 2, probeOk: false, matches: false }), {
    done: false, exitCode: 11, reason: 'probe_unknown',
  })
  assert.deepEqual(completionDecision({ paused: 'running', steps: 50, probeOk: true, matches: true }), {
    done: false, exitCode: 9, reason: 'step_limit',
  })
  assert.equal(completionDecision({ paused: 'verify_failed', steps: 1, probeOk: true, matches: true }).done, false)
  const task = { status: 'running' }
  const decision = completionDecision({ paused: 'task_done', steps: 1, probeOk: true, matches: false })
  if (decision.done) task.status = 'done'
  assert.equal(task.status, 'running')
})

test('preflight stops when a target was not actually read as air', () => {
  const cells = {
    floor: { x: 10, y: 64, z: 10, block_id: 'minecraft:polished_diorite', state: {} },
    stair: { x: 10, y: 65, z: 10, block_id: 'minecraft:polished_diorite_stairs', state: { facing: 'west', half: 'bottom', shape: 'straight', waterlogged: 'false' } },
    support: { x: 10, y: 63, z: 10 },
    around: [{ x: 11, y: 65, z: 10 }, { x: 9, y: 65, z: 10 }, { x: 10, y: 65, z: 11 }, { x: 10, y: 65, z: 9 }, { x: 10, y: 66, z: 10 }],
  }
  const cell = (pos, block_id, state = {}) => ({ pos, loaded: true, block_id, state })
  const probe = {
    ok: true,
    dimension: 'minecraft:overworld',
    game_time: 5,
    probe_seq: 1,
    before_seq: 0,
    cells: [
      cell(cells.support, 'minecraft:stone'),
      cell(cells.floor, 'minecraft:air'),
      cell({ x: 10, y: 65, z: 10 }, 'minecraft:air'),
      ...cells.around.map((pos) => cell(pos, 'minecraft:air')),
    ],
  }
  const anchor = { dimension: 'minecraft:overworld' }
  const hotbar = { 'minecraft:polished_diorite': 1, 'minecraft:polished_diorite_stairs': 1 }
  const agent = { x: 10.5, y: 64, z: 10.5 }
  assert.deepEqual(preflightProblems({ probe, anchor, cells, hotbar, envStock: hotbar, agent }), [])
  const hidden = { ...probe, cells: probe.cells.map((item) => item.pos.y === 65 && item.pos.x === 10 && item.pos.z === 10 ? { ...item, loaded: false, block_id: null } : item) }
  assert.match(preflightProblems({ probe: hidden, anchor, cells, hotbar, envStock: hotbar, agent }).join('\n'), /unknown/)
  assert.match(preflightProblems({ probe, anchor, cells, hotbar, envStock: hotbar, agent: { x: 80, y: 64, z: 80 } }).join('\n'), /out of reach/)
})

test('an explicit air probe is a cell reading; a nearby omission is not', () => {
  const agent = { x: 10.2, y: 64.1, z: 10.2 }
  const pos = { x: 10, y: 65, z: 11 }
  const snap = authoritativeSnapshot(agent, {
    dimension: 'minecraft:overworld',
    cells: [{ pos, loaded: true, block_id: 'minecraft:air', state: {} }],
  }, [pos])
  assert.equal(snap.complete, true)
  assert.equal(snap.omits_air, false)
  assert.equal(snapshotBlock(snap, pos).block_id, 'minecraft:air')
  const nearby = { complete: false, omits_air: true, nearby_truncated: true, origin: snap.origin, radius: 16, blocks: [] }
  assert.equal(snapshotBlock(nearby, pos).unknown, true)
})

test('unsupported raw input fails clearly', () => {
  assert.throws(() => specFromRawFixture({ normalization_origin: [0, 0, 0], blocks: [] }, ORACLE_ANCHOR), /blocks 不能为空/)
  assert.throws(() => specFromRawFixture({
    normalization_origin: [0, 0, 0],
    blocks: [{ task_id: 'a', position: [1, 2, 3], block_id: 'bad id' }],
  }, ORACLE_ANCHOR), /block_id/)
})
