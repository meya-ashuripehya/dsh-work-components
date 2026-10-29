import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDecision, controlSystemPrompt, createMcControl, IDLE_MS } from './mc-control.mjs'
import { classifyChat, createMirror, stripRolePrefix } from './mc-mirror.mjs'
import { bridgePort, shouldReconcile } from './mc-reconnect.mjs'
import { ensureControlSession, mountControlGuards, writeControlTurn } from './mc-session.mjs'
import { materializeProfile } from '../../profiles/store.mjs'
import { modelForSeat, profileChoices } from './mc-profile.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('idle wake fires once, ignores its own speech, and waits for a new external event', async () => {
  let clock = 0
  const turns = []
  const control = createMcControl({
    now: () => clock,
    runTurn: async (ctx) => {
      turns.push(ctx.generation)
      ctx.markSelf('say-self')
      return { ok: true }
    },
  })
  control.connect('claude')
  control.tick(clock)
  assert.equal(turns.length, 0)
  clock = IDLE_MS
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, [1])
  assert.equal(control.view('claude').busy, false)
  clock = IDLE_MS * 4
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, [1])
  assert.equal(control.note('claude', { id: 'say-self', self: false }), false)
  clock = IDLE_MS * 5
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, [1])
  assert.equal(control.note('claude', { id: 'player:1', self: false }), true)
  clock += IDLE_MS
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, [1, 1])
})

test('disconnect invalidates an in-flight turn and takeover has a resume path', async () => {
  let clock = 0
  let release
  const started = new Promise((resolve) => { release = resolve })
  let acted = 0
  const control = createMcControl({
    now: () => clock,
    runTurn: async (ctx) => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (!ctx.current()) return { stale: true }
      acted += 1
      return { ok: true }
    },
  })
  control.connect('claude')
  assert.equal(control.blocksMember('claude'), true)
  clock = IDLE_MS
  control.tick(clock)
  await started
  control.disconnect('claude')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(acted, 0)
  assert.equal(control.blocksMember('claude'), false)
  control.connect('claude')
  const held = control.takeover('claude')
  assert.equal(held.owner, 'manual')
  assert.equal(control.blocksMember('claude'), false)
  const back = control.resume('claude')
  assert.equal(back.owner, 'control')
  assert.equal(control.blocksMember('claude'), true)
  assert.equal(control.view('claude').deadline != null, true)
})

test('control decisions can only say', async () => {
  const sent = []
  const result = await applyDecision({
    toolCalls: [
      { name: 'move_to', arguments: { x: 1, y: 2, z: 3 } },
      { name: 'say', arguments: { text: 'hello', say_id: 'from-model' } },
      { name: 'break_block', arguments: { pos: { x: 1, y: 2, z: 3 } } },
    ],
  }, {
    current: () => true,
    markSelf() {},
    act: async (params) => {
      sent.push(params)
      return { ok: true, sent: 'hello', extras: { say_id: params.say_id } }
    },
  })
  assert.deepEqual(result.rejected, ['move_to', 'break_block'])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'hello')
  assert.equal(sent[0].say_id === 'from-model', false)
  assert.match(controlSystemPrompt({ lines: ['- seat'] }, ''), /只能用 say/)
})

test('mirror keeps two identical lines and drops the echo and private chat', async () => {
  const rows = []
  const texts = []
  let clock = 0
  const mirror = createMirror({ now: () => clock, cooldownMs: 3000, append: async (item) => { rows.push(item.id); texts.push(item.text) } })
  const first = await mirror.fromAction('claude', { ok: true, sent: '<Claude> hi', extras: { say_id: 'a', message_id: 'a', audience: 'public' } }, 'Claude')
  const echo = await mirror.consider({ data: { data: { source: 'agent', say_id: 'a', message_id: 'a', message: '<Claude> hi', audience: 'public' } } })
  const second = await mirror.fromAction('gpt', { ok: true, sent: '<GPT> hi', extras: { say_id: 'b', audience: 'public' } }, 'GPT')
  const priv = await mirror.fromAction('claude', { ok: false, sent: null, extras: { say_id: 'c' } })
  const quiet = await mirror.fromAction('claude', { ok: true, sent: 'secret', extras: { say_id: 'd', audience: 'private' } })
  const player = await mirror.consider({ data: { sequence: 9, data: { source: 'player', message_id: 'player:9', message: 'hey', player: 'Alex' } } })
  clock = 1000
  const cooled = await mirror.consider({ data: { data: { source: 'player', message_id: 'player:10', message: 'again', player: 'Alex' } } })
  clock = 4000
  const later = await mirror.consider({ data: { data: { source: 'player', message_id: 'player:11', message: 'later', player: 'Alex' } } })
  assert.equal(first.mirrored, true)
  assert.equal(echo.mirrored, false)
  assert.equal(second.mirrored, true)
  assert.equal(priv.reason, 'unconfirmed')
  assert.equal(quiet.reason, 'private')
  assert.equal(player.mirrored, true)
  assert.equal(cooled.reason, 'cooldown')
  assert.equal(later.mirrored, true)
  assert.deepEqual(rows, ['a', 'b', 'player:9', 'player:11'])
  assert.deepEqual(texts, ['hi', 'hi', 'hey', 'later'])
  assert.equal(stripRolePrefix('<Deepseek> ping'), 'ping')
  assert.equal(stripRolePrefix('plain'), 'plain')
  assert.equal(classifyChat({ data: { data: { source: 'player', message_id: 'player:1', message: 'x' } } }).kind, 'bystander')
  assert.equal(classifyChat({ data: { data: { source: 'player', message_id: 'player:2', message: '<Shiro> 你们能看见周围吗', player: 'Shiro' } } }).text, '你们能看见周围吗')
  assert.equal(classifyChat({ data: { data: { source: 'agent', say_id: 'z', message: '<GPT> shape2', audience: 'public', player: 'GPT' } } }).text, 'shape2')
})

