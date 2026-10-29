import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMemberToken, gamebotChildEnv, memberToken } from './process.mjs'
import { memberIdsFor, seatMcPresence, createMcPresenceResolver } from './members.mjs'
import { createGamebotMembersFeature, createMembersTools } from './members-tools.mjs'
import { WORK_TOOLS } from './minecraft-work/tools.mjs'
import { bundledRoot } from './index.mjs'
import { minaretSourceDir } from './minaret.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'mc-members-'))

test('member token is created once and passed to the body env', () => {
  const state = tmp()
  try {
    const file = ensureMemberToken(state)
    const first = readFileSync(file, 'utf8').trim()
    assert.equal(memberToken(), first)
    assert.equal(ensureMemberToken(state), file)
    assert.equal(readFileSync(file, 'utf8').trim(), first)
    const env = gamebotChildEnv({ host: 'localhost', port: '8766', state, root: state })
    assert.equal(env.GAMEBOT_MEMBER_TOKEN_FILE, file)
    assert.match(env.GAMEBOT_CLAIM_KEY_FILE.replaceAll('\\', '/'), /minecraft-work\/claim\.key$/)
    assert.equal(env.GAMEBOT_HOST, '127.0.0.1')
    assert.equal(readFileSync(env.GAMEBOT_MEMBER_TOKEN_FILE, 'utf8').trim(), first)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('member roster is enabled seats intersected with enabled Minecraft AI rows', () => {
  const seats = [
    { id: 'claude', enabled: true },
    { id: 'gpt', enabled: false },
    { id: 'grok', enabled: true },
    { id: 'way-too-long-member-id-over-thirty-two', enabled: true },
  ]
  const agents = JSON.stringify([
    { code: 'claude', name: 'Claude', enabled: true },
    { code: 'grok', name: 'Grok', enabled: true },
    { code: 'deepseek', name: 'DS', enabled: false },
  ])
  assert.deepEqual(memberIdsFor({ chatroomSeats: seats, gb_minecraft_MC_AGENTS: agents }), ['claude', 'grok'])
  assert.deepEqual(
    memberIdsFor({ chatroomSeats: seats, gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'grok', name: 'Grok', enabled: true }]) }),
    ['grok'],
  )
  // MC_AGENTS 未保存时仍按旧 MC_MEMBER_IDS 迁移表
  assert.deepEqual(memberIdsFor({ chatroomSeats: seats, gb_minecraft_MC_MEMBER_IDS: 'grok, missing' }), ['grok'])
})

test('mc tools follow the caller and reject spoofed ids', async () => {
  const state = tmp()
  try {
    ensureMemberToken(state)
    const token = memberToken()
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, method: init.method || 'GET', token: init.headers['x-gamebot-member-token'], body: init.body })
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, connected: true }) } }
    }
    const cfg = {
      gamebotUrl: 'http://127.0.0.1:8766',
      chatroomSeats: [{ id: 'claude', enabled: true }, { id: 'gpt', enabled: false }, { id: 'grok', enabled: true }],
    }
    const tools = Object.fromEntries(createMembersTools({ getConfig: () => cfg, fetchImpl }).map((tool) => [tool.name, tool]))
    const claude = { game: { caller: { kind: 'ai', memberId: 'claude' } } }
    const grok = { game: { caller: { kind: 'ai', memberId: 'grok' } } }
    await tools.mc_connect.execute({}, claude)
    await tools.mc_status.execute({}, grok)
    assert.equal(seen[0].url, 'http://127.0.0.1:8766/v1/minecraft/members/claude/connect')
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].token, token)
    assert.equal(seen[1].url, 'http://127.0.0.1:8766/v1/minecraft/members/grok/status')
    await assert.rejects(() => tools.mc_observe.execute({}, {}), /仅限聊天室成员/)
    await assert.rejects(() => tools.mc_observe.execute({}, { game: { caller: { memberId: 'gpt' } } }), /没有启用/)
    await assert.rejects(() => tools.mc_act.execute({ action: 'look_at', agent_id: 'grok', params: { x: 1 } }, claude), /不能代其他成员/)
    await assert.rejects(() => tools.mc_act.execute({ action: 'run_command', params: { command: 'say hi' } }, claude), /不允许/)
    await tools.mc_act.execute({ action: 'look_at', params: { x: 1, y: 2, z: 3, member_id: 'claude' } }, claude)
    const sent = JSON.parse(seen.at(-1).body)
    assert.equal(sent.action, 'look_at')
    assert.equal(sent.params.member_id, undefined)
    assert.equal(sent.params.x, 1)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('members feature mounts only while Minecraft is enabled', async () => {
  let cfg = { 'gamebot-minecraftEnabled': false }
  let registered = []
  let disposed = 0
  const feature = createGamebotMembersFeature({
    plugin(def) {
      def.apply({
        inject(_names, fn) {
          fn({ tools: { register(tool) { registered.push(tool.name) } } })
        },
      })
      return { async dispose() { disposed += 1 } }
    },
  }, () => cfg)
  await feature.sync()
  assert.deepEqual(registered, [])
  cfg = { 'gamebot-minecraftEnabled': true }
  await feature.sync()
  assert.deepEqual(registered, ['mc_connect', 'mc_observe', 'mc_act', 'mc_cancel', 'mc_status', 'mc_disconnect', 'mc_takeover', 'mc_resume', ...WORK_TOOLS])
  await feature.sync()
  assert.equal(disposed, 0)
  cfg = { 'gamebot-minecraftEnabled': false }
  await feature.sync()
  assert.equal(disposed, 1)
  assert.equal(feature.state().mounted, false)
})

