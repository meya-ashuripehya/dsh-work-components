import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RED_CARPET_WORLD_ID, redCarpetSite, posKey } from './model.mjs'
import { createProject } from './project.mjs'
import { createSimWorld, bindSimToMember, resetSimOpIds } from './simulation.mjs'
import { claimWork } from './schedule.mjs'
import { dispatchPlace, voluntaryRelease, resetExecuteOpIds } from './execute.mjs'
import { usableClaim } from './claims.mjs'
import { reserve, warehouseSnapshot } from './materials.mjs'
import { finishReconciliation } from './handoff.mjs'
import { step } from './loop.mjs'
import { createWorkRuntime, createWorkTools } from './tools.mjs'
import { checkSchedulingInvariants } from './invariants.mjs'

const KEY = Buffer.from('safety-regression')
const NOW = 1_900_000_000

test('regression: revoked delayed sim placement does not mutate world or consume stock', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const project = createProject(redCarpetSite(), {
    id: 'delay',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 5 },
  })
  project.tasks[0].checkpoint = false
  const baseline = warehouseSnapshot(project)
  const sim = createSimWorld({
    clock: () => now,
    blocks: [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }],
    agents: { alpha: { x: 100, y: 64, z: 201 } },
  })
  const claimed = claimWork(project, {
    member_id: 'alpha',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: sim.agentPos('alpha'),
    snapshot: sim.observeFor('alpha'),
  })
  assert.equal(claimed.ok, true)
  const world = bindSimToMember(sim, 'alpha')
  const cell = claimed.project.cells.find((c) => posKey(c) === '100,65,200')
  const claim = usableClaim(claimed.project, 'carpet', now).claim
  const beforeBlocks = [...sim.blockMap.keys()]
  const beforeStock = warehouseSnapshot(claimed.project)
  await dispatchPlace(claimed.project, world, claim, cell, { now, delay: 5, globalInflight: claimed.project.inflight })
  voluntaryRelease(claimed.project, 'carpet', 'alpha', now + 1, KEY, world)
  now += 10
  sim.advanceTime(now)
  assert.deepEqual([...sim.blockMap.keys()], beforeBlocks)
  assert.deepEqual(warehouseSnapshot(claimed.project), beforeStock)
  assert.deepEqual(beforeStock, baseline)
})

test('regression: confirmed ack without world effect does not credit progress', async () => {
  resetExecuteOpIds()
  const project = createProject(redCarpetSite(), {
    id: 'false-ok',
    now: NOW,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 5 },
  })
  project.tasks[0].checkpoint = false
  const claimed = claimWork(project, {
    member_id: 'alpha',
    task_id: 'carpet',
    now: NOW,
    key: KEY,
    agent_pos: { x: 100, y: 64, z: 201 },
    snapshot: { complete: true, origin: { x: 100, y: 64, z: 201 }, agent: { x: 100, y: 64, z: 201 }, radius: 16, blocks: [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }] },
  })
  const cell = claimed.project.cells[0]
  const claim = usableClaim(claimed.project, 'carpet', NOW).claim
  let observeCalls = 0
  const world = {
    member_id: 'alpha',
    agent: { x: 100, y: 64, z: 201 },
    observe() {
      observeCalls++
      return {
        complete: true,
        origin: { x: 100, y: 64, z: 201 },
        agent: { x: 100, y: 64, z: 201 },
        radius: 16,
        blocks: [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }],
      }
    },
    async reloadObservation() {
      observeCalls++
      return world.observe()
    },
    async act() {
      return { ok: true, effect: 'confirmed', operation_id: 'fake-1' }
    },
  }
  const result = await dispatchPlace(claimed.project, world, claim, cell, { now: NOW, globalInflight: claimed.project.inflight })
  assert.equal(result.ok, false)
  assert.match(result.error, /世界状态未匹配/)
  assert.equal(observeCalls >= 2, true)
  assert.equal(claimed.project.progress.done.length, 0)
})

test('regression: warehouse stock cannot be double-collected by two workers', () => {
  const project = createProject(redCarpetSite(), {
    id: 'mat',
    now: NOW,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 5 },
  })
  const baseline = warehouseSnapshot(project)
  const a = reserve(project, { member_id: 'alpha', item_id: 'minecraft:red_carpet', qty: 5, now: NOW, collect: true })
  assert.equal(a.ok, true)
  const b = reserve(project, { member_id: 'beta', item_id: 'minecraft:red_carpet', qty: 5, now: NOW, collect: true })
  assert.equal(b.ok, false)
  const inv = checkSchedulingInvariants(project, { baselineTotals: baseline })
  assert.equal(inv.ok, true)
  assert.equal(project.materials.items['minecraft:red_carpet'].stock, 0)
  assert.equal(project.materials.items['minecraft:red_carpet'].carried.alpha, 5)
})