test('releaseActive returns stuck head to pending', async () => {
  const { createSeatQueues } = await import('./mc-public-channel.mjs')
  const queues = createSeatQueues()
  queues.enqueue('seat-1', { id: 'player:9', kind: 'bystander', speaker: 'Shiro', text: 'hi' })
  assert.equal(queues.activateNext('seat-1')?.id, 'player:9')
  assert.equal(queues.releaseActive('seat-1')?.id, 'player:9')
  assert.equal(queues.active('seat-1'), null)
  assert.equal(queues.activateNext('seat-1')?.id, 'player:9')
})

test('auto-connect reconciles only when the world becomes reachable again', () => {
  assert.equal(bridgePort('ws://127.0.0.1:8765'), 8765)
  assert.equal(bridgePort(''), 8765)
  assert.deepEqual(shouldReconcile('0', false, true), { state: false, reconcile: false })
  assert.deepEqual(shouldReconcile('1', null, true), { state: true, reconcile: false })
  assert.deepEqual(shouldReconcile('1', true, false), { state: false, reconcile: false })
  assert.deepEqual(shouldReconcile('1', false, true), { state: true, reconcile: true })
  assert.deepEqual(shouldReconcile('1', true, true), { state: true, reconcile: false })
})

test('profileId selects the personal profile model and ignores template ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mc-profile-'))
  try {
    const first = await materializeProfile('profile_mc', { name: '甲', provider: 'anthropic', model: 'model-a' }, root)
    const second = await materializeProfile('profile_mc', { name: '乙', provider: 'openai', model: 'model-b' }, root)
    assert.deepEqual(profileChoices([{ id: 'profile_mc', name: '模板', template: true }, first]).map((item) => item.id), [first.id])
    const cfg = {
      chatroomSeats: [{ id: 'claude', enabled: true }],
      gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true, provider: 'old', model: 'old-model', profileId: first.id, persona: '不要出现' }]),
    }
    const used = await modelForSeat(cfg, 'claude', root)
    assert.equal(used.model, 'model-a')
    assert.equal(used.provider, 'anthropic')
    assert.equal(used.persona, '')
    cfg.gb_minecraft_MC_AGENTS = JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true, provider: 'old', model: 'old-model', profileId: second.id }])
    assert.equal((await modelForSeat(cfg, 'claude', root)).model, 'model-b')
    cfg.gb_minecraft_MC_AGENTS = JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true, profileId: 'profile_mc' }])
    assert.match((await modelForSeat(cfg, 'claude', root)).error, /出厂模板/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('control session is separate and rejects composer steps', async () => {
  const created = []
  const agents = {
    async create(input) { created.push(input); return { session: { id: input.sessionId, append() {} } } },
    get() { return null },
  }
  const presets = { async resolve(id) { return { id } } }
  const ids = new Set()
  const made = await ensureControlSession({ agents, presets, memberId: 'claude', name: 'Claude', remembered: {}, sessions: ids })
  assert.equal(made.created, true)
  assert.equal(created[0].meta.mcControl, 'claude')
  assert.equal(created[0].meta.agentPreset, 'guest')
  assert.equal(ids.has(made.sessionId), true)
  const events = []
  writeControlTurn({ append: (type, data) => events.push(type), _mcTurn: 1 }, 'hello')
  assert.deepEqual(events, ['turn/start', 'user/message', 'turn/end'])
  let rejected = null
  const off = mountControlGuards({
    tools: { guard(fn) { rejected = fn } },
    on(name, fn) { if (name === 'agent/pre-step') rejected = rejected },
  }, ids)
  assert.equal(rejected({ agent: { id: made.sessionId } }), 'Minecraft 控制会话不从输入框驱动世界。')
  assert.equal(rejected({ agent: { id: 'other' } }), undefined)
  off()
})


test('note delayMs 0 arms for the next tick and disarm clears a pending wake', async () => {
  let clock = 0
  const turns = []
  const control = createMcControl({
    now: () => clock,
    runTurn: async (ctx) => { turns.push(ctx.memberId); return { ok: true } },
  })
  control.connect('claude')
  control.disarm('claude')
  assert.equal(control.view('claude').deadline, null)
  assert.equal(control.note('claude', { id: 'poke', self: false }, { delayMs: 0 }), true)
  assert.equal(control.view('claude').deadline, clock)
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, ['claude'])
})

