import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARM_REASONS,
  DEFAULT_INTERVAL_MIN,
  HEARTBEAT_PROMPT_EMPTY,
  HEARTBEAT_TITLE,
  afterSecondsFromMinutes,
  buildHeartbeatPrompt,
  createHeartbeat,
  heartbeatSettings,
  isUnsuitableSessionId,
  listSessionsFromProjCache,
  titleFromSessionMeta,
} from './heartbeat.mjs'

test('heartbeatSettings: defaults off, 30 min, empty session', () => {
  assert.deepEqual(heartbeatSettings({}), { enabled: false, intervalMin: DEFAULT_INTERVAL_MIN, sessionId: '' })
  assert.equal(heartbeatSettings({ chatroomHeartbeatEnabled: true }).enabled, true)
  assert.equal(heartbeatSettings({ chatroomHeartbeatIntervalMin: 5 }).intervalMin, 5)
  assert.equal(heartbeatSettings({ chatroomHeartbeatIntervalMin: 0 }).intervalMin, DEFAULT_INTERVAL_MIN)
  assert.equal(heartbeatSettings({ chatroomHeartbeatIntervalMin: 99999 }).intervalMin, 1440)
  assert.equal(heartbeatSettings({ chatroomHeartbeatSessionId: '  sess-1  ' }).sessionId, 'sess-1')
})

test('afterSecondsFromMinutes and prompt', () => {
  assert.equal(afterSecondsFromMinutes(30), 1800)
  assert.equal(afterSecondsFromMinutes(1), 60)
  const p = buildHeartbeatPrompt({ roomTitle: '研发', reason: 'ended', intervalMin: 30 })
  // DSH rejects "" / whitespace-only; ZWSP is trimmed-stable and carries no instructional text.
  assert.equal(p, HEARTBEAT_PROMPT_EMPTY)
  assert.equal(p, '\u200b')
  assert.equal(p.trim(), p)
  assert.ok(p.length > 0)
  assert.ok(!/聊天室|房间|结束原因|分钟|请根据/.test(p))
  assert.ok(HEARTBEAT_TITLE.length <= 120)
  assert.ok(ARM_REASONS.has('done') && ARM_REASONS.has('ended'))
})

function mockSchedule() {
  const creates = []
  const deletes = []
  let n = 0
  return {
    creates,
    deletes,
    create: async (sessionId, request) => {
      creates.push({ sessionId, request })
      n += 1
      return { id: 'schedule-hb-' + n, ...request }
    },
    delete: async (req) => {
      deletes.push(req)
      return { id: req.id, deleted: true }
    },
  }
}

test('arm: disabled / no session / bad reason skip; done creates after_seconds', async () => {
  const schedule = mockSchedule()
  const cfg = { chatroomHeartbeatEnabled: false, chatroomHeartbeatIntervalMin: 30, chatroomHeartbeatSessionId: 's1' }
  const hb = createHeartbeat({
    ctx: { get: (n) => (n === 'schedule' ? schedule : null) },
    getConfig: () => cfg,
    getRoomTitle: () => '甲房',
  })
  assert.equal((await hb.arm('r1', 'done')).skipped, 'disabled')
  cfg.chatroomHeartbeatEnabled = true
  cfg.chatroomHeartbeatSessionId = ''
  assert.equal((await hb.arm('r1', 'done')).skipped, 'no-session')
  cfg.chatroomHeartbeatSessionId = 's1'
  assert.equal((await hb.arm('r1', 'stopped')).skipped, 'reason')
  const ok = await hb.arm('r1', 'done')
  assert.equal(ok.ok, true)
  assert.equal(ok.after_seconds, 1800)
  assert.equal(schedule.creates.length, 1)
  assert.equal(schedule.creates[0].sessionId, 's1')
  assert.equal(schedule.creates[0].request.title, HEARTBEAT_TITLE)
  assert.equal(schedule.creates[0].request.after_seconds, 1800)
  assert.equal(schedule.creates[0].request.prompt, HEARTBEAT_PROMPT_EMPTY)
  assert.equal(hb.status()?.id, 'schedule-hb-1')
})

