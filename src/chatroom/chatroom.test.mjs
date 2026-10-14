import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { buildPrompt, isPass } from './transcript.mjs'
import { callSeat, toLlmMessages } from './providers.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats, normalizeSeats, migrateLegacyChatroom, chatroomSchemaShape, CHATROOM_KEYS, LEGACY_CHATROOM_KEYS } from './seats.mjs'
import { createChatroomFeature } from './index.mjs'
import { createDshCatalog, personaFromComposition } from '../dsh-catalog.mjs'
import z from 'schemastery'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-chatroom-'))
const SECRET = 'sk-test-not-real'

/**
 * 模拟 DSH LlmRuntime（@deepseek-ai/dsh-llm）：listProviders / listModels / listConfigurableProviders / stream。
 * replies[provider] = (options) => 文本 | { text, usage, error, hang, delayMs }
 */
function mockLlm(replies = {}, { providers } = {}) {
  const calls = []
  const list = providers || [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] },
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-x', name: 'GPT X' }] },
  ]
  return {
    calls,
    listProviders: () => list.map((p) => ({ id: p.id, name: p.name })),
    listConfigurableProviders: () => [...list.map((p) => ({ provider: p.id, displayName: p.name, settingsNs: 'llm-pi-ai', settingsPath: [p.id] })), { provider: 'xai', displayName: 'xAI', settingsNs: 'llm-pi-ai', settingsPath: ['xai'] }],
    listModels: async (id) => { const p = list.find((x) => x.id === id); if (!p) throw new Error('NO_ADAPTER'); return p.models.map((m) => ({ provider: id, ...m })) },
    async * stream(options) {
      calls.push(options)
      const r = replies[options.provider]?.(options) ?? `${options.model} 收到`
      const o = typeof r === 'string' ? { text: r } : r
      if (o.error) { yield { type: 'finish', reason: { kind: 'error', failure: { message: o.error, code: 'AUTH' } } }; return }
      yield { type: 'reasoning-delta', index: 0, text: '思考不应出现' }
      for (const ch of [...(o.text || '')]) {
        if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs))
        if (options.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }; return }
        yield { type: 'text-delta', index: 0, text: ch }
      }
      if (o.hang) await new Promise((res) => options.signal?.addEventListener('abort', res))
      if (options.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }; return }
      yield { type: 'usage', usage: o.usage || { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** 模拟 DSH 预设服务（@deepseek-ai/dsh-agent-preset-registry）。 */
function mockPresets() {
  const docs = {
    lingsnow: "- name: '@deepseek-ai/dsh-tool-bash'\n  when: !!js 'ctx.trusted'\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: 你是凌雪，说话温柔。{{date}}\n    complete: true\n",
    guest: "- name: '@deepseek-ai/dsh-tool-fs'\n",
  }
  return {
    defaultId: 'lingsnow',
    list: async () => [{ id: 'guest', name: '访客' }, { id: 'lingsnow', name: 'Deepseek大人' }, { id: 'bad', broken: 'import failed' }],
    readDocument: async (id) => { if (!docs[id]) throw new Error('agent-preset/not-found'); return { agentPreset: id, content: docs[id] } },
  }
}

const SEATS = [
  { id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: true },
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash', enabled: true },
  { id: 'claude', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
  { id: 'grok', name: 'Grok', provider: 'xai', model: 'grok-x', enabled: false },
]

test('seats: normalize ids/defaults/cap, schema has no secret fields', () => {
  const out = normalizeSeats([{ provider: 'openai', model: 'gpt-x' }, { id: 'A b', name: 'x' }, { id: 'ab' }, null, 'junk', ...Array.from({ length: 20 }, () => ({}))])
  assert.equal(out.length, 12)
  assert.equal(out[0].id, 'seat-1'); assert.equal(out[0].name, 'gpt-x'); assert.equal(out[0].enabled, true)
  assert.equal(out[1].id, 'ab'); assert.notEqual(out[2].id, 'ab')
  const shape = chatroomSchemaShape(z)
  assert.ok(!Object.values(shape).some((s) => s.meta?.role === 'secret'))
  assert.ok(!Object.keys(shape).some((k) => /ApiKey|BaseUrl|Proxy/.test(k) && k !== 'chatroomTelegramProxy'))
  assert.deepEqual(resolveSeats({ chatroomSeats: SEATS }).map((s) => s.id), ['gpt', 'deepseek', 'claude', 'grok'])
  assert.ok(!CHATROOM_KEYS.includes('chatroomSeats'))
})

test('seats: legacy fixed seats migrate to array; keys and base URLs are dropped', () => {
  const legacy = { chatroomOrder: 'grok,claude', chatroomGrokEnabled: true, chatroomGrokModel: 'grok-4.7', chatroomGrokApiKey: SECRET, chatroomClaudeEnabled: false, chatroomClaudeName: '小克', chatroomDeepseekApiKey: SECRET, chatroomGptBaseUrl: 'https://x' }
  const m = migrateLegacyChatroom(legacy)
  assert.deepEqual(m.seats.map((s) => `${s.id}:${s.provider}:${s.model}:${s.enabled}:${s.name}`), ['grok:xai:grok-4.7:true:Grok', 'claude:anthropic::false:小克'])
  assert.ok(!JSON.stringify(m.seats).includes(SECRET))
  assert.ok(m.present.includes('chatroomGrokApiKey') && m.present.includes('chatroomOrder') && m.present.every((k) => LEGACY_CHATROOM_KEYS.includes(k)))
  assert.equal(migrateLegacyChatroom({ ...legacy, chatroomSeats: SEATS }).seats, null)
  assert.deepEqual(migrateLegacyChatroom({ chatroomEnabled: true }).present, [])
})

test('catalog: providers with models, dormant providers, presets, persona from preset composition', async () => {
  const cat = createDshCatalog(null, { llm: mockLlm(), presets: mockPresets() })
  const p = await cat.providers()
  assert.equal(p.available, true)
  assert.deepEqual(p.providers.map((x) => `${x.id}:${x.models.map((m) => m.id).join('+')}`), ['deepseek:deepseek-flash', 'anthropic:claude-x', 'openai:gpt-x'])
  assert.deepEqual(p.dormant.map((x) => x.id), ['xai'])
  const pre = await cat.presets()
  assert.equal(pre.defaultId, 'lingsnow')
  assert.deepEqual(pre.presets.map((x) => x.id), ['guest', 'lingsnow', 'bad'])
  assert.equal(await cat.presetPersona('lingsnow'), '你是凌雪，说话温柔。')
  assert.equal(await cat.presetPersona('guest'), '')
  await assert.rejects(cat.presetPersona('bad'), /不可用/)
  await assert.rejects(cat.presetPersona('nope'), /不存在/)
  assert.equal(personaFromComposition('::: not yaml'), '')
  const none = createDshCatalog(null, { llm: null, presets: null })
  assert.equal((await none.providers()).available, false)
  assert.equal((await none.presets()).available, false)
})

const prompt = { system: 'SYS', messages: [{ role: 'user', content: '[Shiro] 你好' }, { role: 'assistant', content: '我之前说的' }, { role: 'user', content: '[Grok] 嗨' }] }

test('providers: call goes through ctx.llm.stream with DSH message shape; no reasoning; usage mapped', async () => {
  const llm = mockLlm()
  const seat = resolveSeats({ chatroomSeats: SEATS })[1]
  const deltas = []
  const out = await callSeat({ seat, prompt, llm, maxTokens: 77, onDelta: (t) => deltas.push(t) })
  assert.equal(out.text, 'deepseek-flash 收到')
  assert.equal(deltas.join(''), out.text)
  assert.deepEqual(out.usage, { input: 8, output: 2, cacheRead: 3, cacheWrite: 0 })
  const o = llm.calls[0]
  assert.equal(o.provider, 'deepseek'); assert.equal(o.model, 'deepseek-flash'); assert.equal(o.system, 'SYS'); assert.equal(o.maxTokens, 77)
  assert.deepEqual(o.messages.map((m) => `${m.role}:${m.source.kind}:${m.content[0].type}:${m.content[0].text}`), ['user:user:text:[Shiro] 你好', 'assistant:model:text:我之前说的', 'user:user:text:[Grok] 嗨'])
  assert.ok(o.messages.every((m) => typeof m.id === 'string' && m.id.length > 10))
  assert.equal(toLlmMessages(seat, [{ role: 'assistant', content: 'x' }])[0].source.provider, 'deepseek')
})

test('providers: failures surface as seat errors, unregistered provider refused before streaming', async () => {
  const llm = mockLlm({ openai: () => ({ error: 'invalid api key' }) })
  const seats = resolveSeats({ chatroomSeats: SEATS })
  await assert.rejects(callSeat({ seat: seats[0], prompt, llm }), /GPT 请求失败：invalid api key/)
  await assert.rejects(callSeat({ seat: seats[3], prompt, llm }), /未在 DSH 中启用/)
  await assert.rejects(callSeat({ seat: { ...seats[0], model: '' }, prompt, llm }), /未选择模型/)
  await assert.rejects(callSeat({ seat: seats[0], prompt, llm: null }), /服务商服务不可用/)
  assert.equal(llm.calls.length, 1)
})


test('store: append-only jsonl, seq, meta, reload, truncated line tolerated', async () => {
  const dir = await tmp()
  try {
    const s = createStore(dir)
    const room = await s.createRoom({ title: '测试' })
    await Promise.all([1, 2, 3].map((i) => s.append(room.id, { kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: 'm' + i })))
    const file = join(dir, 'rooms', room.id, 'messages.jsonl')
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.trim().split('\n').length, 3)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(file, '{"broken', 'utf8')
    const s2 = createStore(dir)
    const msgs = await s2.readMessages(room.id)
    assert.deepEqual(msgs.map((m) => m.seq), [1, 2, 3])
    assert.equal((await s2.getRoom(room.id)).messages, 3)
    assert.equal((await s2.listRooms()).length, 1)
    await assert.rejects(s2.getRoom('../x'), /无效/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

function scriptedCall(script, seen = []) {
  return async ({ seat, prompt, signal, onDelta }) => {
    seen.push({ seat: seat.id, prompt })
    const step = script[seat.id]?.shift?.() ?? 'ok'
    if (step === 'hang') {
      onDelta?.('部分')
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { aborted: true, partial: { text: '部分', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }))))
    }
    if (step === 'error') throw new Error('boom')
    const text = step === 'pass' ? '[PASS]' : `${seat.name} 说 ${step}`
    onDelta?.(text)
    return { text, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }
  }
}

async function moderatorFixture(cfgOver = {}, script = {}) {
  const dir = await tmp()
  const store = createStore(dir)
  const room = await store.createRoom({})
  const seen = []
  const events = []
  const seats = cfgOver.seats || [SEATS[0], SEATS[1], SEATS[2]]
  const mod = createModerator({
    store, call: scriptedCall(script, seen), emit: (_, e) => events.push(e),
    resolvePersona: (seat) => { if (seat.preset === 'bad') throw new Error('预设 bad 不可用'); return '人设 ' + seat.preset },
    getRoomConfig: () => ({ seats: resolveSeats({ chatroomSeats: seats }), userName: 'Shiro', autoRounds: cfgOver.rounds || 1, maxTokens: 100 }),
  })
  return { dir, store, room, mod, seen, events }
}





test('feature: API end to end over mocked DSH llm + presets: catalog, seats CRUD, streaming, stop, no secrets', async () => {
  const dir = await tmp()
  let cfg = { ...z.object(chatroomSchemaShape(z))({}), chatroomEnabled: false, chatroomTurnBudget: 4 }
  const llm = mockLlm({ anthropic: () => ({ text: 'Claude到啦', delayMs: 2 }), openai: () => ({ error: '未配置凭据 OPENAI_API_KEY' }) })
  const saved = []
  const feat = createChatroomFeature(null, () => cfg, { dir, llm, presets: mockPresets(), saveSeats: async (seats) => { saved.push(seats); cfg = { ...cfg, chatroomSeats: seats } } })
  const call = async (method, sub, body, headers = {}) => {
    let status, json
    const res = { writeHead() {}, write() {}, end() {}, on() {} }
    await feat.handleApi({ method, headers, on() {} }, res, sub, { sendJson: (_, s, j) => { status = s; json = j }, readBody: async () => JSON.stringify(body || {}) })
    return { status, json }
  }
  try {
    assert.equal((await call('POST', '/chatroom/rooms', {})).status, 409)
    const cat = (await call('GET', '/chatroom/catalog')).json
    assert.deepEqual(cat.llm.providers.map((p) => p.id), ['deepseek', 'anthropic', 'openai'])
    assert.deepEqual(cat.presets.presets.map((p) => p.id), ['guest', 'lingsnow', 'bad'])
    assert.equal((await call('PUT', '/chatroom/seats', { seats: 'x' })).status, 400)
    assert.equal((await call('PUT', '/chatroom/seats', { seats: [] }, { 'sec-fetch-site': 'cross-site' })).status, 403)
    const put = await call('PUT', '/chatroom/seats', { seats: [
      { id: 'ds', name: '小深', provider: 'deepseek', model: 'deepseek-flash', preset: 'lingsnow', enabled: true },
      { id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
      { id: 'oa', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: true },
      { id: 'xa', name: 'Grok', provider: 'xai', model: 'grok-x', enabled: true },
      { id: 'off', name: '关', provider: 'deepseek', model: 'nope', enabled: false },
    ] })
    assert.equal(put.status, 200)
    assert.equal(saved.length, 1)
    const ov = put.json
    assert.deepEqual(ov.seats.map((s) => `${s.id}:${s.ready}`), ['ds:true', 'cl:true', 'oa:true', 'xa:false', 'off:false'])
    assert.match(ov.seats[3].problem, /未在 DSH 中启用/)
    assert.match(ov.seats[4].problem, /不在该服务商的模型列表/)
    assert.equal(ov.seats[0].presetName, 'Deepseek大人')
    cfg = { ...cfg, chatroomEnabled: true }
    const room = (await call('POST', '/chatroom/rooms', { title: '圆桌' })).json.room
    const written = []
    feat.handleApi({ method: 'GET', headers: {}, on() {} }, { writeHead() {}, write: (s) => written.push(s), end() {}, on() {} }, `/chatroom/rooms/${room.id}/events`, { sendJson() {}, readBody: async () => '' })
    const posted = await call('POST', `/chatroom/rooms/${room.id}/messages`, { text: '各位好' })
    assert.equal(posted.json.started, true)
    for (let i = 0; i < 200 && feat.moderator.status(room.id).running; i++) await new Promise((r) => setTimeout(r, 10))
    const got = (await call('GET', `/chatroom/rooms/${room.id}`)).json
    assert.deepEqual(got.messages.map((m) => `${m.speaker.id}:${m.status}:${m.text}`), ['user:ok:各位好', 'ds:ok:deepseek-flash 收到', 'cl:ok:Claude到啦', 'oa:error:', 'xa:error:', 'ds:ok:deepseek-flash 收到'])
    assert.equal(got.messages[5].budgetReport, true)
    assert.equal(got.task.state, 'budget')
    assert.match(got.messages[3].error, /OPENAI_API_KEY/)
    assert.match(got.messages[4].error, /未在 DSH 中启用/)
    assert.match(llm.calls[0].system, /你是凌雪，说话温柔。/)
    assert.equal(got.messages[1].usage.cacheRead, 3)
    const stream = written.join('')
    assert.match(stream, /event: hello/)
    assert.match(stream, /event: delta/)
    assert.ok(!stream.includes('思考不应出现'))
    // stop during a slow stream
    cfg = { ...cfg, chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true }] }
    await call('POST', `/chatroom/rooms/${room.id}/messages`, { text: '@Claude 再说一次' })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal((await call('POST', `/chatroom/rooms/${room.id}/stop`)).json.stopped, true)
    for (let i = 0; i < 100 && feat.moderator.status(room.id).running; i++) await new Promise((r) => setTimeout(r, 10))
    const last = (await call('GET', `/chatroom/rooms/${room.id}`)).json.messages.at(-1)
    assert.equal(last.status, 'stopped')
    assert.ok(llm.calls.at(-1).signal.aborted)
  } finally { await feat.dispose(); await rm(dir, { recursive: true, force: true }) }
})

// ── 房间会话（./room-sessions.mjs）──
import { createRoomSessions, userTextOf, roomSessionTitle, NO_TOOLS_MESSAGE, ROOM_PRESET, listableSeed } from './room-sessions.mjs'

function fakeDsh({ presets = ['guest', 'lingsnow'], persisted = new Set(), journals: seedJournals } = {}) {
  const log = { created: [], resumed: [], renamed: [], attached: [], disposed: [], mounted: [], appended: [] }
  const guards = []
  const hooks = []
  const live = new Map()
  const journals = new Map()
  if (seedJournals) for (const [id, evs] of seedJournals) journals.set(id, evs.map((e) => ({ type: e.type, seq: e.seq, time: e.time, data: e.data && typeof e.data === 'object' ? { ...e.data } : e.data })))

  function metaOf(id) {
    let blank = true, lastTurn = 0
    for (const e of journals.get(id) || []) {
      if (e.type === 'turn/start') { blank = false; lastTurn = Number(e.data?.turn) || lastTurn }
    }
    return { blank, lastTurn }
  }

  function sessionOf(id) {
    if (!journals.has(id)) journals.set(id, [])
    const events = journals.get(id)
    return {
      id,
      get seq() { return events.length },
      events() { return events.slice() },
      append(type, data) {
        const ev = { type, seq: events.length, time: Date.now(), data }
        events.push(ev)
        log.appended.push([id, type, data])
        return ev
      },
    }
  }

  function handleFor(id) {
    const agent = { id, session: sessionOf(id) }
    return { agent, async dispose() { log.disposed.push(id); live.delete(id) } }
  }

  const services = {
    agents: {
      async create(o) {
        log.created.push(o)
        await o.setup?.({ fake: true })
        persisted.add(o.sessionId)
        journals.set(o.sessionId, [])
        if (Array.isArray(o.seed)) {
          for (const ev of o.seed) {
            journals.get(o.sessionId).push({ type: ev.type, seq: ev.seq, time: ev.time, data: ev.data })
            log.appended.push([o.sessionId, ev.type, ev.data])
          }
        }
        const h = handleFor(o.sessionId)
        live.set(o.sessionId, h.agent)
        return h
      },
      async resume(o) {
        if (!persisted.has(o.resumeSessionId)) throw new Error(`session ${o.resumeSessionId} not found`)
        log.resumed.push(o)
        if (!journals.has(o.resumeSessionId)) journals.set(o.resumeSessionId, [])
        const h = handleFor(o.resumeSessionId)
        live.set(o.resumeSessionId, h.agent)
        return h
      },
      get: (id) => live.get(id),
    },
    agentPresets: {
      async resolve(id) { if (!presets.includes(id)) throw new Error('Unknown agent preset: ' + id); return { id } },
      async mount(_c, id) { log.mounted.push(id) },
    },
    sessions: { get: (id) => live.get(id)?.session },
    sessionProjections: {
      stateOf(session, key) {
        const { blank, lastTurn } = metaOf(session.id)
        if (key === 'sessionListMetadata') return { blank, lastPromptAt: null }
        if (key === 'turnBoundary') return { lastTurn, openTurnStartSeq: null }
        return undefined
      },
    },
    sessionTitle: { rename(session, title) { log.renamed.push([session.id, title]); return { title } } },
    workspaceRegistry: { async resolveByPath() { return undefined }, async create(path, title) { return { id: 'ws', path, title, async attachSession(id) { log.attached.push([title, id]) } } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) },
  }
  const ctx = {
    tools: { guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) } },
    on(name, fn) { if (name === 'agent/pre-step') hooks.push(fn); return () => hooks.splice(hooks.indexOf(fn), 1) },
    get: (n) => services[n],
  }
  const guard = (exec) => { for (const g of guards) { const r = g(exec); if (r) return r } return undefined }
  const preStep = async (agentId, messages) => {
    const next = async () => ({ kind: 'enter', messages })
    if (!hooks.length) return next()
    return hooks[0]({ agent: { id: agentId }, messages, turn: 1, step: 1, signal: new AbortController().signal }, next)
  }
  return { ctx, log, guard, preStep, persisted, guards, hooks, journals, metaOf }
}

