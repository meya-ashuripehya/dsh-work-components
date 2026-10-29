import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RED_CARPET_WORLD_ID, redCarpetSite, posKey } from './model.mjs'
import { createProject } from './project.mjs'
import { createSimWorld, bindSimToMember, resetSimOpIds } from './simulation.mjs'
import { claimWork } from './schedule.mjs'
import { dispatchPlace, voluntaryRelease, resetExecuteOpIds } from './execute.mjs'
import { tickOwnership } from './ownership.mjs'
import { step } from './loop.mjs'
import { handoverRecord } from './reconcile.mjs'
import { createWorkRuntime, createWorkTools } from './tools.mjs'
import { checkSchedulingInvariants } from './invariants.mjs'
import { warehouseSnapshot } from './materials.mjs'
import { finishReconciliation } from './handoff.mjs'

const KEY = Buffer.from('dispatch-authority-regression')
const NOW = 1_950_000_000

function seat(id) {
  return { game: { caller: { memberId: id } } }
}

function toolCfg() {
  return {
    chatroomSeats: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }],
    gb_minecraft_MC_AGENTS: JSON.stringify([
      { code: 'alpha', enabled: true },
      { code: 'beta', enabled: true },
    ]),
  }
}

test('stop vs in-flight tick: delayed placement must not resurrect running or clear stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stop-tick-'))
  let now = NOW
  resetSimOpIds()
  resetExecuteOpIds()
  const blocks = [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }]
  const agents = { alpha: { x: 100, y: 64, z: 201 } }
  const sim = createSimWorld({ clock: () => now, blocks, agents })
  let runtime = null
  try {
    runtime = createWorkRuntime({
      dir,
      manual: true,
      now: () => now,
      observeMember: async (_project, memberId) => sim.observeFor(memberId),
      observe: async () => sim.observeFor('alpha'),
      act: async (_project, action) => sim.act(action, { member_id: 'alpha', delay: action.delay ?? 5, dropAck: action.dropAck }),
    })
    const tools = Object.fromEntries(createWorkTools({ getConfig: () => toolCfg(), runtime }).map((t) => [t.name, t]))
    await tools.mc_blueprint_submit.execute(
      { project_id: 'stop-race', world_id: RED_CARPET_WORLD_ID, ...redCarpetSite() },
      seat('alpha'),
    )
    const seeded = runtime.store.read('stop-race', RED_CARPET_WORLD_ID)
    seeded.tasks[0].checkpoint = false
    seeded.materials.items['minecraft:red_carpet'].stock = 10
    runtime.store.write(seeded)
    await tools.mc_task_claim.execute({ project_id: 'stop-race', world_id: RED_CARPET_WORLD_ID, task_id: 'carpet' }, seat('alpha'))
    runtime.start('stop-race', RED_CARPET_WORLD_ID)
    const tickPromise = runtime.tick('stop-race', RED_CARPET_WORLD_ID)
    for (let i = 0; i < 80; i++) {
      const mid = runtime.store.read('stop-race', RED_CARPET_WORLD_ID)
      if (sim.pendingCount() > 0 && mid.inflight.some((e) => e.sent && (e.status === 'inflight' || e.status === 'unknown'))) break
      await new Promise((r) => setTimeout(r, 2))
    }
    const stopped = await tools.mc_work_stop.execute({ project_id: 'stop-race' }, seat('alpha'))
    assert.equal(stopped.stopped, false)
    await tickPromise
    const after = runtime.store.read('stop-race', RED_CARPET_WORLD_ID)
    sim.syncAuthority(after)
    now += 20
    sim.advanceTime(now)
    assert.equal(after.control.execution, 'stopping')
    assert.notEqual(after.control.stop?.phase, null)
    assert.notEqual(after.control.execution, 'running', `execution=${after.control.execution}`)
    assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:air')
    assert.equal(after.progress.done.length, 0)
  } finally {
    runtime?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('committed effect with delayed ack is not undone when stop wins the state race', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stop-ack-'))
  let now = NOW
  resetSimOpIds()
  resetExecuteOpIds()
  const blocks = [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }]
  const sim = createSimWorld({ clock: () => now, blocks, agents: { alpha: { x: 100, y: 64, z: 201 } } })
  let runtime = null
  try {
    let resolveBarrier = null
    const ackGate = new Promise((r) => { resolveBarrier = r })
    runtime = createWorkRuntime({
      dir,
      manual: true,
      now: () => now,
      observeMember: async (_p, m) => sim.observeFor(m),
      observe: async () => sim.observeFor('alpha'),
      act: async (_p, action) => {
        const immediate = sim.act(action, { member_id: 'alpha', delay: 0 })
        if (action.action === 'place_block') {
          await ackGate
        }
        return immediate
      },
    })
    const tools = Object.fromEntries(createWorkTools({ getConfig: () => toolCfg(), runtime }).map((t) => [t.name, t]))
    await tools.mc_blueprint_submit.execute({ project_id: 'ack', world_id: RED_CARPET_WORLD_ID, ...redCarpetSite() }, seat('alpha'))
    const p0 = runtime.store.read('ack', RED_CARPET_WORLD_ID)
    p0.tasks[0].checkpoint = false
    p0.materials.items['minecraft:red_carpet'].stock = 10
    runtime.store.write(p0)
    await tools.mc_task_claim.execute({ project_id: 'ack', world_id: RED_CARPET_WORLD_ID, task_id: 'carpet' }, seat('alpha'))
    const tickP = runtime.tick('ack', RED_CARPET_WORLD_ID)
    await new Promise((r) => setTimeout(r, 2))
    await tools.mc_work_stop.execute({ project_id: 'ack' }, seat('alpha'))
    resolveBarrier()
    await tickP
    assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:red_carpet')
    const after = runtime.store.read('ack', RED_CARPET_WORLD_ID)
    assert.equal(after.progress.done.includes('100,65,200'), true)
  } finally {
    runtime?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no-progress reconciliation blocks delayed simulator placement', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const project = createProject(redCarpetSite(), {
    id: 'npt',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 5 },
  })
  project.tasks[0].checkpoint = false
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
  const world = bindSimToMember(sim, 'alpha')
  const cell = claimed.project.cells.find((c) => posKey(c) === '100,65,200')
  const claim = claimed.project.claims.find((c) => c.status === 'active')
  await dispatchPlace(claimed.project, world, claim, cell, { now, delay: 30, globalInflight: claimed.project.inflight })
  claimed.project.claims.find((c) => c.mid === 'alpha').heartbeat_at = now
  claimed.project.claims.find((c) => c.mid === 'alpha').verified_progress_at = now - 200
  tickOwnership(claimed.project, now + 121)
  world.syncAuthority(claimed.project)
  assert.equal(claimed.project.tasks[0].status, 'reconciling')
  now += 200
  sim.advanceTime(now)
  assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:air')
  voluntaryRelease(claimed.project, 'carpet', 'alpha', now, KEY, world)
  now += 1
  sim.advanceTime(now)
  assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:air')
})