test('onRunEvent: running true disarms; false done arms; activity recreates via delete+create', async () => {
  const schedule = mockSchedule()
  const cfg = { chatroomHeartbeatEnabled: true, chatroomHeartbeatIntervalMin: 2, chatroomHeartbeatSessionId: 'target' }
  const hb = createHeartbeat({
    ctx: { get: (n) => (n === 'schedule' ? schedule : null) },
    getConfig: () => cfg,
  })
  hb.onRunEvent('room-a', { type: 'run', running: false, reason: 'ended' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(schedule.creates.length, 1)
  assert.equal(schedule.creates[0].request.after_seconds, 120)
  const firstId = hb.status().id
  hb.onRunEvent('room-a', { type: 'run', running: true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(schedule.deletes.length, 1)
  assert.equal(schedule.deletes[0].id, firstId)
  assert.equal(hb.status(), null)
  hb.onRunEvent('room-a', { type: 'run', running: false, reason: 'done' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(schedule.creates.length, 2)
  assert.ok(hb.status()?.id)
  // 再次 ended：先 delete 再 create（after 不可 update）
  const second = hb.status().id
  hb.onRunEvent('room-b', { type: 'run', running: false, reason: 'ended' })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(schedule.deletes.some((d) => d.id === second))
  assert.equal(schedule.creates.length, 3)
})

test('titleFromSessionMeta: prefers title projection over sessionListMetadata', () => {
  const proj = {
    stateOf: (s, key) => {
      if (key === 'title') return s.id === 'a' ? '  主会话  ' : null
      if (key === 'sessionListMetadata') return { blank: false, lastPromptAt: null, title: '应忽略' }
      return null
    },
  }
  assert.equal(titleFromSessionMeta(proj, { id: 'a' }), '主会话')
  assert.equal(titleFromSessionMeta(proj, { id: 'b' }), '')
  assert.equal(isUnsuitableSessionId('cron-exec-cron_x-1'), true)
  assert.equal(isUnsuitableSessionId('session-abc'), false)
})

test('listSessionsFromProjCache: titles from rows.title, skip blank/cron/empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsw-hb-pc-'))
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const write = (id, rows) => writeFileSync(join(dir, id + '.json'), JSON.stringify({ version: 7, record: { rows } }))
  write('session-good', { title: { val: '大肥鱼' }, sessionListMetadata: { val: { blank: false } } })
  write('session-blank', { title: { val: '空白' }, sessionListMetadata: { val: { blank: true } } })
  write('session-empty', { title: { val: '  ' }, sessionListMetadata: { val: { blank: false } } })
  write('cron-exec-cron_x-1', { title: { val: '定时' }, sessionListMetadata: { val: { blank: false } } })
  write('room-1', { title: { val: '聊天室：中转站' }, sessionListMetadata: { val: { blank: false } } })
  write('named', { name: { val: '仅名称' }, sessionListMetadata: { val: { blank: false } } })
  try {
    assert.deepEqual(listSessionsFromProjCache(home).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: 'named', title: '仅名称', chatroom: false },
      { id: 'room-1', title: '聊天室：中转站', chatroom: true },
      { id: 'session-good', title: '大肥鱼', chatroom: false },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('listSessions: merges projcache titles with live title projection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsw-hb-live-'))
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cold-1.json'), JSON.stringify({
    version: 7,
    record: { rows: { title: { val: '冷会话甲' }, sessionListMetadata: { val: { blank: false } } } },
  }))
  writeFileSync(join(dir, 'a.json'), JSON.stringify({
    version: 7,
    record: { rows: { title: { val: '缓存旧名' }, sessionListMetadata: { val: { blank: false } } } },
  }))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const live = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'cron-exec-x' }]
    const hb = createHeartbeat({
      ctx: {
        get: (n) => {
          if (n === 'sessions') return { list: () => live }
          if (n === 'sessionProjections') return {
            stateOf: (s, key) => {
              if (key === 'title') {
                if (s.id === 'a') return '主会话'
                if (s.id === 'c') return '聊天室：研发'
                return null
              }
              if (key === 'sessionListMetadata') return { blank: false, lastPromptAt: null }
              return null
            },
          }
          return null
        },
      },
      getConfig: () => ({}),
    })
    const got = await hb.listSessions()
    assert.deepEqual(got.slice().sort((a, b) => a.id.localeCompare(b.id)), [
      { id: 'a', title: '主会话', chatroom: false },
      { id: 'b', title: 'b', chatroom: false },
      { id: 'c', title: '聊天室：研发', chatroom: true },
      { id: 'cold-1', title: '冷会话甲', chatroom: false },
    ])
    // live title projection must win over projcache stale title for id a
    assert.equal(got.find((s) => s.id === 'a')?.title, '主会话')
    assert.equal(got.find((s) => s.id === 'cold-1')?.title, '冷会话甲')
    assert.ok(!got.some((s) => String(s.id).startsWith('cron-exec-')))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
