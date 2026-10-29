import test from 'node:test'
import assert from 'node:assert/strict'
import { assessProbe } from './probe.mjs'
import { snapshotBlock } from './blocks.mjs'
import { observationToSchedulerSnapshot } from './member-bridge-world.mjs'
import { dispatchPlace } from './execute.mjs'

const CELL = { pos: { x: 1, y: 2, z: 3 }, loaded: true, block_id: 'minecraft:air', state: {} }

function probe(overrides = {}) {
  return {
    ok: true,
    dimension: 'minecraft:overworld',
    game_time: 20,
    probe_seq: 2,
    cells: [CELL],
    ...overrides,
  }
}

test('probe after the action is fresh; a later request with an old reading is not', () => {
  const fresh = assessProbe(probe(), { beforeSeq: 1, afterGameTime: 20, dimension: 'minecraft:overworld' })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.cells[0].block_id, 'minecraft:air')
  assert.equal(assessProbe(probe({ probe_seq: 1 }), { beforeSeq: 1, afterGameTime: 20, dimension: 'minecraft:overworld' }).reason, 'stale_probe')
  assert.equal(assessProbe(probe({ game_time: 19, probe_seq: 3 }), { beforeSeq: 1, afterGameTime: 20, dimension: 'minecraft:overworld' }).reason, 'probe_not_after_action')
  assert.equal(assessProbe(probe({ dimension: 'minecraft:the_nether' }), { beforeSeq: 1, afterGameTime: 20, dimension: 'minecraft:overworld' }).reason, 'dimension_mismatch')
  assert.equal(assessProbe(probe({ cells: [{ ...CELL, loaded: false, block_id: null }] }), { beforeSeq: 1, afterGameTime: 20, dimension: 'minecraft:overworld' }).reason, 'cell_unknown')
  assert.equal(assessProbe(probe(), { beforeSeq: 1, afterGameTime: undefined, dimension: 'minecraft:overworld' }).reason, 'probe_not_after_action')
})

test('nearby snapshot with a position is not a cell reading, and omitted air stays unknown', () => {
  const snap = observationToSchedulerSnapshot({
    position: { x: 10.2, y: 64, z: 10 },
    extras: {
      minecraft: {
        nearby_blocks_truncated: false,
        player: { dimension: 'minecraft:overworld' },
        nearby_blocks: [{ block_id: 'minecraft:stone', pos: { x: 10, y: 63, z: 10 }, state: {} }],
      },
    },
  })
  assert.equal(snap.complete, false)
  assert.equal(snap.omits_air, true)
  assert.equal(snap.dimension, 'minecraft:overworld')
  assert.equal(snapshotBlock(snap, { x: 10, y: 64, z: 10 }).unknown, true)
  const truncated = observationToSchedulerSnapshot({
    position: { x: 0, y: 64, z: 0 },
    extras: { minecraft: { nearby_blocks: [], nearby_blocks_truncated: true } },
  })
  assert.equal(truncated.nearby_truncated, true)
  assert.equal(snapshotBlock(truncated, { x: 0, y: 64, z: 0 }).reason, 'snapshot_not_authoritative')
})

test('pending placement is not verified by a probe that merely exists', async () => {
  let probed = false
  const project = {
    anchor: { dimension: 'minecraft:overworld' },
    blueprint_version: 1,
    claims: [],
    tasks: [],
    inflight: [],
    unknown: [],
    progress: { done: [] },
    revocations: {},
    cells: [{ x: 1, y: 2, z: 3, block_id: 'minecraft:stone', state: {}, kind: 'specified' }],
  }
  const claim = {
    status: 'active',
    exp: 100,
    mid: 'a',
    tid: 't',
    gen: 1,
    act: ['place'],
    cells: [{ x: 1, y: 2, z: 3 }],
  }
  const world = {
    probeBlocks() {
      probed = true
      return probe()
    },
    currentProbeSeq() {
      return 0
    },
    act() {
      return { ok: true, effect: 'pending', operation_id: 'place-1', game_time: 20 }
    },
  }
  const result = await dispatchPlace(project, world, claim, project.cells[0], { now: 1 })
  assert.equal(result.pending, true)
  assert.equal(probed, false)
  assert.equal(project.progress.done.length, 0)
})