test('simulator replays same operation id without second world effect or consumption', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const sim = createSimWorld({
    clock: () => now,
    blocks: [{ x: 100, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} }],
    agents: { alpha: { x: 100, y: 64, z: 201 } },
  })
  const op = 'fixed-op-1'
  const action = {
    action: 'place_block',
    operation_id: op,
    params: {
      pos: { x: 100, y: 65, z: 200 },
      block_id: 'minecraft:red_carpet',
      state: {},
      claim: { tid: 'carpet', gen: 1, mid: 'alpha', exp: now + 900 },
    },
  }
  sim.syncAuthority({ revocations: {} })
  const first = sim.act(action, { member_id: 'alpha', delay: 0 })
  assert.equal(first.effect, 'confirmed')
  sim.setBlock({ x: 100, y: 65, z: 200 }, 'minecraft:gold_block', {})
  const second = sim.act(action, { member_id: 'alpha', delay: 0 })
  assert.equal(second.effect, 'confirmed')
  assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:gold_block')
  const third = sim.act(action, { member_id: 'alpha', delay: 5 })
  now += 10
  sim.advanceTime(now)
  assert.equal(sim.getBlock({ x: 100, y: 65, z: 200 }).block_id, 'minecraft:gold_block')
})

test('successor claim demands only remaining carpet cells; B finishes with warehouse three', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const project = createProject(redCarpetSite(), {
    id: 'handoff-mat',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 8 },
  })
  project.tasks[0].checkpoint = false
  const baseline = warehouseSnapshot(project)
  const blocks = []
  for (let x = 0; x < 5; x++) blocks.push({ x: 100 + x, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} })
  const sim = createSimWorld({
    clock: () => now,
    blocks,
    agents: { alpha: { x: 100, y: 64, z: 201 }, beta: { x: 106, y: 64, z: 201 } },
  })
  let p = project
  const claimA = claimWork(p, {
    member_id: 'alpha',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: sim.agentPos('alpha'),
    snapshot: sim.observeFor('alpha'),
  })
  p = claimA.project
  const worldA = bindSimToMember(sim, 'alpha')
  for (let i = 0; i < 2; i++) {
    await step(p, worldA, { now, memberId: 'alpha', globalInflight: p.inflight })
    now += 1
    sim.advanceTime(now)
  }
  assert.equal(p.progress.done.length, 2)
  assert.equal(p.materials.items['minecraft:red_carpet'].carried.alpha, 3)
  voluntaryRelease(p, 'carpet', 'alpha', now, KEY, worldA)
  let fin = finishReconciliation(p, {
    task_id: 'carpet',
    now,
    key: KEY,
    snapshot: sim.observeFor('alpha'),
    evidence: { agentPositions: sim.agentPositions(), pendingOperationIds: [], now },
  })
  if (!fin.ok) {
    sim.setAgent('alpha', { x: 120, y: 64, z: 220 })
    fin = finishReconciliation(p, {
      task_id: 'carpet',
      now,
      key: KEY,
      snapshot: sim.observeFor('alpha'),
      evidence: { agentPositions: sim.agentPositions(), pendingOperationIds: [], now },
    })
  }
  p = fin.project
  p.materials.items['minecraft:red_carpet'].stock = 3
  const claimB = claimWork(p, {
    member_id: 'beta',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: sim.agentPos('beta'),
    snapshot: sim.observeFor('beta'),
  })
  assert.equal(claimB.ok, true)
  p = claimB.project
  const worldB = bindSimToMember(sim, 'beta')
  const applied = new Set()
  while (p.progress.done.length < 5) {
    const last = await step(p, worldB, { now, memberId: 'beta', globalInflight: p.inflight })
    if (last.operation_id) applied.add(last.operation_id)
    now += 1
    sim.advanceTime(now)
    if (last.paused === 'task_done') break
  }
  assert.equal(p.progress.done.length, 5)
  p.tasks[0].status = 'done'
  assert.equal(checkSchedulingInvariants(p, { taskId: 'carpet', baselineTotals: baseline }).ok, true)
  const bad = claimWork(p, {
    member_id: 'beta',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: sim.agentPos('beta'),
    snapshot: sim.observeFor('beta'),
  })
  assert.equal(bad.ok, false)
  p.materials.items['minecraft:red_carpet'].stock = 0
  const starved = createProject(redCarpetSite(), {
    id: 'starve',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 2 },
  })
  starved.tasks[0].checkpoint = false
  const unfinishedSnap = {
    complete: true,
    origin: { x: 100, y: 64, z: 201 },
    agent: { x: 100, y: 64, z: 201 },
    radius: 16,
    blocks: blocks.map((b) => ({ ...b })),
  }
  const fail = claimWork(starved, {
    member_id: 'gamma',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: { x: 100, y: 64, z: 201 },
    snapshot: unfinishedSnap,
  })
  assert.equal(fail.ok, false)
})

test('handover record shows zero shortage when all carpet cells match', async () => {
  resetSimOpIds()
  resetExecuteOpIds()
  let now = NOW
  const project = createProject(redCarpetSite(), {
    id: 'record',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 10 },
  })
  project.tasks[0].checkpoint = false
  const blocks = []
  for (let x = 0; x < 5; x++) {
    blocks.push({ x: 100 + x, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} })
    blocks.push({ x: 100 + x, y: 65, z: 200, block_id: 'minecraft:red_carpet', state: {} })
  }
  const snap = {
    complete: true,
    origin: { x: 100, y: 64, z: 201 },
    agent: { x: 100, y: 64, z: 201 },
    radius: 16,
    blocks,
  }
  project.materials.items['minecraft:red_carpet'].carried.alpha = 3
  project.materials.items['minecraft:red_carpet'].stock = 2
  for (let x = 0; x < 5; x++) project.progress.done.push(`${100 + x},65,200`)
  const record = handoverRecord(project, snap, { reason: 'demo_complete' })
  assert.equal(record.remaining_cells.length, 0)
  assert.equal(record.unavailable_materials.length, 0)
})
