import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { matchSeat, syncDefaultMain, chatroomSchemaShape, normalizeSeats } from './seats.mjs'
import { createChatroomFeature } from './index.mjs'
import { createModerator } from './moderator.mjs'
import { createStore } from './store.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-main-'))

test('syncDefaultMain: empty + first member sets that member; delete clears; keep when still present', () => {
  assert.equal(syncDefaultMain('', [], []), '')
  assert.equal(syncDefaultMain('deepseek', [], [{ id: 'x' }]), '')
  const one = [{ id: 'seat-1', name: '小深', aliases: ['ds'] }]
  assert.equal(syncDefaultMain('', one, []), 'seat-1')
  assert.equal(syncDefaultMain('小深', one, one), 'seat-1')
  assert.equal(syncDefaultMain('ds', one, one), 'seat-1')
  const two = [
    { id: 'seat-1', name: '小深' },
    { id: 'seat-2', name: 'Claude' },
  ]
  assert.equal(syncDefaultMain('seat-1', two, two), 'seat-1')
  // 删除主答后即使仍剩一位，也清空（不是「加入第一位」）
  assert.equal(syncDefaultMain('seat-1', [{ id: 'seat-2', name: 'Claude' }], two), '')
  assert.equal(syncDefaultMain('', two, two), '')
  assert.equal(matchSeat(two, 'Claude').id, 'seat-2')
})

test('schema: chatroomDefaultMain defaults to empty string', () => {
  const cfg = z.object(chatroomSchemaShape(z))({})
  assert.equal(cfg.chatroomDefaultMain, '')
})

function mockPresets() {
  return {
    defaultId: 'lingsnow',
    list: async () => [{ id: 'guest', name: '访客' }, { id: 'lingsnow', name: 'Deepseek大人' }],
    readDocument: async () => ({ agentPreset: 'guest', content: '' }),
  }
}

function mockLlm() {
  const list = [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] },
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-x', name: 'GPT X' }] },
  ]
  return {
    listProviders: () => list.map((p) => ({ id: p.id, name: p.name })),
    listConfigurableProviders: () => list.map((p) => ({ provider: p.id, displayName: p.name, settingsNs: 'llm-pi-ai', settingsPath: [p.id] })),
    listModels: async (id) => {
      const p = list.find((x) => x.id === id)
      if (!p) throw new Error('NO_ADAPTER')
      return p.models.map((m) => ({ provider: id, ...m }))
    },
    async * stream() { yield { type: 'text-delta', index: 0, text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } } },
  }
}

