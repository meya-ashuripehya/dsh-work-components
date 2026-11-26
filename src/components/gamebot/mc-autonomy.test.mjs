import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { controlTools, controlSystemPrompt, applyDecision, createMcControl } from './mc-control.mjs'
import { createMcControlHost } from './mc-host.mjs'
import { ensureMemberToken } from './process.mjs'
import { boundedCall, createWorldMemory, observationContext } from './mc-memory.mjs'
import { readRoomMemory } from '../../chatroom/read-context.mjs'
import { classifyChat, createMirror } from './mc-mirror.mjs'

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }

test('resource tools require the safe-harvest handshake and model context includes real inventory and drops', () => {
  assert.equal(controlTools({ extras: { advertised: ['minecraft.world.place_block', 'minecraft.inventory.drop'] } }).some(t => ['place_block','drop_item'].includes(t.name)), false)
  assert.equal(controlTools({ extras: { advertised: ['minecraft.world.place_block','minecraft.world.place_from_inventory','minecraft.inventory.drop','minecraft.inventory.drop_safe'] } }).filter(t => ['place_block','drop_item'].includes(t.name)).length, 2)
  assert.equal(controlTools({ extras: { advertised: ['minecraft.world.break_block'] } }).some(t => t.name === 'break_block'), false)
  assert.equal(controlTools({ extras: { advertised: ['minecraft.world.break_block', 'minecraft.world.harvest_with_tools'] } }).some(t => t.name === 'break_block'), true)
  const mc = { inventory: { slots: [{ slot: 29, item_id: 'minecraft:iron_pickaxe', count: 1 }], counts: { 'minecraft:iron_pickaxe': 1 } }, nearby_items: [{ item_id: 'minecraft:cobblestone', count: 1 }], recent_pickups: [{ id: 3, item_id: 'minecraft:dirt', count: 1 }] }
  const view = observationContext({ extras: { minecraft: mc } })
  assert.deepEqual(view.inventory, mc.inventory); assert.deepEqual(view.nearby_items, mc.nearby_items); assert.deepEqual(view.recent_pickups, mc.recent_pickups)
})

test('host signs only the requested harvesting cell without exposing the claim in model input or history', async t => {
  const f = fixture(t)
  f.set({ joined: true, advertised: ['minecraft.task.navigate_to', 'minecraft.world.break_block', 'minecraft.world.harvest_with_tools'], decision: { toolCalls: [{ name: 'break_block', arguments: { pos: { x: 1, y: 64, z: 2 }, face: 'north', expected_block: 'minecraft:stone' } }] } })
  await f.host.poll(); await flush()
  const sent = f.actions.find(a => a.action === 'break_block')
  assert.deepEqual(sent.params.claim.cells, [{ x: 1, y: 64, z: 2 }]); assert.deepEqual(sent.params.claim.act, ['break'])
  assert.equal(sent.params.claim.mid, 'gpt'); assert.equal(sent.params.claim.exp, 45)
  const { signClaim } = await import('./minecraft-work/sign.mjs')
  const key = Buffer.from(readFileSync(join(f.root, 'minecraft-work', 'claim.key'), 'utf8').trim(), 'base64')
  assert.equal(signClaim(sent.params.claim, key).sig, sent.params.claim.sig)
  assert.doesNotMatch(JSON.stringify(f.calls), /"sig"|claim_key/)
  assert.doesNotMatch(readFileSync(join(f.root, 'minecraft-autonomy.json'), 'utf8'), /"sig"|claim_key/)
})
test('idle task guidance does not interrupt an active task or a directed reply', () => {
  assert.match(controlSystemPrompt(null, '', null, {}), /不要只调用 say 后继续站着/)
  for (const state of ['accepted', 'running']) assert.doesNotMatch(controlSystemPrompt(null, '', null, { state }), /不要只调用 say 后继续站着/)
  assert.doesNotMatch(controlSystemPrompt(null, '', { text: 'hello', kind: 'bystander' }, {}), /不要只调用 say 后继续站着/)
})

