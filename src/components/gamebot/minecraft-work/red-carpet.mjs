/**
 * Offline demonstration: red carpet handover (Worker A partial → release → B completes).
 * Uses the same schedule/loop/store paths as GameBot work runtime.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RED_CARPET_WORLD_ID, redCarpetSite } from './model.mjs'
import { createProject } from './project.mjs'
import { createStore, ensureClaimKey } from './store.mjs'
import { createSimWorld, bindSimToMember, resetSimOpIds } from './simulation.mjs'
import { claimWork } from './schedule.mjs'
import { runUntilPause, step } from './loop.mjs'
import { voluntaryRelease, resetExecuteOpIds } from './execute.mjs'
import { verifySite, handoverRecord } from './reconcile.mjs'
import { finishReconciliation } from './handoff.mjs'
import { warehouseSnapshot } from './materials.mjs'
import { checkSchedulingInvariants } from './invariants.mjs'

const NOW0 = 1_800_000_000
const KEY = Buffer.from('red-carpet-demo-key')

function initialBlocks() {
  const blocks = []
  for (let x = 0; x < 5; x++) {
    blocks.push({ x: 100 + x, y: 64, z: 200, block_id: 'minecraft:stone_bricks', state: {} })
  }
  return blocks
}

export function buildRedCarpetFixture({ now = NOW0 } = {}) {
  resetSimOpIds()
  resetExecuteOpIds()
  const project = createProject(redCarpetSite(), {
    id: 'red-carpet',
    now,
    world_id: RED_CARPET_WORLD_ID,
    material_stock: { 'minecraft:red_carpet': 10 },
  })
  project.tasks[0].checkpoint = false
  const sim = createSimWorld({
    clock: () => now,
    blocks: initialBlocks(),
    agents: { alpha: { x: 100, y: 64, z: 201 }, beta: { x: 106, y: 64, z: 201 } },
  })
  const baselineTotals = warehouseSnapshot(project)
  return { project, sim, now, baselineTotals }
}

export async function runRedCarpetHandover({ trace = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-red-carpet-'))
  const store = createStore(dir)
  ensureClaimKey(dir)
  let { project, sim, now, baselineTotals } = buildRedCarpetFixture()
  store.write(project)

  const claimA = claimWork(project, {
    member_id: 'alpha',
    task_id: 'carpet',
    now,
    key: KEY,
    agent_pos: sim.agentPos('alpha'),
    snapshot: sim.observeFor('alpha'),
  })
  if (!claimA.ok) throw new Error(claimA.error)
  project = claimA.project
  store.write(project)
  trace('A claimed carpet task')

  const worldA = bindSimToMember(sim, 'alpha')
  for (let i = 0; i < 2; i++) {
    await step(project, worldA, { now, memberId: 'alpha', globalInflight: project.inflight })
    now += 1
    sim.advanceTime(now)
    const inv = checkSchedulingInvariants(project, { taskId: 'carpet', baselineTotals })
    if (!inv.ok) throw new Error(inv.error)
  }
  trace(`A placed cells (progress): ${project.progress.done.join(',')}`)

  voluntaryRelease(project, 'carpet', 'alpha', now, KEY, worldA)
  now += 1
  const snap = sim.observeFor('alpha')
  snap.complete = true
  let fin = finishReconciliation(project, {
    task_id: 'carpet',
    now,
    key: KEY,
    snapshot: snap,
    evidence: {
      agentPositions: sim.agentPositions(),
      pendingOperationIds: sim.pendingOperationIds({ taskId: 'carpet' }),
      now,
    },
  })
  if (!fin.ok) {
    sim.setAgent('alpha', { x: 120, y: 64, z: 220 })
    fin = finishReconciliation(project, {
      task_id: 'carpet',
      now,
      key: KEY,
      snapshot: sim.observeFor('alpha'),
      evidence: {
        agentPositions: sim.agentPositions(),
        pendingOperationIds: sim.pendingOperationIds({ taskId: 'carpet' }),
        now,
      },
    })
  }
  if (!fin.ok) throw new Error(fin.error)
  project = fin.project
  const re = claimWork(project, {
    member_id: 'beta',
    task_id: 'carpet',
    now,
    key: KEY,
    ttl_seconds: 600,
    agent_pos: sim.agentPos('beta'),
    snapshot: sim.observeFor('beta'),
  })
  if (!re.ok) throw new Error(re.error)
  project = re.project
  trace(`Handover: ${JSON.stringify(fin.handover)}`)

  const worldB = bindSimToMember(sim, 'beta')
  while (project.tasks[0].status === 'running') {
    const last = await runUntilPause(project, worldB, { now, memberId: 'beta', globalInflight: project.inflight })
    if (last.paused === 'task_done') break
    if (last.paused && last.paused !== 'idle') break
    now += 1
    sim.advanceTime(now)
  }

  const finalSnap = sim.observeFor('beta')
  finalSnap.complete = true
  const verified = verifySite(project, finalSnap)
  const record = handoverRecord(project, finalSnap, { reason: 'demo_complete' })
  trace(`Verified: ${verified.ok}, record: ${JSON.stringify(record)}`)

  rmSync(dir, { recursive: true, force: true })
  return { verified, record, project, blocks: [...sim.blockMap.entries()] }
}