test('API: first seat added sets 主答; deleting that seat clears 主答; config rejects empty 主答', async () => {
  const dir = await tmp()
  let cfg = { ...z.object(chatroomSchemaShape(z))({}), chatroomEnabled: false, chatroomSeats: [] }
  const feat = createChatroomFeature(null, () => cfg, {
    dir,
    llm: mockLlm(),
    presets: mockPresets(),
    saveSeats: async (seats) => { cfg = { ...cfg, chatroomSeats: seats } },
    savePatch: async (patch) => { cfg = { ...cfg, ...patch } },
  })
  const call = async (method, sub, body) => {
    let status, json
    const res = { writeHead() {}, write() {}, end() {}, on() {} }
    await feat.handleApi({ method, headers: {}, on() {} }, res, sub, {
      sendJson: (_, s, j) => { status = s; json = j },
      readBody: async () => JSON.stringify(body || {}),
    })
    return { status, json }
  }
  try {
    assert.equal(cfg.chatroomDefaultMain, '')
    const add1 = await call('PUT', '/chatroom/seats', {
      seats: [{ id: 'ds', name: '小深', provider: 'deepseek', model: 'deepseek-flash', enabled: true }],
    })
    assert.equal(add1.status, 200, JSON.stringify(add1.json))
    assert.equal(cfg.chatroomDefaultMain, 'ds')
    assert.equal(add1.json.defaultMain, 'ds')

    const add2 = await call('PUT', '/chatroom/seats', {
      seats: [
        { id: 'ds', name: '小深', provider: 'deepseek', model: 'deepseek-flash', enabled: true },
        { id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
      ],
      baseRev: add1.json.seatsRev,
    })
    assert.equal(add2.status, 200)
    assert.equal(cfg.chatroomDefaultMain, 'ds')

    const del = await call('PUT', '/chatroom/seats', {
      seats: [{ id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true }],
      baseRev: add2.json.seatsRev,
    })
    assert.equal(del.status, 200)
    assert.equal(cfg.chatroomDefaultMain, '')
    assert.equal(del.json.defaultMain, '')

    const many = await call('PUT', '/chatroom/seats', {
      seats: [
        { id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
        { id: 'oa', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: true },
      ],
      baseRev: del.json.seatsRev,
    })
    assert.equal(many.status, 200)
    assert.equal(cfg.chatroomDefaultMain, '')

    cfg = { ...cfg, chatroomDefaultMain: '', chatroomSeats: normalizeSeats([
      { id: 'cl', name: 'Claude', provider: 'anthropic', model: 'claude-x', enabled: true },
      { id: 'oa', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: true },
    ]) }
    const emptyCfg = await call('PUT', '/chatroom/config', { defaultMain: '' })
    assert.equal(emptyCfg.status, 400)
    assert.match(emptyCfg.json.error, /请选择主答成员/)
    const bad = await call('PUT', '/chatroom/config', { defaultMain: 'nobody' })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /成员/)
    const ok = await call('PUT', '/chatroom/config', { defaultMain: 'Claude' })
    assert.equal(ok.status, 200)
    assert.equal(cfg.chatroomDefaultMain, 'cl')
  } finally {
    try { await feat.dispose?.() } catch {}
    await rm(dir, { recursive: true, force: true })
  }
})

test('moderator: local user message relays via 主答 seat, not ingest fallback', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const room = await store.createRoom({})
  const relayed = []
  const seats = [
    { id: 'seat-1', name: 'deepseek', provider: 'deepseek', model: 'm', enabled: true, telegram: { ingest: true } },
    { id: 'seat-2', name: 'Claude', provider: 'anthropic', model: 'm', enabled: true },
  ]
  const mod = createModerator({
    store,
    call: async () => ({ text: '[PASS]' }),
    tg: {
      typing: () => () => {},
      relay: async (seat, _roomId, text, opts) => {
        relayed.push({ seatId: seat?.id || null, text, prefix: opts?.prefixName || '' })
        return []
      },
    },
    getRoomConfig: () => ({
      seats,
      userName: 'Shiro',
      maxTokens: 100,
      budget: 3,
      defaultMain: 'seat-2',
      tools: { enabled: false },
      attachments: { enabled: false },
    }),
    saveRoomControl: async () => ({}),
  })
  try {
    const r = await mod.post(room.id, '你好', { owner: true, source: 'local', userName: 'Shiro', run: false })
    assert.ok(r.message)
    assert.equal(relayed.length, 1)
    assert.equal(relayed[0].seatId, 'seat-2')
    assert.equal(relayed[0].prefix, 'Shiro')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('moderator: newTask uses configured 主答; no deepseek hard-fallback when unset', async () => {
  const dir = await tmp()
  const store = createStore(dir)
  const room = await store.createRoom({})
  const seats = [
    { id: 'seat-gpt', name: 'GPT', provider: 'openai', model: 'm', enabled: true },
    { id: 'seat-ds', name: 'deepseek', provider: 'deepseek', model: 'm', enabled: true },
  ]
  const seen = []
  const mod = createModerator({
    store,
    call: async ({ seat }) => { seen.push(seat.id); return { text: '[PASS]' } },
    getRoomConfig: () => ({
      seats,
      userName: 'Shiro',
      maxTokens: 100,
      budget: 2,
      defaultMain: 'seat-gpt',
      tools: { enabled: false },
      attachments: { enabled: false },
    }),
    saveRoomControl: async () => ({}),
  })
  try {
    const r = await mod.post(room.id, '请开始', { owner: true, source: 'local', userName: 'Shiro' })
    await r.promise
    assert.equal(mod.status(room.id).task.main, 'seat-gpt')
    assert.equal(seen[0], 'seat-gpt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
