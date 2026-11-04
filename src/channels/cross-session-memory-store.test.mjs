import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTaggedMessage,
  buildInjectBlock,
  latestCompaction,
  parseMemoryJsonl,
  presetMemoryPath,
  readPresetMemory,
  replaceCompaction,
  STORE_CAPS,
} from './cross-session-memory-store.mjs'
import {
  injectForChannel,
  injectForChatroomSeat,
  isMasterMemoryEnabled,
  isPresetMemoryEnabled,
  memoryPresetsOf,
  setMemoryWriteRuntime,
  writeChatroomMemoryMessage,
} from './cross-session-memory-write.mjs'

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'csm-store-'))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('appendTaggedMessage writes scene/speaker/time JSONL lines', async () => {
  await withHome(async (home) => {
    const a = await appendTaggedMessage('lingsnow', {
      scene: { sessionId: 'ch-a', channel: 'telegram', peerId: '1', conversationType: 'dm' },
      speaker: 'Shiro',
      role: 'user',
      text: 'hello from tg',
      time: 1000,
      home,
    })
    const b = await appendTaggedMessage('lingsnow', {
      scene: { sessionId: 'ch-b', channel: 'qq', peerId: '2', conversationType: 'dm' },
      speaker: 'lingsnow',
      role: 'assistant',
      text: 'hi from qq',
      time: 2000,
      home,
    })
    assert.equal(a.type, 'message')
    assert.equal(b.scene.channel, 'qq')
    const entries = readPresetMemory('lingsnow', { home })
    assert.equal(entries.length, 2)
    assert.match(entries[0].speaker, /Shiro/)
    const raw = await readFile(presetMemoryPath('lingsnow', home), 'utf8')
    assert.equal(parseMemoryJsonl(raw).length, 2)
  })
})

test('buildInjectBlock excludes current session and caps tokens', async () => {
  await withHome(async (home) => {
    for (let i = 0; i < 5; i++) {
      await appendTaggedMessage('lingsnow', {
        scene: { sessionId: 'ch-other', channel: 'telegram', peerId: 'x', conversationType: 'dm' },
        speaker: 'u',
        role: 'user',
        text: `other-${i} ` + 'word '.repeat(20),
        time: 1000 + i,
        home,
      })
    }
    await appendTaggedMessage('lingsnow', {
      scene: { sessionId: 'ch-current', channel: 'qq', peerId: 'y', conversationType: 'dm' },
      speaker: 'u',
      role: 'user',
      text: 'must not appear in inject',
      time: 9000,
      home,
    })
    const { text, tokens, tailCount } = buildInjectBlock({
      preset: 'lingsnow',
      excludeSessionId: 'ch-current',
      maxTokens: STORE_CAPS.injectMaxTokens,
      home,
    })
    assert.ok(text.includes('[cross-session-memory'))
    assert.ok(text.includes('other-'))
    assert.ok(!text.includes('must not appear in inject'))
    assert.ok(tokens <= STORE_CAPS.injectMaxTokens)
    assert.ok(tailCount >= 1)
  })
})

test('replaceCompaction keeps one compaction and drops prior', async () => {
  await withHome(async (home) => {
    await appendTaggedMessage('lingsnow', {
      scene: { sessionId: 'ch-a', channel: 'telegram', peerId: '1', conversationType: 'dm' },
      speaker: 'u', role: 'user', text: 'm1', time: 100, home,
    })
    await replaceCompaction('lingsnow', { text: 'first summary', coversUntil: 100, time: 150 }, { home })
    await appendTaggedMessage('lingsnow', {
      scene: { sessionId: 'ch-b', channel: 'qq', peerId: '2', conversationType: 'dm' },
      speaker: 'u', role: 'user', text: 'm2', time: 200, home,
    })
    await replaceCompaction('lingsnow', { text: 'second summary', coversUntil: 200, time: 250 }, { home })
    const entries = readPresetMemory('lingsnow', { home })
    const comps = entries.filter((e) => e.type === 'compaction')
    assert.equal(comps.length, 1)
    assert.equal(latestCompaction(entries).text, 'second summary')
    const { text } = buildInjectBlock({
      preset: 'lingsnow',
      excludeSessionId: 'ch-b',
      home,
    })
    assert.ok(text.includes('second summary'))
    assert.ok(!text.includes('first summary'))
  })
})

test('gates: master + seat preset flags', () => {
  assert.equal(isMasterMemoryEnabled({ crossSessionMemoryEnabled: false }), false)
  assert.equal(isMasterMemoryEnabled({ crossSessionMemoryEnabled: true }), true)
  const cfg = {
    crossSessionMemoryEnabled: true,
    chatroomSeats: [
      { id: 's1', preset: 'lingsnow', crossSessionMemoryEnabled: true },
      { id: 's2', preset: 'chatgpt', crossSessionMemoryEnabled: false },
    ],
  }
  const presets = memoryPresetsOf(cfg)
  assert.ok(presets.includes('lingsnow'))
  assert.ok(!presets.includes('chatgpt'))
  assert.equal(isPresetMemoryEnabled(cfg, 'lingsnow'), true)
  assert.equal(isPresetMemoryEnabled(cfg, 'chatgpt'), false)
})

test('writeChatroomMemoryMessage + injectForChatroomSeat exclude room', async () => {
  await withHome(async (home) => {
    setMemoryWriteRuntime({
      getConfig: () => ({
        crossSessionMemoryEnabled: true,
        chatroomSeats: [
          { id: 'seat-a', name: '雪', preset: 'lingsnow', crossSessionMemoryEnabled: true },
        ],
      }),
      home,
      log: console,
      compacting: new Set(),
    })
    try {
      await writeChatroomMemoryMessage({
        roomId: 'room-other',
        roomName: 'Other',
        msg: { kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: 'from other room', time: '2026-01-01T00:00:00.000Z' },
        seats: [{ id: 'seat-a', name: '雪', preset: 'lingsnow', crossSessionMemoryEnabled: true }],
      })
      await writeChatroomMemoryMessage({
        roomId: 'room-here',
        roomName: 'Here',
        msg: { kind: 'seat', speaker: { id: 'seat-a', name: '雪' }, text: 'local seat reply', time: '2026-01-01T00:01:00.000Z' },
        seats: [{ id: 'seat-a', name: '雪', preset: 'lingsnow', crossSessionMemoryEnabled: true }],
      })
      const inject = injectForChatroomSeat({
        seat: { id: 'seat-a', preset: 'lingsnow', crossSessionMemoryEnabled: true },
        roomId: 'room-here',
      })
      assert.ok(inject.includes('from other room'))
      assert.ok(!inject.includes('local seat reply'))
      const channelInject = injectForChannel({ preset: 'lingsnow', sessionId: 'none' })
      assert.ok(channelInject.includes('from other room') || channelInject.includes('local seat'))
    } finally {
      setMemoryWriteRuntime(null)
    }
  })
})
