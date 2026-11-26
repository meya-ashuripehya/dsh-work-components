import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyWorldAction } from './mc-action-verification.mjs'

const obs = (sequence, z = 0, world = 'world', dimension = 'overworld') => ({ position: { x: 0, y: -60, z }, extras: { snapshot_seq: sequence, world_id: world, minecraft: { player: { dimension } } } })
const base = { action: 'move_to', params: { x: 0, y: -60, z: 4, arrival_tolerance: 1.5 }, before: obs(10), receipt: { ok: true, observation: obs(11) }, current: () => true, sleep: async () => {}, attempts: 4 }

test('drop confirmation needs both a spawned entity receipt and exact inventory decrease', async () => {
  for (const [remaining, spawned, valid] of [[2,true,true],[5,true,false],[2,false,false],[1,true,false]]) {
    const before=obs(10), after=obs(12); before.extras.minecraft.inventory={counts:{'minecraft:dirt':5}};after.extras.minecraft.inventory={counts:{'minecraft:dirt':remaining}}
    const result=await verifyWorldAction({...base, action:'drop_item',params:{item_id:'minecraft:dirt',count:3},before,receipt:{ok:true,extras:{evidence:{spawned,item_id:'minecraft:dirt',count:3}}},observe:async()=>after})
    assert.equal(result.verified,valid)
  }
})

test('placement needs confirmed material consumption or an explicitly already satisfied target', async () => {
  for (const [effect,evidence,valid] of [['confirmed',{block_id:'minecraft:dirt',material_before:4,material_after:3},true],['unverified',{block_id:'minecraft:dirt',material_before:4,material_after:3},false],['confirmed',{block_id:'minecraft:dirt',material_before:4,material_after:4},false],['observed',{block_id:'minecraft:dirt',already_present:true},true]]) {
    const result=await verifyWorldAction({...base,action:'place_block',params:{block_id:'minecraft:dirt'},receipt:{ok:true,extras:{effect,evidence}},observe:async()=>obs(12)})
    assert.equal(result.verified,valid)
  }
})

test('mining needs confirmed destruction and never treats it as acquired inventory', async () => {
  for (const evidence of [{}, { destroyed: false, block_id: 'minecraft:stone' }, { destroyed: true, block_id: 'minecraft:dirt' }, { destroyed: true, block_id: 'minecraft:stone' }]) {
    const result = await verifyWorldAction({ ...base, action: 'break_block', params: { expected_block: 'minecraft:stone' }, receipt: { ok: true, extras: { evidence } }, observe: async () => obs(12) })
    assert.equal(result.verified, evidence.destroyed === true && evidence.block_id === 'minecraft:stone')
    if (result.verified) assert.equal(result.reason, 'destroyed_not_acquired')
  }
})

test('waits past the old two-block cutoff until the actual arrival radius is observed', async () => {
  const snapshots = [obs(11, 2.8), obs(12, 2.2), obs(13, 2.4), obs(14, 2.6)]
  let calls = 0
  const result = await verifyWorldAction({ ...base, observe: async () => snapshots[calls++] })
  assert.equal(result.verified, true)
  assert.equal(calls, 4)
})

test('stationary snapshots and receipt snapshots cannot certify new movement', async () => {
  for (const [snapshot, reason] of [[obs(11, 4), 'no_fresh_snapshot'], [obs(12, 0), 'outside_arrival_tolerance']]) {
    const result = await verifyWorldAction({ ...base, observe: async () => snapshot })
    assert.equal(result.verified, false); assert.equal(result.reason, reason)
  }
})

test('a world change, dimension change, failed receipt, or cancellation cannot certify arrival', async () => {
  for (const options of [
    { observe: async () => obs(12, 4, 'another') },
    { observe: async () => obs(12, 4, 'world', 'nether') },
    { receipt: { ok: false }, observe: async () => obs(12, 4) },
    { observe: async () => obs(12, 4), current: () => false },
  ]) assert.equal((await verifyWorldAction({ ...base, ...options })).verified, false)
})

test('floating point boundary noise is tolerated, one extra tenth of a block is not', async () => {
  assert.equal((await verifyWorldAction({ ...base, observe: async () => obs(12, 2.499999999) })).verified, true)
  assert.equal((await verifyWorldAction({ ...base, observe: async () => obs(12, 2.4) })).verified, false)
})
