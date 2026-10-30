import test from 'node:test'
import assert from 'node:assert/strict'
import { activeAgents, codeError, importFromSeats, migrateLegacyAgents, nameError, normalizeAgent, parseAgents, resolveAgents, serializeAgents, setRemoved } from './agents.mjs'
import { memberIdsFor } from './members.mjs'
import { toGameBotPatch } from './fields.mjs'

const SEATS = [
  { id: 'claude', name: 'Claude', provider: 'anthropic', model: 'claude-x', preset: 'p1', reasoningEffort: 'high', persona: '简洁', enabled: true, telegram: { tokenRef: 'T' } },
  { id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: false },
  { id: 'grok', name: 'Grok', provider: 'xai', model: 'grok-x', enabled: true },
  { id: 'Bad_Id', name: 'Bad', enabled: true },
]

test('code validation rejects empty, long, invalid and duplicate codes', () => {
  assert.equal(codeError('claude'), '')
  assert.equal(codeError('a-1'), '')
  assert.equal(codeError('a'.repeat(32)), '')
  assert.match(codeError(''), /不能为空/)
  assert.match(codeError('a'.repeat(33)), /不能超过 32/)
  assert.match(codeError('Claude'), /小写字母/)
  assert.match(codeError('-abc'), /开头/)
  assert.match(codeError('a_b'), /小写字母/)
  assert.match(codeError('claude', ['claude']), /已存在/)
  assert.deepEqual(parseAgents(JSON.stringify([{ code: 'ok' }, { code: 'Bad' }, { code: 'ok' }, { code: 'x'.repeat(40) }])).map((a) => a.code), ['ok'])
})

test('migration from MC_MEMBER_IDS / MC_USERNAME happens only while MC_AGENTS is unset', () => {
  const all = migrateLegacyAgents({ chatroomSeats: SEATS })
  assert.deepEqual(all.map((a) => a.code), ['claude', 'grok'])
  assert.equal(all[0].model, 'claude-x')
  const one = migrateLegacyAgents({ chatroomSeats: SEATS, gb_minecraft_MC_MEMBER_IDS: 'grok, nobody', gb_minecraft_MC_USERNAME: 'Steve' })
  assert.deepEqual(one.map((a) => [a.code, a.name]), [['grok', 'Grok'], ['nobody', 'nobody']])
  const single = migrateLegacyAgents({ chatroomSeats: SEATS, gb_minecraft_MC_MEMBER_IDS: 'grok', gb_minecraft_MC_USERNAME: 'Steve' })
  assert.equal(single[0].name, 'Steve')
  assert.deepEqual(resolveAgents({ chatroomSeats: SEATS, gb_minecraft_MC_AGENTS: '[]' }), [])
  assert.deepEqual(resolveAgents({ chatroomSeats: SEATS, gb_minecraft_MC_AGENTS: '', gb_minecraft_MC_MEMBER_IDS: 'claude' }).map((a) => a.code), ['claude'])
  // 旧行为保持：未保存表时 roster 与旧 MC_MEMBER_IDS 语义一致
  assert.deepEqual(memberIdsFor({ chatroomSeats: SEATS, gb_minecraft_MC_MEMBER_IDS: 'grok, missing' }), ['grok'])
})

test('import from chatroom copies config, never mutates seats, asks before overwriting', () => {
  const seats = structuredClone(SEATS)
  const before = JSON.stringify(seats)
  const base = [{ code: 'grok', name: '老 Grok', enabled: false, removed: true, provider: 'p', model: 'm', preset: '', reasoningEffort: '', persona: '' }]
  const r = importFromSeats(base, seats, ['claude', 'grok', 'Bad_Id', 'missing'])
  assert.deepEqual(r.added, ['claude'])
  assert.deepEqual(r.conflicts, ['grok'])
  assert.deepEqual(r.invalid, ['Bad_Id', 'missing'])
  const c = r.agents.find((a) => a.code === 'claude')
  assert.deepEqual(c, { code: 'claude', name: 'Claude', enabled: true, removed: false, provider: 'anthropic', model: 'claude-x', preset: 'p1', reasoningEffort: 'high', persona: '', profileId: '' })
  assert.equal(r.agents.find((a) => a.code === 'grok').name, '老 Grok')
  assert.equal(base[0].name, '老 Grok')
  const o = importFromSeats(base, seats, ['grok'], { overwrite: true })
  assert.deepEqual(o.overwritten, ['grok'])
  assert.equal(o.agents[0].model, 'grok-x')
  assert.equal(o.agents[0].removed, false)
  assert.equal(o.agents[0].enabled, false)
  assert.equal(JSON.stringify(seats), before)
})

test('soft delete keeps the row, takes it offline, and can be restored', () => {
  const list = parseAgents(serializeAgents([{ code: 'claude', name: 'Claude' }, { code: 'grok', name: 'Grok' }]))
  const removed = setRemoved(list, 'grok', true)
  assert.equal(removed.length, 2)
  assert.equal(removed[1].removed, true)
  assert.equal(removed[1].name, 'Grok')
  const cfg = { chatroomSeats: SEATS, gb_minecraft_MC_AGENTS: serializeAgents(removed) }
  assert.deepEqual(activeAgents(cfg).map((a) => a.code), ['claude'])
  assert.deepEqual(memberIdsFor(cfg), ['claude'])
  const back = setRemoved(removed, 'grok', false)
  assert.deepEqual(memberIdsFor({ ...cfg, gb_minecraft_MC_AGENTS: serializeAgents(back) }), ['claude', 'grok'])
})

test('GameBot patch derives MC_MEMBER_IDS / MC_USERNAME from enabled rows and omits the table', () => {
  const agents = [{ code: 'grok', name: 'Grok NPC' }, { code: 'claude', name: 'Claude', enabled: false }, { code: 'zed', name: 'Zed', removed: true }]
  const body = toGameBotPatch('minecraft', { chatroomSeats: SEATS, gb_minecraft_MC_AGENTS: serializeAgents(agents) })
  assert.equal(body.config.MC_MEMBER_IDS, 'grok')
  assert.equal(body.config.MC_USERNAME, 'Grok')
  assert.equal(body.config.MC_AGENTS, undefined)
  const legacy = toGameBotPatch('minecraft', { gb_minecraft_MC_MEMBER_IDS: 'claude', gb_minecraft_MC_USERNAME: 'Steve', chatroomSeats: SEATS })
  assert.equal(legacy.config.MC_MEMBER_IDS, 'claude')
  assert.equal(legacy.config.MC_USERNAME, 'Claude')
  const fromRoom = toGameBotPatch('minecraft', { chatroomSeats: SEATS, mcRoomSeatIds: ['grok'], gb_minecraft_MC_AGENTS: serializeAgents(agents) })
  assert.equal(fromRoom.config.MC_MEMBER_IDS, 'grok')
  assert.equal(fromRoom.config.MC_USERNAME, 'Grok')
})

test('npc names use display width, may repeat, and are not truncated', () => {
  assert.equal(nameError('六个汉字名称'), '')
  assert.match(nameError('七个汉字的名称'), /12/)
  const wide = normalizeAgent({ code: 'alpha', name: '七个汉字的名称' })
  assert.equal(wide.name, '七个汉字的名称')
  assert.equal(wide.nameOverLimit, true)
  const left = normalizeAgent({ code: 'alpha', name: 'Steve' })
  const right = normalizeAgent({ code: 'beta', name: 'Steve' })
  assert.equal(left.name, right.name)
  assert.equal('nameOverLimit' in left, false)
})