test('regression: reconciliation blocks while worker still occupies workspace envelope', () => {
  const project = createProject(redCarpetSite(), {
    id: 'ws',
    now: NOW,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 5 },
  })
  const sim = createSimWorld({
    clock: () => NOW,
    blocks: [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }],
    agents: { alpha: { x: 100, y: 64, z: 201 } },
  })
  const claimed = claimWork(project, {
    member_id: 'alpha',
    task_id: 'carpet',
    now: NOW,
    key: KEY,
    agent_pos: sim.agentPos('alpha'),
    snapshot: sim.observeFor('alpha'),
  })
  claimed.project.tasks[0].status = 'reconciling'
  const snap = sim.observeFor('alpha')
  const blocked = finishReconciliation(claimed.project, {
    task_id: 'carpet',
    now: NOW,
    key: KEY,
    snapshot: snap,
    evidence: { agentPositions: sim.agentPositions(), pendingOperationIds: [], now: NOW },
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.issues?.[0]?.kind, 'workspace_occupied')
  sim.setAgent('alpha', { x: 130, y: 64, z: 230 })
  const cleared = finishReconciliation(claimed.project, {
    task_id: 'carpet',
    now: NOW + 1,
    key: KEY,
    snapshot: sim.observeFor('alpha'),
    evidence: { agentPositions: sim.agentPositions(), pendingOperationIds: [], now: NOW + 1 },
  })
  assert.equal(cleared.ok, true)
})

test('tool runtime red-carpet handover via mc_task_claim shared path', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  const dir = mkdtempSync(join(tmpdir(), 'mc-tool-rc-'))
  let runtime = null
  try {
    let now = NOW
    let actSeq = 0
    const blocks = []
    for (let x = 0; x < 5; x++) blocks.push({ x: 100 + x, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} })
    const agents = { alpha: { x: 100, y: 64, z: 201 }, beta: { x: 106, y: 64, z: 201 } }
    runtime = createWorkRuntime({
      dir,
      manual: true,
      now: () => now,
      observeMember: async (project, memberId) => ({
        complete: true,
        origin: agents[memberId],
        agent: agents[memberId],
        member_id: memberId,
        radius: 16,
        blocks: project._blocks?.length ? project._blocks : blocks,
      }),
      observe: async (project) => ({
        complete: true,
        origin: agents.alpha,
        agent: agents.alpha,
        radius: 16,
        blocks: project._blocks || blocks,
      }),
      act: async (project, action) => {
        if (action.action === 'place_block') {
          project._blocks = project._blocks || [...blocks]
          const pos = action.params.pos
          project._blocks = project._blocks.filter((b) => b.x !== pos.x || b.y !== pos.y || b.z !== pos.z)
          project._blocks.push({ ...pos, block_id: action.params.block_id, state: action.params.state || {} })
        }
        return { ok: true, effect: 'confirmed', operation_id: `tool-${++actSeq}` }
      },
    })
    const cfg = {
      chatroomSeats: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }],
      gb_minecraft_MC_AGENTS: JSON.stringify([
        { code: 'alpha', enabled: true },
        { code: 'beta', enabled: true },
      ]),
    }
    const tools = Object.fromEntries(createWorkTools({ getConfig: () => cfg, runtime }).map((t) => [t.name, t]))
    const seat = (id) => ({ game: { caller: { memberId: id } } })
    await tools.mc_blueprint_submit.execute({ project_id: 'rc', world_id: RED_CARPET_WORLD_ID, ...redCarpetSite() }, seat('alpha'))
    const project = runtime.store.read('rc', RED_CARPET_WORLD_ID)
    project.tasks[0].checkpoint = false
    project.materials.items['minecraft:red_carpet'].stock = 10
    runtime.store.write(project)
    await tools.mc_task_claim.execute({ project_id: 'rc', world_id: RED_CARPET_WORLD_ID, task_id: 'carpet' }, seat('alpha'))
    await runtime.tick('rc', RED_CARPET_WORLD_ID)
    await runtime.tick('rc', RED_CARPET_WORLD_ID)
    const mid = runtime.store.read('rc', RED_CARPET_WORLD_ID)
    assert.equal(mid.progress.done.length, 2)
    assert.equal(checkSchedulingInvariants(mid, { taskId: 'carpet' }).ok, true)
  } finally {
    runtime?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
