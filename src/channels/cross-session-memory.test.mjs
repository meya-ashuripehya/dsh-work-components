import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSessionLog } from '../session-controls/zstd-log.mjs'
import {
  CAPS,
  DEFAULT_CONFIG,
  extractEventText,
  listPeers,
  loadBindings,
  normalizeConfig,
  personGroupOf,
  resolvePeers,
  searchPeers,
  stripHarnessPrefix,
  TOOL_NAMES,
} from './cross-session-memory.mjs'
import { createCrossSessionTools } from './cross-session-tools.mjs'
import { createOwnerGate, OPEN_TOOLS } from './telegram/owner-gate.mjs'
import {
  buildPersonSummary,
  extractNamesFromMessages,
  parseAliasMap,
  resolveDisplayName,
} from './person-profile.mjs'
import { enrichInboundEvent } from './person-memory-inject.mjs'

const QQ_OWNER = 'B4C6E62A8A0919E62678494F20F30530'
const TG_OWNER = '6153059771'

function fixtureBindings() {
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
    'telegram:main:-1003435238151': {
      channelId: 'telegram', accountId: 'main', conversationId: '-1003435238151',
      conversationType: 'group', senderId: TG_OWNER,
      sessionId: 'ch-tg-group', durability: 'durable',
      route: { preset: 'lingsnow' }, schemaVersion: 3, updatedAt: 400,
    },
    'telegram:main:-1003435238151:40': {
      channelId: 'telegram', accountId: 'main', conversationId: '-1003435238151',
      conversationType: 'group', threadId: '40', senderId: TG_OWNER,
      sessionId: 'ch-tg-thread', durability: 'durable',
      route: { preset: 'lingsnow' }, schemaVersion: 3, updatedAt: 350,
    },
    [`telegram:chatgpt:${TG_OWNER}`]: {
      channelId: 'telegram', accountId: 'chatgpt', conversationId: TG_OWNER,
      conversationType: 'dm', senderId: TG_OWNER,
      sessionId: 'ch-tg-chatgpt', durability: 'durable',
      route: { preset: 'chatgpt' }, schemaVersion: 3, updatedAt: 500,
    },
  }
}

test('personGroupOf maps dm/group', () => {
  assert.equal(personGroupOf('dm'), 'person')
  assert.equal(personGroupOf('group'), 'group')
})

test('stripHarnessPrefix redacts message tokens and marks owner', () => {
  const raw = `[channel=qq sender=${QQ_OWNER} message=ROBOT1.0_AbqCWqR8Dy7Cgo3Dk.rICh.f-qAd9R8c4K] hello`
  const out = stripHarnessPrefix(raw, { ownerIds: [QQ_OWNER] })
  assert.match(out, /\[channel=qq sender=owner\]/)
  assert.doesNotMatch(out, /ROBOT1\.0_/)
  assert.match(out, /hello/)
})

test('user decision: all channel sessions queryable incl. groups; chatgpt excluded by preset', () => {
  const bindings = fixtureBindings()
  const r = resolvePeers({
    bindings,
    config: DEFAULT_CONFIG,
    callerSessionId: 'ch-qq-dm',
  })
  assert.equal(r.ok, true)
  const ids = r.peers.map((p) => p.sessionId).sort()
  assert.deepEqual(ids, ['ch-tg-dm', 'ch-tg-group', 'ch-tg-thread'].sort())
  assert.ok(!ids.includes('ch-tg-chatgpt'))
  assert.ok(!ids.includes('ch-qq-dm'))
  const group = r.peers.find((p) => p.sessionId === 'ch-tg-group')
  assert.equal(group.personGroup, 'group')
  assert.equal(group.peerId, '-1003435238151')
  const dm = r.peers.find((p) => p.sessionId === 'ch-tg-dm')
  assert.equal(dm.personGroup, 'person')
  assert.equal(dm.peerId, TG_OWNER)
})

