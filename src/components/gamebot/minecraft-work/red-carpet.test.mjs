import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RED_CARPET_WORLD_ID, redCarpetSite, posKey } from './model.mjs'
import { createProject } from './project.mjs'
import { createStore } from './store.mjs'
import { createSimWorld, bindSimToMember, resetSimOpIds } from './simulation.mjs'
import { scheduledClaim, reconcileAndMaybeReclaim } from './schedule.mjs'
import { runUntilPause } from './loop.mjs'
import { voluntaryRelease, dispatchPlace, resetExecuteOpIds } from './execute.mjs'
import { runRedCarpetHandover, buildRedCarpetFixture } from './red-carpet.mjs'
import { migrateProject, storageFileName } from './migrate.mjs'
import { reserve } from './materials.mjs'
import { tickOwnership } from './ownership.mjs'
import { rebuildProgressFromWorld, verifySite } from './reconcile.mjs'
import { usableClaim } from './claims.mjs'

const KEY = Buffer.from('red-carpet-test')
const NOW = 1_800_000_000

function pathBlocks() {
  const blocks = []
  for (let x = 0; x < 5; x++) blocks.push({ x: 100 + x, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} })
  return blocks
}

test('red carpet handover: A partial then B finishes exact targets', async () => {
  resetExecuteOpIds()
  resetSimOpIds()
  const result = await runRedCarpetHandover({ trace: () => {} })
  assert.equal(result.verified.ok, true)
  assert.equal(result.record.remaining_cells.length, 0)
  for (let x = 0; x < 5; x++) {
    const key = posKey({ x: 100 + x, y: 65, z: 200 })
    assert.equal(result.record.verified_cells.includes(key), true)
  }
})

test('simultaneous claims and overlapping workspace cannot both succeed', async () => {
  const project = createProject(redCarpetSite(), { id: 'rc', now: NOW, world_id: RED_CARPET_WORLD_ID, material_stock: { 'minecraft:red_carpet': 5 } })
  const sim = createSimWorld({ clock: () => NOW, blocks: pathBlocks(), agents: { alpha: { x: 100, y: 64, z: 201 }, beta: { x: 101, y: 64, z: 201 } } })
  const a = scheduledClaim(project, { member_id: 'alpha', task_id: 'carpet', now: NOW, key: KEY, agent_pos: sim.agentPos('alpha'), snapshot: sim.observeFor('alpha') })
  assert.equal(a.ok, true)
  const b = scheduledClaim(a.project, { member_id: 'beta', task_id: 'carpet', now: NOW, key: KEY, agent_pos: sim.agentPos('beta'), snapshot: sim.observeFor('beta') })
  assert.equal(b.ok, false)
  const poor = createProject(redCarpetSite(), { id: 'rc2', now: NOW, world_id: RED_CARPET_WORLD_ID, material_stock: { 'minecraft:red_carpet': 1 } })
  const one = scheduledClaim(poor, { member_id: 'alpha', task_id: 'carpet', now: NOW, key: KEY, agent_pos: { x: 100, y: 64, z: 201 }, snapshot: sim.observeFor('alpha') })
  assert.equal(one.ok, false)
})

test('stale delayed operation cannot mutate after revocation', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const project = createProject(redCarpetSite(), { id: 'stale', now, world_id: RED_CARPET_WORLD_ID, material_stock: { 'minecraft:red_carpet': 5 } })
  project.tasks[0].checkpoint = false
  const sim = createSimWorld({ clock: () => now, blocks: pathBlocks(), agents: { alpha: { x: 100, y: 64, z: 201 } } })
  const claimed = scheduledClaim(project, { member_id: 'alpha', task_id: 'carpet', now, key: KEY, agent_pos: sim.agentPos('alpha'), snapshot: sim.observeFor('alpha') })
  const world = bindSimToMember(sim, 'alpha')
  world._delay = 5
  const cell = claimed.project.cells.find((c) => posKey(c) === '100,65,200')
  const claim = usableClaim(claimed.project, 'carpet', now).claim
  await dispatchPlace(claimed.project, world, claim, cell, { now, delay: 5, globalInflight: claimed.project.inflight })
  voluntaryRelease(claimed.project, 'carpet', 'alpha', now + 1, KEY, world)
  now += 6
  sim.advanceTime(now)
  const stale = await dispatchPlace(claimed.project, world, claim, cell, { now, operation_id: 'op-dup', globalInflight: claimed.project.inflight })
  assert.equal(stale.ok, false)
})

test('lost ack reconciles from snapshot; wrong state not accepted', async () => {
  let now = NOW
  const { project, sim } = buildRedCarpetFixture({ now })
  const snap = sim.observeFor('alpha')
  snap.complete = true
  sim.setBlock({ x: 100, y: 65, z: 200 }, 'minecraft:red_carpet', {})
  sim.observeFor('alpha').complete = true
  const snap2 = sim.observeFor('alpha')
  snap2.complete = true
  rebuildProgressFromWorld(project, snap2)
  assert.equal(project.progress.done.length >= 1, true)
  sim.setBlock({ x: 101, y: 65, z: 200 }, 'minecraft:oak_stairs', { facing: 'north' })
  const bad = verifySite(project, snap)
  assert.equal(bad.ok, false)
})

test('world identity: distinct worlds do not share storage file', () => {
  assert.notEqual(storageFileName('world-a', 'p1'), storageFileName('world-b', 'p1'))
  const legacy = migrateProject({ id: 'old' })
  assert.equal(legacy.legacy_blocked, true)
})

test('save reload preserves reconciling state without unsafe replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-rc-save-'))
  try {
    const store = createStore(dir)
    const project = createProject(redCarpetSite(), { id: 'save', now: NOW, world_id: RED_CARPET_WORLD_ID, material_stock: { 'minecraft:red_carpet': 5 } })
    project.inflight.push({ operation_id: 'op-u', task_id: 'carpet', member_id: 'alpha', status: 'unknown', sent: true })
    project.loop.phase = 'unknown'
    store.write(project)
    const loaded = store.read('save', RED_CARPET_WORLD_ID)
    assert.equal(loaded.inflight.length, 1)
    assert.equal(loaded.loop.phase, 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeat without progress enters reconciliation', () => {
  const project = createProject(redCarpetSite(), { id: 'hb', now: NOW, world_id: RED_CARPET_WORLD_ID })
  project.claims.push({
    tid: 'carpet', mid: 'alpha', status: 'active', gen: 1, exp: NOW + 999,
    claimed_at: NOW, heartbeat_at: NOW + 200, verified_progress_at: NOW,
  })
  project.tasks[0].status = 'running'
  tickOwnership(project, NOW + 130)
  assert.equal(project.tasks[0].status, 'reconciling')
})