test('room sessions: user text extraction and title', () => {
  assert.equal(userTextOf([{ role: 'user', content: [{ type: 'text', text: ' 你好 ' }, { type: 'image' }] }, { role: 'system', content: 'x' }, { role: 'user', content: '再见' }]), '你好\n\n再见')
  assert.equal(userTextOf([]), '')
  assert.equal(roomSessionTitle({ title: '方案讨论' }), '聊天室：方案讨论')
  assert.equal(ROOM_PRESET, 'guest')
  const seed = listableSeed(1_700_000_000_000)
  assert.deepEqual(seed.map((e) => e.type), ['turn/start', 'turn/end'])
  assert.equal(seed[0].seq, 0)
  assert.equal(seed[1].seq, 1)
  assert.equal(seed[0].data.turn, 1)
  assert.deepEqual(seed[1].data.reason, { kind: 'completed' })
})

test('room sessions: create with guest preset, map in store, title, workspace, tools denied, composer text forwarded, resume on restart', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const dsh = fakeDsh()
    const forwarded = []
    const rs = createRoomSessions({ ctx: dsh.ctx, store, cwd: join(dir, 'ws'), onUserText: async (roomId, text) => { forwarded.push([roomId, text]) } })
    await rs.start()
    const room = await store.createRoom({ title: '方案讨论' })
    const out = await rs.ensure(room.id)
    assert.equal(out.created, true)
    const [opts] = dsh.log.created
    assert.equal(opts.sessionId, out.sessionId)
    assert.equal(opts.meta.agentPreset, 'guest')
    assert.equal(opts.meta.cwd, join(dir, 'ws'))
    assert.deepEqual(opts.agentOptions, { model: 'deepseek-flash', provider: 'deepseek' })
    assert.equal(opts.seed?.length, 2)
    assert.equal(opts.seed[0].type, 'turn/start')
    assert.equal(opts.seed[1].type, 'turn/end')
    assert.equal(opts.seed[1].data.reason.kind, 'completed')
    assert.equal(dsh.metaOf(out.sessionId).blank, false)
    assert.deepEqual(dsh.log.mounted, ['guest'])
    assert.deepEqual(dsh.log.renamed, [[out.sessionId, '聊天室：方案讨论']])
    assert.deepEqual(dsh.log.attached, [['聊天室', out.sessionId]])
    assert.equal((await store.getRoom(room.id)).sessionId, out.sessionId)
    assert.deepEqual(rs.list(), { [out.sessionId]: room.id })
    // 再次 ensure 不重复创建
    assert.equal((await rs.ensure(room.id)).created, false)
    assert.equal(dsh.log.created.length, 1)
    // 工具：房间会话一律拒绝，其他会话不受影响
    assert.equal(dsh.guard({ agent: { id: out.sessionId }, name: 'web_search' }), NO_TOOLS_MESSAGE)
    assert.equal(dsh.guard({ agent: { id: 'other' }, name: 'run_code' }), undefined)
    // 普通输入框：拒绝进入模型步骤，文字转进聊天室；其他会话照常
    const d = await dsh.preStep(out.sessionId, [{ role: 'user', content: [{ type: 'text', text: '大家怎么看' }] }])
    assert.deepEqual(d, { kind: 'reject' })
    assert.deepEqual(forwarded, [[room.id, '大家怎么看']])
    assert.equal((await dsh.preStep('other', [])).kind, 'enter')
    // 改名同步标题
    await store.renameRoom(room.id, '新名字')
    await rs.retitle(room.id)
    assert.deepEqual(dsh.log.renamed.at(-1), [out.sessionId, '聊天室：新名字'])
    await rs.dispose()
    assert.deepEqual(dsh.log.disposed, [out.sessionId])
    assert.equal(dsh.guards.length + dsh.hooks.length, 0)
    // 重启：resume 原会话，不新建
    const dsh2 = fakeDsh({ persisted: dsh.persisted, journals: dsh.journals })
    const rs2 = createRoomSessions({ ctx: dsh2.ctx, store: createStore(dir), cwd: join(dir, 'ws'), onUserText: async () => {} })
    await rs2.start()
    assert.equal(dsh2.log.created.length, 0)
    assert.deepEqual(dsh2.log.resumed.map((o) => o.resumeSessionId), [out.sessionId])
    assert.equal(dsh2.guard({ agent: { id: out.sessionId }, name: 'x' }), NO_TOOLS_MESSAGE)
    await rs2.dispose()
    // 原会话已删除：重新创建并改写映射
    const dsh3 = fakeDsh()
    const rs3 = createRoomSessions({ ctx: dsh3.ctx, store: createStore(dir), cwd: join(dir, 'ws'), onUserText: async () => {} })
    const again = await rs3.ensure(room.id)
    assert.equal(again.created, true)
    assert.equal(again.replaced, out.sessionId)
    assert.notEqual(again.sessionId, out.sessionId)
    assert.equal((await createStore(dir).getRoom(room.id)).sessionId, again.sessionId)
    await rs3.dispose()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('room sessions: existing blank session becomes listable on ensure (empty closed turn, no surface message)', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const dsh = fakeDsh()
    const rs = createRoomSessions({ ctx: dsh.ctx, store, cwd: join(dir, 'ws'), onUserText: async () => {} })
    await rs.start()
    const room = await store.createRoom({ title: '空白' })
    // 模拟旧版：已有 sessionId、但日志里没有 turn/start（blank）
    const sid = 'blank-' + Date.now().toString(36)
    dsh.persisted.add(sid)
    dsh.journals.set(sid, [{ type: 'session/title', seq: 0, time: Date.now(), data: { title: '聊天室：空白' } }])
    await store.setRoomSession(room.id, sid)
    assert.equal(dsh.metaOf(sid).blank, true)
    const out = await rs.ensure(room.id)
    assert.equal(out.sessionId, sid)
    assert.equal(out.listable, true)
    assert.equal(dsh.metaOf(sid).blank, false)
    const types = (dsh.journals.get(sid) || []).map((e) => e.type)
    assert.ok(types.includes('turn/start') && types.includes('turn/end'))
    assert.ok(!types.includes('user/message') && !types.includes('assistant/message') && !types.includes('system/message'))
    // dispose+resume 以同步 lastTurn
    assert.ok(dsh.log.disposed.includes(sid))
    assert.ok(dsh.log.resumed.some((o) => o.resumeSessionId === sid))
    await rs.dispose()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('room sessions: no guest preset → refuse (never another preset); no agents service → clear error', async () => {
  const dir = await tmp()
  try {
    const store = createStore(dir)
    const room = await store.createRoom({ title: 'x' })
    const dsh = fakeDsh({ presets: ['lingsnow'] })
    const rs = createRoomSessions({ ctx: dsh.ctx, store, cwd: '', onUserText: async () => {} })
    await assert.rejects(rs.ensure(room.id), /访客模式/)
    assert.equal(dsh.log.created.length, 0)
    const rs2 = createRoomSessions({ ctx: null, store, cwd: '', onUserText: async () => {} })
    await assert.rejects(rs2.ensure(room.id), /智能体服务不可用/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('feature: new room gets a room session; /chatroom/sessions maps it; composer text becomes the user message', async () => {
  const dir = await tmp()
  try {
    const dsh = fakeDsh()
    const llm = mockLlm()
    const cfg = { chatroomEnabled: true, chatroomSeats: [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash', enabled: true }] }
    const feat = createChatroomFeature(dsh.ctx, () => cfg, { dir, llm, presets: mockPresets() })
    await feat.sync()
    const call = async (method, sub, body) => {
      let status = 0; let out = null
      await feat.handleApi({ method, headers: {} }, { writeHead() {} }, sub, { sendJson: (_r, s, b) => { status = s; out = b }, readBody: async () => (body ? JSON.stringify(body) : '') })
      return { status, body: out }
    }
    const created = await call('POST', '/chatroom/rooms', { title: '讨论' })
    assert.equal(created.status, 200)
    assert.ok(created.body.sessionId)
    assert.equal(created.body.room.sessionId, created.body.sessionId)
    const map = await call('GET', '/chatroom/sessions')
    assert.deepEqual(map.body.sessions, { [created.body.sessionId]: created.body.room.id })
    assert.equal((await call('POST', `/chatroom/rooms/${created.body.room.id}/session`)).body.created, false)
    assert.deepEqual(await dsh.preStep(created.body.sessionId, [{ role: 'user', content: [{ type: 'text', text: '各位好' }] }]), { kind: 'reject' })
    for (let i = 0; i < 50 && !(await feat.store.readMessages(created.body.room.id)).some((m) => m.kind === 'seat'); i++) await new Promise((r) => setTimeout(r, 20))
    const msgs = await feat.store.readMessages(created.body.room.id)
    assert.equal(msgs[0].kind, 'user')
    assert.equal(msgs[0].text, '各位好')
    assert.ok(msgs.some((m) => m.kind === 'seat'))
    await feat.dispose()
    assert.equal(dsh.log.disposed.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