test('speech-only execution and cooldown feed back without leaking message text, and reset in a new world', async (t) => {
  const f = fixture(t)
  f.set({ joined: true, decision: { toolCalls: [{ name: 'say', arguments: { text: 'PRIVATE-LIKE-TEXT' } }] } })
  await f.host.poll(); await flush()
  f.set({ clock: 15000, decision: { toolCalls: [{ name: 'say', arguments: { text: 'DIFFERENT-PRIVATE-LIKE-TEXT' } }] } }); await f.host.poll(); await flush()
  const second = JSON.parse(f.calls.findLast((c) => c.seat.name === 'gpt').prompt.messages[0].content)
  assert.equal(second.previous_execution.idle_without_task, true)
  assert.deepEqual(second.previous_execution.speech, [{ ok: true, reason: null }])
  f.set({ clock: 20000 }); await f.host.poll(); await flush()
  const third = JSON.parse(f.calls.findLast((c) => c.seat.name === 'gpt').prompt.messages[0].content)
  assert.deepEqual(third.previous_execution.speech, [{ ok: false, reason: 'spontaneous_speech_cooldown' }])
  assert.doesNotMatch(JSON.stringify(third.previous_execution), /PRIVATE-LIKE-TEXT/)
  f.set({ world: 'new-world', clock: 21000 }); await f.host.poll(); await flush()
  assert.equal(JSON.parse(f.calls.findLast((c) => c.seat.name === 'gpt').prompt.messages[0].content).previous_execution, null)
})
test('control context includes authoritative feet goals without treating them as proven paths', () => {
  const goals = [{ position: { x: 125.5, y: -60, z: 225.5 }, path_checked: false }]
  assert.deepEqual(observationContext({ extras: { minecraft: { standable_goals: goals } } }).standable_goals, goals)
})
test('raw buried blocks do not reach default model context or historical interests', () => {
  const obs = { extras: { minecraft: { nearby_blocks: [{ block_id: 'BURIED-DO-NOT-SEND' }], points_of_interest: [{ block_id: 'minecraft:crafting_table', pos: { x: 1, y: 64, z: 1 }, observed_at: 10 }] } } }
  const context = observationContext(obs)
  assert.doesNotMatch(JSON.stringify(context), /BURIED-DO-NOT-SEND/)
  const memory = createWorldMemory()
  assert.deepEqual(memory.perceive('a', 'g', 'overworld', context.points_of_interest), [])
  const historical = memory.perceive('a', 'g', 'overworld', [])
  assert.equal(historical[0].visibility, 'last_seen')
  assert.deepEqual(memory.perceive('b', 'g', 'overworld', []), [])
  assert.deepEqual(memory.perceive('a', 'g', 'nether', []), [])
})

