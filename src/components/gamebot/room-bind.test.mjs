import test from 'node:test'
import assert from 'node:assert/strict'
import { planRoomSync, parseAgents, serializeAgents } from './agents.mjs'
import { createMinecraftRoomBinding, roomSyncWanted, ROOM_KEY } from './room-bind.mjs'

const SEATS = [
  { id: 'claude', name: 'Claude', provider: 'anthropic', model: 'claude-x', preset: 'p1', persona: '简洁', enabled: true },
  { id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt-x', enabled: false },
  { id: 'Bad_Id', name: 'Bad', enabled: true },
]

test('planRoomSync imports unknown members, warns on invalid ids, adds enabled MC AIs missing from the room', () => {
  const agents = parseAgents(serializeAgents([
    { code: 'claude', name: 'Claude MC' },
    { code: 'steve', name: 'Steve', provider: 'xai', model: 'grok-x', preset: 'p2', persona: '友好' },
    { code: 'off', name: 'Off', enabled: false },
    { code: 'gone', name: 'Gone', removed: true },
  ]))
  const seats = structuredClone(SEATS)
  const before = JSON.stringify(seats)
  const plan = planRoomSync(agents, seats)
  assert.deepEqual(plan.importRows.map((r) => [r.code, r.enabled, r.model]), [['gpt', false, 'gpt-x']])
  assert.deepEqual(plan.invalid, [{ id: 'Bad_Id', name: 'Bad' }])
  assert.deepEqual(plan.addSeats, [{ id: 'steve', name: 'Steve', provider: 'xai', model: 'grok-x', preset: 'p2', reasoningEffort: '', persona: '友好', enabled: true }])
  assert.equal(JSON.stringify(seats), before)
  const again = planRoomSync([...agents, ...plan.importRows], [...seats, ...plan.addSeats])
  assert.deepEqual([again.importRows.length, again.addSeats.length], [0, 0])
})

function harness(cfg, rooms = []) {
  const state = { cfg, rooms: [...rooms], patches: [], sessions: [], members: {} }
  const binding = createMinecraftRoomBinding({
    getConfig: () => state.cfg,
    store: {
      listRooms: async () => state.rooms,
      createRoom: async ({ title }) => { const r = { id: `room-${state.rooms.length + 1}`, title }; state.rooms.push(r); return r },
    },
    ensureSession: async (id) => { state.sessions.push(id) },
    applyPatch: async (patch) => { state.patches.push(patch); state.cfg = { ...state.cfg, ...patch } },
    normalizeSeats: (list) => list.map((s) => ({ ...s, id: String(s.id).toLowerCase() })),
    ensureRoomMembers: async (id, opts = {}) => {
      let ids = state.members[id]
      if (!ids) ids = (state.cfg.chatroomSeats || []).map((s) => s.id)
      if (Array.isArray(opts.addIds)) {
        for (const x of opts.addIds) if (!ids.includes(x)) ids = [...ids, x]
      }
      state.members[id] = ids
      const room = state.rooms.find((r) => r.id === id)
      if (room) room.memberSeatIds = ids
      return ids
    },
    now: () => 1,
  })
  return { state, binding }
}

test('no bound room: creates 「Minecraft」, migrates MC-only rows into the seat pool, snapshots room members', async () => {
  const { state, binding } = harness({ chatroomSeats: [], gb_minecraft_MC_AGENTS: serializeAgents([{ code: 'steve', name: 'Steve' }, { code: 'gone', removed: true }]) })
  const r = await binding.sync('save')
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.roomTitle, 'Minecraft')
  assert.equal(state.cfg[ROOM_KEY], 'room-1')
  assert.deepEqual(state.cfg.chatroomSeats.map((s) => s.id), ['steve'])
  assert.deepEqual(r.added, ['steve'])
  assert.deepEqual(state.members['room-1'], ['steve'])
  assert.deepEqual(state.sessions, ['room-1'])
  const n = state.patches.length
  const r2 = await binding.sync('launch')
  assert.equal(r2.created, false)
  assert.deepEqual([r2.added, r2.imported], [[], []])
  assert.equal(state.patches.length, n)
  assert.equal(state.rooms.length, 1)
})

test('bound room lost: creates a replacement and does not rewrite MC_AGENTS; existing seats stay in the pool', async () => {
  const { state, binding } = harness({ chatroomSeats: SEATS, gb_minecraft_MC_AGENTS: '[]', [ROOM_KEY]: 'r-old' }, [{ id: 'r-main', title: '主房间' }])
  const r = await binding.sync('save')
  assert.equal(r.lost, true)
  assert.equal(r.created, true)
  assert.deepEqual(r.imported, [])
  assert.equal(state.cfg.gb_minecraft_MC_AGENTS, '[]')
  assert.equal(state.cfg.chatroomSeats, SEATS)
  assert.ok(state.members[r.roomId]?.includes('claude'))
  state.cfg = { ...state.cfg, [ROOM_KEY]: 'r-main' }
  const r2 = await binding.sync('save')
  assert.equal(r2.created, false)
  assert.equal(r2.roomTitle, '主房间')
  assert.deepEqual(r2.imported, [])
})

test('sync errors are reported, not thrown; roomSyncWanted only on MC save or enabling MC', async () => {
  const binding = createMinecraftRoomBinding({ getConfig: () => ({}), store: { listRooms: async () => [], createRoom: async () => { throw new Error('磁盘已满') } }, applyPatch: async () => {}, normalizeSeats: (x) => x })
  const r = await binding.sync()
  assert.equal(r.ok, false)
  assert.match(r.error, /同步聊天室失败：磁盘已满/)
  assert.equal(roomSyncWanted({ gb_minecraft_MC_AGENTS: '[]' }, {}), true)
  assert.equal(roomSyncWanted({ [ROOM_KEY]: '' }, {}), true)
  assert.equal(roomSyncWanted({ 'gamebot-minecraftEnabled': true }, { 'gamebot-minecraftEnabled': true }), true)
  assert.equal(roomSyncWanted({ 'gamebot-minecraftEnabled': false }, {}), false)
  assert.equal(roomSyncWanted({ notesEnabled: true }, {}), false)
})