test('filters: channel / conversationType / peerId', () => {
  const bindings = fixtureBindings()
  const byChannel = resolvePeers({
    bindings, config: DEFAULT_CONFIG, callerSessionId: 'ch-qq-dm',
    filters: { channel: 'telegram', conversationType: 'group' },
  })
  assert.deepEqual(byChannel.peers.map((p) => p.sessionId).sort(), ['ch-tg-group', 'ch-tg-thread'].sort())

  const byPeer = resolvePeers({
    bindings, config: DEFAULT_CONFIG, callerSessionId: 'ch-tg-dm',
    filters: { peerId: QQ_OWNER },
  })
  assert.equal(byPeer.peers.length, 1)
  assert.equal(byPeer.peers[0].sessionId, 'ch-qq-dm')
  assert.equal(byPeer.peers[0].personGroup, 'person')
})

test('shareGroups false drops groups (override)', () => {
  const cfg = normalizeConfig({
    enabled: true,
    ownerLinks: [{ ...DEFAULT_CONFIG.ownerLinks[0], shareGroups: false }],
  })
  const r = resolvePeers({
    bindings: fixtureBindings(),
    config: cfg,
    callerSessionId: 'ch-qq-dm',
  })
  assert.deepEqual(r.peers.map((p) => p.sessionId), ['ch-tg-dm'])
})

test('listPeers labels person vs group and peer id', () => {
  const out = listPeers({ limit: 20 }, {
    bindings: fixtureBindings(),
    config: DEFAULT_CONFIG,
    callerSessionId: 'ch-qq-dm',
  })
  assert.equal(out.error, false)
  assert.match(out.text, /telegram · group · peer=-1003435238151/)
  assert.match(out.text, /telegram · person · peer=6153059771/)
  assert.ok(out.peers.every((p) => p.personGroup === 'person' || p.personGroup === 'group'))
  assert.ok(out.peers.every((p) => p.peerId))
})

test('searchPeers finds across channels with labels; strips tokens; skips reasoning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xsm-'))
  const sessions = {
    'ch-tg-dm': join(dir, 'tg'),
    'ch-tg-group': join(dir, 'grp'),
  }
  await mkdir(sessions['ch-tg-dm'], { recursive: true })
  await mkdir(sessions['ch-tg-group'], { recursive: true })

  const header = { type: 'session', version: 4, id: 'x', agentPreset: 'lingsnow' }
  writeSessionLog(join(sessions['ch-tg-dm'], 'session.v4.jsonl.zstd'), { ...header, id: 'ch-tg-dm' }, [
    {
      type: 'user/message', seq: 1, time: 1_700_000_000_000,
      data: {
        content: [{ type: 'text', text: `[channel=telegram sender=${TG_OWNER} message=ROBOT1.0_SecretTokenABCDEFGH] 行程安排去上海` }],
        role: 'user',
      },
    },
    {
      type: 'assistant/message', seq: 2, time: 1_700_000_000_100,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'secret thoughts about 行程' },
            { type: 'text', text: '好的，上海行程记下了' },
          ],
        },
      },
    },
  ])
  writeSessionLog(join(sessions['ch-tg-group'], 'session.v4.jsonl.zstd'), { ...header, id: 'ch-tg-group' }, [
    {
      type: 'user/message', seq: 1, time: 1_700_000_001_000,
      data: {
        content: [{ type: 'text', text: `[channel=telegram sender=${TG_OWNER} message=ROBOT1.0_GroupTokXXXXXXXX] 群里说行程改期` }],
        role: 'user',
      },
    },
  ])

  const findSessionLogPath = (id) => {
    const d = sessions[id]
    return d ? join(d, 'session.v4.jsonl.zstd') : null
  }

  try {
    const out = searchPeers({ query: '行程', limit: 10 }, {
      bindings: fixtureBindings(),
      config: DEFAULT_CONFIG,
      callerSessionId: 'ch-qq-dm',
      findSessionLogPath,
    })
    assert.equal(out.error, false)
    assert.match(out.text, /Peers searched/)
    assert.match(out.text, /telegram person(?: name=\S+)? peer=6153059771/)
    assert.match(out.text, /telegram group peer=-1003435238151/)
    assert.match(out.text, /上海/)
    assert.match(out.text, /改期/)
    assert.doesNotMatch(out.text, /ROBOT1\.0_/)
    assert.doesNotMatch(out.text, /secret thoughts/)

    const onlyGroup = searchPeers({
      query: '行程', conversationType: 'group', limit: 5,
    }, {
      bindings: fixtureBindings(),
      config: DEFAULT_CONFIG,
      callerSessionId: 'ch-qq-dm',
      findSessionLogPath,
    })
    assert.match(onlyGroup.text, /group peer=-1003435238151/)
    assert.doesNotMatch(onlyGroup.text, /person peer=6153059771/)

    const refuseSelf = searchPeers({ sessionId: 'ch-qq-dm', query: 'x' }, {
      bindings: fixtureBindings(),
      config: DEFAULT_CONFIG,
      callerSessionId: 'ch-qq-dm',
      findSessionLogPath,
    })
    assert.equal(refuseSelf.error, true)
    assert.match(refuseSelf.text, /Refuse/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractEventText skips reasoning by default', () => {
  const ev = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'nope' }, { type: 'text', text: 'yes' }] } },
  }
  assert.equal(extractEventText(ev).text, 'yes')
  assert.match(extractEventText(ev, { includeReasoning: true }).text, /nope/)
})