test('per-seat queue: public enqueues every seat; each seat serializes itself', async () => {
  const { createSeatQueues } = await import('./mc-public-channel.mjs')
  const queues = createSeatQueues()
  const seats = ['claude', 'gpt', 'deepseek']
  const hit = queues.enqueuePublic({ id: 'player:1', kind: 'bystander', speaker: 'Alex', text: 'hi' }, seats)
  assert.deepEqual(hit, seats)
  assert.equal(queues.enqueuePublic({ id: 'player:1', kind: 'bystander', speaker: 'Alex', text: 'hi' }, seats).length, 0)

  for (const sid of seats) {
    const head = queues.activateNext(sid)
    assert.equal(head.id, 'player:1')
    assert.equal(head.speaker, 'Alex')
    assert.equal(queues.active(sid).id, 'player:1')
  }

  // second public line stacks behind active
  queues.enqueuePublic({ id: 'player:2', kind: 'bystander', speaker: 'Alex', text: 'again' }, seats)
  assert.equal(queues.view('claude').pendingCount, 1)

  const next = queues.finish('claude', 'spoke')
  assert.equal(next.id, 'player:2')
  assert.equal(queues.active('claude').id, 'player:2')
  assert.equal(queues.finish('claude', 'silent'), null)
  assert.equal(queues.active('claude'), null)

  // other seats still on first item — independent queues
  assert.equal(queues.active('gpt').id, 'player:1')
})

test('per-seat queue: private only lands on the target seat', async () => {
  const { createSeatQueues } = await import('./mc-public-channel.mjs')
  const queues = createSeatQueues()
  assert.equal(queues.enqueuePrivate('claude', {
    id: 'priv:1', kind: 'bystander', audience: 'private', speaker: 'Alex', text: 'psst', target: 'ClaudeBot',
  }), true)
  assert.equal(queues.enqueuePrivate('gpt', { id: 'priv:1', kind: 'bystander', text: 'psst' }), true)
  // same id on another seat is allowed (per-seat seen); but host only enqueues on the observe seat.
  const head = queues.activateNext('claude')
  assert.equal(head.audience, 'private')
  assert.equal(head.text, 'psst')
  assert.equal(queues.active('gpt'), null)
  assert.equal(queues.activateNext('gpt').id, 'priv:1')
})

test('controlSystemPrompt names the queue head focus', () => {
  const withFocus = controlSystemPrompt({ lines: [] }, '', {
    id: 'player:1', kind: 'bystander', audience: 'public', speaker: 'Alex', text: 'hello there',
  })
  assert.match(withFocus, /本回合队首/)
  assert.match(withFocus, /Alex/)
  assert.match(withFocus, /hello there/)
  assert.match(withFocus, /一条回复队列/)
  assert.match(withFocus, /必须用 say/)
  const idle = controlSystemPrompt({ lines: [] }, '', null)
  assert.match(idle, /没有待回复的聊天队首/)
  assert.match(idle, /聊天默认不发言/)
  assert.match(idle, /不要用 say/)
  assert.match(idle, /禁止对公屏说/)
  assert.match(idle, /观察与按设计行动/)
  assert.doesNotMatch(idle, /保持安静，不要发言/)
})
test('AI public say no longer fan-out arms every other seat', async () => {
  let clock = 0
  const turns = []
  const control = createMcControl({
    now: () => clock,
    runTurn: async (ctx) => {
      turns.push(ctx.memberId)
      return { ok: true }
    },
  })
  control.connect('claude')
  control.connect('gpt')
  // clear connect one-shots so only explicit notes matter
  control.disarmAllExcept('')
  assert.equal(control.view('claude').deadline, null)
  assert.equal(control.view('gpt').deadline, null)
  // old behavior noted every other seat on AI say; new host leaves that to public channel.
  // Direct note of one seat must not imply the other is armed.
  assert.equal(control.note('claude', { id: 'say-from-gpt', self: false }), true)
  assert.equal(control.view('gpt').deadline, null)
  clock += IDLE_MS
  control.tick(clock)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(turns, ['claude'])
})