test('stateful points survive model context and revisiting replaces stale state at the same position', () => {
  const memory=createWorldMemory(), pos={x:1,y:64,z:2}
  const candle={block_id:'minecraft:candle',pos,state:{lit:false,candles:1},observed_at:1}
  assert.deepEqual(observationContext({extras:{minecraft:{points_of_interest:[candle]}}}).points_of_interest[0].state,{lit:false,candles:1})
  memory.perceive('w','seat','d',[candle]);candle.state.lit=true
  assert.equal(memory.perceive('w','seat','d',[])[0].state.lit,false)
  assert.deepEqual(memory.perceive('w','seat','d',[{...candle,observed_at:2}]),[])
  assert.equal(memory.perceive('w','seat','d',[])[0].state.lit,true)
  const torch={block_id:'minecraft:torch',pos,state:{},observed_at:3}
  assert.deepEqual(memory.perceive('w','seat','d',[torch]),[])
  assert.equal(memory.perceive('w','seat','d',[])[0].block_id,'minecraft:torch')
})
test('formal DSH stream JSON arguments preserve movement and explicit speech; malformed arguments never execute', async () => {
  const { callSeat } = await import('../../chatroom/providers.mjs')
  const decision = await callSeat({ seat: { name: 'gpt', provider: 'p', model: 'm' }, prompt: { system: '', messages: [] },
    llm: { stream: () => (async function* () {
      yield { type: 'block-end', block: { type: 'tool-call', id: 'm', name: 'move_to', arguments: '{"x":3,"y":64,"z":5}' } }
      yield { type: 'block-end', block: { type: 'tool-call', id: 's', name: 'say', arguments: '{"text":"hello"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() } })
  const sent = [], ctx = { tools: controlTools({ extras: { advertised: ['minecraft.chat.say', 'minecraft.player.move_to'] } }), current: () => true, markSelf() {}, act: async (params, action) => { sent.push({ action, params }); return { ok: true } } }
  await applyDecision(decision, ctx)
  assert.deepEqual(sent[0], { action: 'move_to', params: { x: 3, y: 64, z: 5 } })
  assert.equal(sent[1].params.text, 'hello')
  const bad = await applyDecision({ toolCalls: [{ name: 'move_to', arguments: '{bad json' }, { name: 'say', arguments: '[]' }] }, ctx)
  assert.equal(sent.length, 2)
  assert.equal(bad.rejected.length, 2)
})

test('serialized private speech does not persist the model private goal', async (t) => {
  const f = fixture(t)
  f.set({ joined: true, decision: { text: 'PRIVATE-GOAL-DO-NOT-STORE', toolCalls: [{ name: 'say', arguments: '{"text":"private content","audience":"private","target":"Player"}' }] } })
  await f.host.poll(); await flush()
  assert.equal(f.mirrored.length, 0)
  assert.throws(() => readFileSync(join(f.root, 'minecraft-autonomy.json')), /ENOENT/)
})

test('only advertised tools; one world action plus speech; text never becomes speech', async () => {
  const tools = controlTools({ extras: { advertised: ['minecraft.chat.say', 'minecraft.player.move_to'] } })
  assert.deepEqual(tools.map((t) => t.name), ['say', 'move_to', 'wait'])
  const sent = []
  const ctx = { tools, current: () => true, markSelf() {}, act: async (params, action) => { sent.push(action); return { ok: true } } }
  const result = await applyDecision({ text: 'my goal', toolCalls: [{ name: 'move_to', arguments: { x: 1, y: 2, z: 3 } }, { name: 'move_to' }, { name: 'say', arguments: { text: 'hi' } }] }, ctx)
  assert.deepEqual(sent, ['move_to', 'say'])
  assert.equal(result.nextDelayMs, 2000)
  await applyDecision({ text: 'do not broadcast me' }, ctx)
  assert.equal(sent.length, 2)
  assert.equal(classifyChat({ type: 'chat_out', text: 'private delivery', say_id: 'out' }), null)
})

test('concurrent receipt and broadcast share one mirror write', async () => {
  let writes = 0, release
  const mirror = createMirror({ append: async () => { writes++; await new Promise((r) => { release = r }) } })
  const a = mirror.fromAction('gpt', { ok: true, sent: 'hi', extras: { say_id: 'one' } }, 'gpt', 'world')
  const b = mirror.take({ id: 'world:gpt:one', text: 'hi', kind: 'say', audience: 'public' })
  assert.equal(writes, 1); release(); await Promise.all([a, b])
  assert.equal(writes, 1)
})

test('busy seats serialize, wait can be interrupted, model timeouts release callers', async () => {
  let now = 0, release, calls = 0
  const control = createMcControl({ now: () => now, runTurn: async () => { calls++; await new Promise((r) => { release = r }); return { nextDelayMs: 30000 } } })
  control.connect('gpt'); control.tick(); await flush()
  now = 1000; control.note('gpt', { id: 'player' }, { delayMs: 0 }); control.tick()
  assert.equal(calls, 1)
  release(); await flush()
  assert.equal(control.view('gpt').deadline, 3000)
  now = 3000; control.tick(); await flush(); assert.equal(calls, 2)
  control.takeover('gpt'); release(); await flush()
  assert.equal(control.view('gpt').owner, 'manual'); assert.equal(control.view('gpt').deadline, null)
  await assert.rejects(boundedCall(() => new Promise(() => {}), null, 5), /timeout/)
  const abort = new AbortController(); const p = boundedCall(() => new Promise(() => {}), abort.signal); abort.abort()
  await assert.rejects(p, /cancelled/)
})

test('room memory respects compression and hidden messages', async () => {
  const room = await readRoomMemory({ getRoom: async () => ({ contextSummary: { text: 'prior', untilSeq: 2 } }), readMessages: async () => [
    { seq: 1, kind: 'user', text: 'folded' }, { seq: 3, kind: 'user', text: 'secret', contextHidden: true }, { seq: 4, kind: 'user', text: 'blue lighthouse' },
  ] }, 'r')
  assert.equal(room.summary, 'prior'); assert.deepEqual(room.messages.map((m) => m.text), ['blue lighthouse'])
})

test('autonomous duplicate speech is suppressed but a fresh player message may receive the same answer', async (t) => {
  const f = fixture(t)
  f.set({ joined: true, decision: { toolCalls: [{ name: 'say', arguments: { text: '你好' } }] } })
  await f.host.poll(); await flush()
  f.set({ clock: 30000 }); await f.host.poll(); await flush()
  assert.equal(f.actions.filter((a) => a.action === 'say').length, 2) // one delivery per seat
  assert.equal(f.host.view('gpt').lastResult.speechSuppressed, true)
  const memory = JSON.parse(readFileSync(join(f.root, 'minecraft-autonomy.json'), 'utf8'))
  assert.equal(memory.worlds['world-a'].gpt.history.at(-1).spoke, false)
  f.set({ clock: 31000, events: [{ type: 'chat', data: { source: 'player', message_id: 'new-question', player: 'Player', message: 'gpt，请再说一遍' } }] })
  await f.host.poll(); await flush()
  assert.equal(f.actions.filter((a) => a.action === 'say').length, 3)
  f.set({ clock: 61000, events: [] }); await f.host.poll(); await flush()
  assert.equal(f.actions.filter((a) => a.action === 'say').length, 4) // gpt still suppressed; grok's old speech expired
})

test('acceptance cadence wakes an active task after 15 seconds without replacing it', async (t) => {
  const f = fixture(t, undefined, { taskDecisionIntervalMs: 15000 })
  f.set({ joined: true }); await f.host.poll(); await flush()
  assert.equal(f.calls.length, 2)
  f.set({ decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] }, clock: 14999 })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 2)
  f.set({ clock: 15000 }); await f.host.poll(); await flush()
  assert.equal(f.calls.length, 4); assert.equal(f.actions.length, 2)
  assert.match(f.calls.at(-1).prompt.system, /普通自主决策约每15秒一次/)
})

test('successful drops are not repeated by periodic retries; deliberate batches and new player requests remain possible', async (t) => {
  const f=fixture(t)
  const tools=['minecraft.task.navigate_to','minecraft.inventory.drop','minecraft.inventory.drop_safe']
  const decision={toolCalls:[{name:'drop_item',arguments:{item_id:'minecraft:dirt',count:3}}]}
  f.set({joined:true,advertised:tools,decision});await f.host.poll();await flush()
  assert.equal(f.actions.length,2)
  f.set({clock:15000});await f.host.poll();await flush();assert.equal(f.actions.length,2)
  assert.equal(f.host.view('gpt').lastResult.alreadyCompleted,true)
  f.set({clock:30000,decision:{toolCalls:[{name:'drop_item',arguments:{item_id:'minecraft:dirt',count:3,additional_drop:true}}]}})
  await f.host.poll();await flush();assert.equal(f.actions.length,4)
  f.set({clock:31000,decision,events:[{type:'chat',data:{source:'player',message_id:'another-drop',player:'Player',message:'gpt，再给我3个泥土'}}]})
  await f.host.poll();await flush();assert.equal(f.actions.length,5)
})

function fixture(t, ctx, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-autonomy-')); ensureMemberToken(root)
  let clock = 0, world = 'world-a', joined = false, seq = 1, position = { x: 0, y: 64, z: 0 }, events = [], decision = { toolCalls: [{ name: 'navigate_to', arguments: { x: 3, y: 64, z: 0 } }] }
  const calls = [], actions = [], mirrored = []
  let actionOK = true, eventsBySeat = null, advertised = ['minecraft.chat.say', 'minecraft.task.navigate_to', 'minecraft.task.stop_task', 'minecraft.world.inspect_blocks']
  let advance = true, snapshotAge = 0
  const tasks = {}
  const inventory = { gpt: { 'minecraft:dirt': 30 }, grok: { 'minecraft:dirt': 30 } }
  const cfg = { 'gamebot-minecraftEnabled': true, mcRoomSeatIds: ['gpt', 'grok'], chatroomSeats: ['gpt', 'grok'].map((id) => ({ id, name: id, enabled: true, provider: 'fake', model: 'fake' })) }
  const observation = (sid) => { if (advance) seq++; return { connected: true, position, recent_events: eventsBySeat ? (eventsBySeat[sid] || []) : events, extras: { world_id: world, joined, snapshot_seq: seq, game_time: seq, snapshot_age_ms: snapshotAge, advertised, minecraft: { player: { position, dimension: 'minecraft:overworld' }, inventory: { counts: { ...inventory[sid] } }, task: tasks[sid] || {} } } } }
  const host = createMcControlHost({ ...options, ctx, getConfig: () => cfg, dataRoot: () => root, now: () => clock, roomId: () => 'r',
    store: { append: async (_, row) => mirrored.push(row), getRoom: async () => ({}), readMessages: async () => [{ kind: 'user', text: 'lighthouse blue' }] },
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null
      if (url.endsWith('/actions')) {
        actions.push(body)
        const sid = url.match(/members\/([^/]+)/)?.[1]
        if (body.action === 'drop_item') {
          inventory[sid][body.params.item_id] -= body.params.count
          return { ok: true, text: async () => JSON.stringify({ ok: true, extras: { effect: 'confirmed', evidence: { spawned: true, item_id: body.params.item_id, count: body.params.count } } }) }
        }
        if (body.action === 'navigate_to' && actionOK) tasks[sid] = { task_id: `task-${sid}`, state: 'accepted', action: 'navigate_to' }
        if (body.action === 'stop_task' && actionOK) tasks[sid] = { task_id: `task-${sid}`, state: 'cancelled', event_id: `task-${sid}:cancelled` }
        return { ok: true, text: async () => JSON.stringify({ ok: actionOK, error: actionOK ? null : 'unreachable', sent: body.params.text, extras: { evidence: { task: tasks[sid], stopped: body.action === 'stop_task', visible_blocks: body.action === 'inspect_blocks' ? [{ block_id: 'minecraft:crafting_table' }] : undefined }, say_id: body.params.say_id, audience: body.params.audience || 'public' } }) }
      }
      return { ok: true, text: async () => JSON.stringify(url.endsWith('/reconcile') ? { members: [] } : observation(url.match(/members\/([^/]+)/)?.[1])) }
    }, callModel: async (request) => { calls.push(request); return typeof decision === 'function' ? decision(request) : decision } })
  t.after(async () => { await host.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { host, root, calls, actions, mirrored, cfg, tasks, set: (v) => { if ('advance' in v) advance = v.advance; if ('snapshotAge' in v) snapshotAge = v.snapshotAge; if ('advertised' in v) advertised = v.advertised; if ('eventsBySeat' in v) eventsBySeat = v.eventsBySeat; if ('actionOK' in v) actionOK = v.actionOK; if ('world' in v) world = v.world; if ('joined' in v) joined = v.joined; if ('clock' in v) clock = v.clock; if ('events' in v) events = v.events; if ('decision' in v) decision = v.decision } }
}

test('missing game capabilities do not spend model calls; a later ready handshake resumes control', async (t) => {
  const f = fixture(t)
  f.set({ joined: true, advertised: [] })
  await f.host.poll(); await flush()
  assert.equal(f.calls.length, 0)
  assert.match(f.host.view('gpt').detail, /请更新 Minaret/)
  f.set({ advertised: ['minecraft.chat.say', 'minecraft.task.navigate_to'] })
  await f.host.poll(); await flush()
  assert.equal(f.calls.length, 2)
  assert.equal(f.actions.length, 2)
  f.set({ clock: 2000, advertised: [] })
  await f.host.poll(); await flush()
  assert.equal(f.calls.length, 2)
  assert.equal(f.host.view('gpt').connected, false)
})

test('game decisions include the seat persona and existing DSH preset persona', async (t) => {
  const f = fixture(t, { agentPresets: { list: async () => [{ id: 'companion' }], readDocument: async () => ({ content: '- name: dsh-persona\n  config:\n    prefix: PRESET-PERSONA' }) } })
  f.cfg.chatroomSeats[0].preset = 'companion'
  f.cfg.chatroomSeats[0].persona = 'SEAT-PERSONA'
  f.set({ joined: true }); await f.host.poll(); await flush()
  const prompt = f.calls.find((r) => r.seat.name === 'gpt').prompt.system
  assert.match(prompt, /PRESET-PERSONA/); assert.match(prompt, /SEAT-PERSONA/)
})

test('roster alone is idle; joined members move independently and resume in the same world', async (t) => {
  const f = fixture(t)
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 0)
  f.set({ joined: true }); await f.host.poll(); await flush()
  assert.equal(f.calls.length, 2); assert.equal(f.actions.length, 2)
  assert.equal(f.host.view('gpt').lastResult.accepted, true)
  assert.equal(f.host.view('gpt').lastResult.verified, null)
  assert.match(f.calls[0].prompt.messages[0].content, /lighthouse blue/)
  f.set({ clock: 2000 }); await f.host.poll(); await flush(); assert.equal(f.calls.length, 2)
  f.set({ clock: 60000 }); await f.host.poll(); await flush(); assert.equal(f.calls.length, 4)
  f.set({ joined: false }); await f.host.poll(); await flush(); assert.equal(f.host.view('gpt').joined, false)
  f.set({ joined: true, world: 'world-b' }); await f.host.poll(); await flush()
  assert.deepEqual(JSON.parse(f.calls[4].prompt.messages[0].content).memory.history, [])
  f.set({ world: 'world-a' }); await f.host.poll(); await flush()
  assert.ok(JSON.parse(f.calls[6].prompt.messages[0].content).memory.history.length > 0)
})

test('segments and ordinary chatter do not wake the model; terminal tasks wake it once', async (t) => {
  const f = fixture(t); f.cfg.mcRoomSeatIds = ['gpt']; f.set({ joined: true })
  await f.host.poll(); await flush()
  assert.equal(f.host.view('gpt').deadline, 60000)
  f.tasks.gpt.state = 'running'; f.tasks.gpt.segments = 3
  f.set({ clock: 10000, events: [{ data: { data: { source: 'agent', agent_id: 'grok', player: 'grok', message: 'nice day', say_id: 'ambient', audience: 'public' } } }] })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 1)
  f.tasks.gpt = { task_id: 'task-gpt', state: 'completed', event_id: 'task-gpt:completed' }
  f.set({ clock: 12000, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 2)
  assert.equal(JSON.parse(f.calls[1].prompt.messages[0].content).task_events.length, 1)
  f.set({ clock: 15000 }); await f.host.poll(); await flush(); assert.equal(f.calls.length, 2)
})

test('paused worlds cancel in-flight decisions and recover without replay after two advancing samples', async (t) => {
  const f = fixture(t); f.cfg.mcRoomSeatIds = ['gpt']; let release
  f.set({ joined: true, decision: () => new Promise((r) => { release = r }) })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 1)
  f.set({ clock: 4001, advance: false, snapshotAge: 4001 }); await f.host.poll(); await flush()
  assert.equal(f.host.view('gpt').state, 'paused'); assert.equal(f.host.view('gpt').busy, false)
  release({ toolCalls: [{ name: 'navigate_to', arguments: { x: 99, y: 64, z: 0 } }] }); await flush()
  assert.equal(f.actions.length, 0)
  f.set({ clock: 5000, advance: true, snapshotAge: 0, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 1)
  f.set({ clock: 6000 }); await f.host.poll(); await flush(); assert.equal(f.calls.length, 2)
  assert.equal(f.actions.length, 0)
})

test('a directed social reply leaves the active navigation task in place', async (t) => {
  const f = fixture(t); f.cfg.mcRoomSeatIds = ['gpt']; f.set({ joined: true })
  await f.host.poll(); await flush()
  f.set({ clock: 3000, events: [{ data: { data: { source: 'player', player: 'Alex', message: 'gpt hello', message_id: 'direct', audience: 'public' } } }], decision: { toolCalls: [{ name: 'say', arguments: { text: 'hello' } }] } })
  await f.host.poll(); await flush()
  assert.deepEqual(f.actions.map((a) => a.action), ['navigate_to', 'say'])
  assert.equal(f.host.view('gpt').task.task_id, 'task-gpt')
  assert.equal(f.host.view('gpt').deadline, 63000)
})

test('inspect is bounded observation, not task completion or an unbounded tool loop', async (t) => {
  const f = fixture(t); f.cfg.mcRoomSeatIds = ['gpt']; f.set({ joined: true, decision: { toolCalls: [{ name: 'inspect_blocks', arguments: { category: 'functional' } }] } })
  await f.host.poll(); await flush(); assert.equal(f.calls.length, 1); assert.equal(f.actions.length, 1)
  assert.equal(f.host.view('gpt').lastResult.verified, null)
  f.set({ clock: 15000, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 10 } }] } })
  await f.host.poll(); await flush()
  assert.equal(JSON.parse(f.calls[1].prompt.messages[0].content).inspection[0].block_id, 'minecraft:crafting_table')
})