test('OPEN_TOOLS includes cross_session_* names after registration side-effect import of owner-gate patch', () => {
  // Names are added in owner-gate; this test asserts the expected contract for channel agents.
  for (const n of TOOL_NAMES) {
    assert.equal(typeof n, 'string')
  }
  assert.ok(OPEN_TOOLS.has('cross_session_list'), 'cross_session_list must be in OPEN_TOOLS')
  assert.ok(OPEN_TOOLS.has('cross_session_search'), 'cross_session_search must be in OPEN_TOOLS')
})

test('owner-turn gate: non-owner denied inside tool even though OPEN_TOOLS', async () => {
  const gate = createOwnerGate({ authorized: [TG_OWNER] })
  gate.noteTurn('ch-tg-group', '999999') // non-owner
  const tools = createCrossSessionTools({
    getGate: () => gate,
    getConfig: () => DEFAULT_CONFIG,
    loadBindingsFn: () => fixtureBindings(),
  })
  const list = tools.find((t) => t.name === 'cross_session_list')
  const r = await list.execute({ limit: 5 }, { agent: { id: 'ch-tg-group' } })
  assert.match(r.text, /owner-authorized/)

  // owner turn OK
  const gate2 = createOwnerGate({ authorized: [TG_OWNER] })
  gate2.noteTurn('ch-tg-dm', TG_OWNER)
  const tools2 = createCrossSessionTools({
    getGate: () => gate2,
    getConfig: () => DEFAULT_CONFIG,
    loadBindingsFn: () => fixtureBindings(),
  })
  const list2 = tools2.find((t) => t.name === 'cross_session_list')
  const ok = await list2.execute({ limit: 5 }, { agent: { id: 'ch-tg-dm' } })
  assert.equal(ok.error, false)
  assert.match(ok.text, /Peers you may read/)
})

test('call budget max 3 per turn', async () => {
  const gate = createOwnerGate({ authorized: [TG_OWNER] })
  gate.noteTurn('ch-tg-dm', TG_OWNER)
  const tools = createCrossSessionTools({
    getGate: () => gate,
    getConfig: () => DEFAULT_CONFIG,
    loadBindingsFn: () => fixtureBindings(),
  })
  const list = tools.find((t) => t.name === 'cross_session_list')
  for (let i = 0; i < CAPS.maxCallsPerTurn; i++) {
    const r = await list.execute({}, { agent: { id: 'ch-tg-dm' } })
    assert.equal(r.error, false)
  }
  const blocked = await list.execute({}, { agent: { id: 'ch-tg-dm' } })
  assert.match(blocked.text, /budget/)
})

test('chatgpt caller cannot use circle', () => {
  const r = resolvePeers({
    bindings: fixtureBindings(),
    config: DEFAULT_CONFIG,
    callerSessionId: 'ch-tg-chatgpt',
  })
  assert.equal(r.ok, false)
})