test('minaret source dir is the bundled bridge', () => {
  const src = minaretSourceDir(bundledRoot())
  assert.match(src.replaceAll('\\', '/'), /src\/components\/gamebot\/minecraft-neoforge-bridge$/)
  assert.equal(existsSync(join(src, 'src', 'main', 'java', 'com', 'trix', 'gamebot', 'bridge', 'transport', 'AgentBridgeServer.java')), true)
})


test('seatMcPresence is null when Minecraft is off', async () => {
  const info = await seatMcPresence({ 'gamebot-minecraftEnabled': false, chatroomSeats: [{ id: 'claude', enabled: true }], gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true }]) }, 'claude')
  assert.equal(info, null)
})

test('seatMcPresence reports ineligible seats without calling GameBot', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, async text() { return '{}' } } }
  const cfg = {
    'gamebot-minecraftEnabled': true,
    chatroomSeats: [{ id: 'claude', enabled: true }, { id: 'gpt', enabled: true }],
    gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true }]),
  }
  const info = await seatMcPresence(cfg, 'gpt', { fetchImpl })
  assert.equal(info.eligible, false)
  assert.match(info.lines[0], /not on the Minecraft AI roster/)
  assert.equal(calls, 0)
})

test('seatMcPresence surfaces connected status for eligible seats', async () => {
  const state = tmp()
  try {
    ensureMemberToken(state)
    const fetchImpl = async (url) => {
      assert.match(url, /\/members\/claude\/status$/)
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, connected: true, connecting: false, exists: true, last_error: null, username: 'ClaudeBot', agent_id: 'claude' }) } }
    }
    const cfg = {
      'gamebot-minecraftEnabled': true,
      gamebotUrl: 'http://127.0.0.1:8766',
      chatroomSeats: [{ id: 'claude', enabled: true }],
      gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true }]),
    }
    const info = await seatMcPresence(cfg, 'claude', { fetchImpl })
    assert.equal(info.eligible, true)
    assert.equal(info.connected, true)
    assert.match(info.lines[0], /Status: connected/)
    assert.match(info.lines[0], /ClaudeBot/)
    assert.match(info.lines[0], /Chatroom rounds do not drive the world/)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('createMcPresenceResolver caches and soft-fails', async () => {
  const state = tmp()
  try {
    ensureMemberToken(state)
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, connected: false, connecting: false, exists: true, last_error: 'bridge down' }) } }
    }
    let cfg = {
      'gamebot-minecraftEnabled': true,
      gamebotUrl: 'http://127.0.0.1:8766',
      chatroomSeats: [{ id: 'claude', enabled: true }],
      gb_minecraft_MC_AGENTS: JSON.stringify([{ code: 'claude', name: 'Claude', enabled: true }]),
    }
    const resolve = createMcPresenceResolver({ getConfig: () => cfg, fetchImpl, ttlMs: 60_000 })
    const a = await resolve({ id: 'claude' })
    const b = await resolve({ id: 'claude' })
    assert.equal(calls, 1)
    assert.equal(a.connected, false)
    assert.match(a.lines[0], /bridge down/)
    assert.equal(b, a)
    cfg = { 'gamebot-minecraftEnabled': false }
    assert.equal(await resolve({ id: 'claude' }), null)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