test('text-only turns remain idle and keep polling; explicit wait has a distinct result', async (t) => {
  const f = fixture(t)
  f.cfg.mcRoomSeatIds = ['gpt']
  f.set({ joined: true, decision: { text: 'I run to the player' } })
  await f.host.poll(); await flush()
  assert.equal(f.host.view('gpt').lastAction, 'idle')
  assert.equal(f.host.view('gpt').deadline, 15000)
  assert.match(f.host.view('gpt').lastResult.detail, /未提交游戏操作/)
  assert.equal(f.actions.length, 0); assert.equal(f.mirrored.length, 0)
  f.set({ clock: 15000, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush()
  assert.equal(f.host.view('gpt').lastAction, 'wait')
  assert.equal(f.host.view('gpt').deadline, 45000)
  assert.equal(f.calls.length, 2)
})

test('failed targets back off, cool down after three tries, and never count as verified', async (t) => {
  const f = fixture(t)
  f.cfg.mcRoomSeatIds = ['gpt']
  f.set({ joined: true, actionOK: false })
  for (const clock of [0, 5000, 20000]) {
    f.set({ clock }); await f.host.poll(); await flush()
    assert.equal(f.host.view('gpt').lastResult.verified, false)
  }
  assert.equal(f.actions.length, 3)
  assert.equal(f.host.view('gpt').deadline, 50000)
  f.set({ clock: 50000 }); await f.host.poll(); await flush()
  assert.equal(f.actions.length, 3)
  assert.equal(JSON.parse(f.calls.at(-1).prompt.messages[0].content).cooldowns.length, 1)
  f.set({ clock: 81000, actionOK: true }); await f.host.poll(); await flush()
  assert.equal(f.actions.length, 4)
  assert.equal(f.host.view('gpt').lastResult.ok, true)
  assert.equal(f.host.view('gpt').deadline, 141000)
})

test('a failed transcript write cannot retry a private reply already delivered to the player', async (t) => {
  const f = fixture(t, { agents: { create: async () => ({ session: { append() { throw new Error('transcript unavailable') } } }) } })
  f.set({ joined: true, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush()
  const secret = { data: { data: { source: 'player', player: 'Alex', message: 'PRIVATE-ONCE', message_id: 'private-once', audience: 'private' } } }
  f.set({ clock: 10000, eventsBySeat: { gpt: [secret] }, decision: (request) => request.prompt.system.includes('PRIVATE-ONCE')
    ? { toolCalls: [{ name: 'say', arguments: '{"text":"private answer"}' }] }
    : { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush()
  f.set({ clock: 20000 }); await f.host.poll(); await flush()
  assert.equal(f.actions.filter((a) => a.action === 'say').length, 1)
  assert.equal(f.host.view('gpt').lastResult.ok, true)
  assert.equal(f.host.seatQueueView('gpt').active, null)
})

test('private messages cannot reach mirror, public memory, or other seats; public echoes dedupe', async (t) => {
  const f = fixture(t)
  f.set({ joined: true, decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush()
  const secret = { data: { data: { source: 'player', player: 'Alex', message: 'PRIVATE-SENTINEL', message_id: 'p', audience: 'private' } } }
  f.set({ clock: 10000, eventsBySeat: { gpt: [secret] }, decision: (request) => request.prompt.system.includes('PRIVATE-SENTINEL')
    ? { text: 'PRIVATE-SENTINEL', toolCalls: [{ name: 'say', arguments: { text: 'PRIVATE-SENTINEL', audience: 'public' } }] }
    : { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush()
  assert.equal(f.actions.at(-1).params.audience, 'private'); assert.equal(f.actions.at(-1).params.target, 'Alex')
  assert.equal(f.mirrored.length, 0)
  assert.doesNotMatch(readFileSync(join(f.root, 'minecraft-autonomy.json'), 'utf8'), /PRIVATE-SENTINEL/)
  assert.doesNotMatch(readFileSync(join(f.root, 'minecraft-control-trace.jsonl'), 'utf8'), /PRIVATE-SENTINEL/)
  assert.doesNotMatch(JSON.stringify(f.calls.filter((r) => r.seat.name === 'grok')), /PRIVATE-SENTINEL/)
  const publicEvent = { data: { data: { source: 'agent', agent_id: 'grok', player: 'grok', message: 'gpt hello', say_id: 'hello', audience: 'public' } } }
  f.set({ clock: 20000, eventsBySeat: null, events: [publicEvent], decision: { toolCalls: [{ name: 'wait', arguments: { seconds: 30 } }] } })
  await f.host.poll(); await flush(); await f.host.poll(); await flush()
  assert.equal(f.mirrored.length, 1)
  assert.match(f.calls.at(-1).prompt.system, /gpt hello/)
})