test('loadBindings returns object for missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bind-'))
  try {
    assert.deepEqual(loadBindings(join(dir, 'nope.json')), {})
    await writeFile(join(dir, 'b.json'), '{"a":1}', 'utf8')
    assert.equal(loadBindings(join(dir, 'b.json')).a, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('parseAliasMap line + json forms', () => {
  const rows = parseAliasMap(`
# comment
telegram 6153059771 Shiro
qq B4C6E62A8A0919E62678494F20F30530 雪
telegram -1003435238151 家庭群 group
telegram:999=AliasNine
{"channel":"telegram","peerId":"111","name":"壹"}
`)
  assert.equal(rows.length, 5)
  assert.equal(rows[0].name, 'Shiro')
  assert.equal(rows[2].conversationType, 'group')
  assert.equal(rows[3].peerId, '999')
  assert.equal(rows[4].name, '壹')
})

test('resolveDisplayName priority: manual > learned > live > raw', () => {
  const aliases = parseAliasMap('telegram 6153059771 ManualName')
  assert.equal(resolveDisplayName({
    channel: 'telegram', peerId: '6153059771',
    aliases, learned: { 'telegram:6153059771': 'Learned' }, liveName: 'Live',
  }), 'ManualName')
  assert.equal(resolveDisplayName({
    channel: 'telegram', peerId: '6153059771',
    aliases: [], learned: { 'telegram:6153059771': 'Learned' }, liveName: 'Live',
  }), 'Learned')
  assert.equal(resolveDisplayName({
    channel: 'telegram', peerId: '6153059771',
    aliases: [], learned: {}, liveName: 'Live',
  }), 'Live')
  assert.equal(resolveDisplayName({
    channel: 'telegram', peerId: '6153059771',
    aliases: [], learned: {}, liveName: '',
  }), '6153059771')
})

test('listPeers shows manual alias name', () => {
  const out = listPeers({ limit: 20 }, {
    bindings: fixtureBindings(),
    config: {
      ...DEFAULT_CONFIG,
      aliases: parseAliasMap('telegram 6153059771 Shiro'),
      skipLearned: true,
      learned: {},
    },
    callerSessionId: 'ch-qq-dm',
  })
  assert.equal(out.error, false)
  assert.match(out.text, /name=Shiro/)
  const dm = out.peers.find((p) => p.sessionId === 'ch-tg-dm')
  assert.equal(dm.displayName, 'Shiro')
})

test('buildPersonSummary capped and includes name', () => {
  const s = buildPersonSummary({
    channel: 'telegram',
    peerId: '6153059771',
    conversationType: 'dm',
    senderId: '6153059771',
    liveName: 'Shiro',
    aliases: [],
    learned: {},
    link: DEFAULT_CONFIG.ownerLinks[0],
  })
  assert.match(s, /\[person-memory\]/)
  assert.match(s, /name=Shiro/)
  assert.match(s, /role=owner/)
  assert.ok(s.length <= 420)
})

test('extractNamesFromMessages reads person-memory and name= prefix', () => {
  const map = extractNamesFromMessages([
    { text: '[person-memory] channel=telegram kind=person peer=6153059771 name=Shiro | x' },
    { text: '[channel=qq sender=B4C6E62A8A0919E62678494F20F30530 name=雪 message=1] hi' },
  ])
  assert.equal(map.get('telegram:6153059771'), 'Shiro')
  assert.equal(map.get('qq:B4C6E62A8A0919E62678494F20F30530'), '雪')
})

test('enrichInboundEvent prepends person-memory and keeps body', () => {
  const event = {
    channel: 'telegram',
    conversation: { id: '6153059771', type: 'dm' },
    sender: { id: '6153059771', name: 'Shiro' },
    message: { id: '1', content: [{ type: 'text', text: 'hello' }] },
  }
  const out = enrichInboundEvent(event, {
    aliases: [],
    link: DEFAULT_CONFIG.ownerLinks[0],
    learnedFile: join(tmpdir(), 'dsh-learned-missing.json'),
  })
  assert.equal(out.message.content[0].type, 'text')
  assert.match(out.message.content[0].text, /\[person-memory\]/)
  assert.match(out.message.content[0].text, /name=Shiro/)
  assert.equal(out.message.content[1].text, 'hello')
})
