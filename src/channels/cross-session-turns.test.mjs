import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSessionLog } from '../session-controls/zstd-log.mjs'
import {
  CAPS,
  DEFAULT_CONFIG,
  sessionTurns,
  TOOL_NAMES,
  TURNS_NAME,
} from './cross-session-memory.mjs'
import { createCrossSessionTools } from './cross-session-tools.mjs'
import { OPEN_TOOLS } from './telegram/owner-gate.mjs'

const QQ_OWNER = 'B4C6E62A8A0919E62678494F20F30530'
const TG_OWNER = '6153059771'

function bindings() {
  return {
    [`telegram:main:${TG_OWNER}`]: {
      channelId: 'telegram', accountId: 'main', conversationId: TG_OWNER,
      conversationType: 'dm', senderId: TG_OWNER,
      sessionId: 'ch-tg-dm', durability: 'durable',
      route: { preset: 'lingsnow' }, schemaVersion: 3, updatedAt: 300,
    },
    [`qq:main:${QQ_OWNER}`]: {
      channelId: 'qq', accountId: 'main', conversationId: QQ_OWNER,
      conversationType: 'dm', senderId: QQ_OWNER,
      sessionId: 'ch-qq-dm', durability: 'durable',
      route: { preset: 'lingsnow' }, schemaVersion: 3, updatedAt: 200,
    },
  }
}

test('TOOL_NAMES and OPEN_TOOLS include cross_session_turns', () => {
  assert.ok(TOOL_NAMES.includes(TURNS_NAME))
  assert.ok(OPEN_TOOLS.has('cross_session_turns'))
  const tools = createCrossSessionTools({
    getConfig: () => ({}),
    getGate: () => null,
    loadBindingsFn: () => ({}),
  })
  assert.ok(tools.some((t) => t.name === 'cross_session_turns'))
})

test('sessionTurns: count only vs window of 10 around turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csm-turns-'))
  const sessDir = join(dir, 'tg')
  await mkdir(sessDir, { recursive: true })
  const events = []
  for (let i = 1; i <= 25; i++) {
    const role = i % 2 ? 'user' : 'assistant'
    events.push({
      type: role === 'user' ? 'user/message' : 'assistant/message',
      seq: i,
      time: 1_700_000_000_000 + i,
      data: role === 'user'
        ? { content: [{ type: 'text', text: 'm' + i }], role: 'user' }
        : { message: { role: 'assistant', content: [{ type: 'text', text: 'm' + i }] } },
    })
  }
  writeSessionLog(join(sessDir, 'session.v4.jsonl.zstd'), {
    type: 'session', version: 4, id: 'ch-tg-dm', agentPreset: 'lingsnow',
  }, events)

  const findSessionLogPath = (id) => (id === 'ch-tg-dm' ? join(sessDir, 'session.v4.jsonl.zstd') : null)
  const ctx = {
    bindings: bindings(),
    config: DEFAULT_CONFIG,
    callerSessionId: 'ch-qq-dm',
    findSessionLogPath,
  }

  try {
    const count = sessionTurns({ sessionId: 'ch-tg-dm' }, ctx)
    assert.equal(count.error, false)
    assert.equal(count.turnCount, 25)
    assert.match(count.text, /has 25 turn/)

    const win = sessionTurns({ sessionId: 'ch-tg-dm', turn: 12 }, ctx)
    assert.equal(win.error, false)
    assert.equal(win.turnCount, 25)
    assert.equal(win.focus, 12)
    assert.equal(win.turns.length, CAPS.turnsWindow)
    assert.equal(win.from, 8)
    assert.equal(win.to, 17)
    assert.match(win.text, /> #12 /)
    assert.match(win.text, /#8 /)
    assert.match(win.text, /#17 /)

    const edge = sessionTurns({ sessionId: 'ch-tg-dm', turn: 2 }, ctx)
    assert.equal(edge.from, 1)
    assert.equal(edge.turns.length, 10)

    const refuse = sessionTurns({ sessionId: 'ch-qq-dm' }, ctx)
    assert.equal(refuse.error, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})