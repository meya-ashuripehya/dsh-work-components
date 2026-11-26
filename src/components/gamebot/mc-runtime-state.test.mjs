import test from 'node:test'
import assert from 'node:assert/strict'
import { updateFreshness, taskEvent } from './mc-runtime-state.mjs'
const observation = (seq, gameTime, age = 0) => ({ extras: { snapshot_seq: seq, game_time: gameTime, snapshot_age_ms: age } })
test('cached HTTP reads stall, two progressing game snapshots are required to recover', () => {
  const state = {}
  assert.equal(updateFreshness(state, observation(1, 1), 0), true)
  assert.equal(updateFreshness(state, observation(1, 1), 3001), false)
  assert.equal(updateFreshness(state, observation(2, 2), 3100), false)
  assert.equal(updateFreshness(state, observation(3, 3), 3200), true)
  assert.equal(updateFreshness(state, observation(4, 3), 6500), false)
})
test('old or missing game evidence is never used for fresh autonomous decisions', () => {
  for (const obs of [observation(0, 0), observation(1, 1, 3001), { extras: {} }]) assert.equal(updateFreshness({}, obs, 0), false)
})
test('a reconnect with a reset sequence recovers using its own connection generation', () => {
  const state = {}
  const frame = (seq, gen) => ({ extras: { ...observation(seq, seq).extras, connection_generation: gen } })
  assert.equal(updateFreshness(state, frame(100, 1), 0), true)
  assert.equal(updateFreshness(state, frame(1, 2), 1000), false)
  assert.equal(updateFreshness(state, frame(2, 2), 1200), false)
  assert.equal(updateFreshness(state, frame(3, 2), 1400), true)
})
test('terminal events dedupe by world and dimension, never by task prose', () => {
  const state = {}, terminal = { event_id: 'one:completed', state: 'completed', task_id: 'one' }
  assert.ok(taskEvent(state, terminal, 'a', 'overworld'))
  assert.equal(taskEvent(state, terminal, 'a', 'overworld'), null)
  assert.ok(taskEvent(state, terminal, 'b', 'overworld'))
  assert.ok(taskEvent(state, terminal, 'b', 'nether'))
})
