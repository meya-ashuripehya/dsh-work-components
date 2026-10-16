// 0.4.1：聊天室所有者 ID 与 cursor-agent 路径不再有内置的个人默认值；随包代码里不得出现个人信息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { DEFAULT_OWNER_TELEGRAM_ID, DEFAULT_CURSOR_AGENT } from './seats.mjs'
import { resolveCursorAgent, runCursorAgent } from './cursor.mjs'
import { createChatroomFeature } from './index.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const PERSONAL = /6153059771|10917|S:\\{1,2}TRIX|S:\/TRIX|(?<!meya-)ashuripehya|\bShiro\b/i
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.md', '.py', '.lua', '.xml', '.toml', '.cs', '.modinfo'])

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'bin', 'obj', 'dist', '__pycache__', '.venv'].includes(e.name)) continue
      yield* walk(p)
    } else if (TEXT_EXT.has(extname(e.name)) && !/\.test\.(mjs|js|py)$/.test(e.name) && !/^test_/.test(e.name)) yield p
  }
}

test('no built-in owner Telegram ID or personal cursor-agent path', () => {
  assert.equal(DEFAULT_OWNER_TELEGRAM_ID, '')
  assert.equal(DEFAULT_CURSOR_AGENT, '')
})

test('shipped sources, client, README, patch and scripts carry no personal values', async () => {
  const files = []
  for await (const f of walk(join(root, 'src'))) files.push(f)
  for await (const f of walk(join(root, 'scripts'))) files.push(f)
  for (const f of ['lib/client.js', 'README.md', 'cordis.patch.yml', 'package.json']) files.push(join(root, f))
  if (existsSync(join(root, 'lib'))) for (const e of await readdir(join(root, 'lib'))) if (/\.(mjs|js)$/.test(e) && e !== 'client.js') files.push(join(root, 'lib', e))
  const hits = []
  for (const f of files) {
    if ((await stat(f)).size > 8 * 1024 * 1024) continue
    const lines = (await readFile(f, 'utf8')).split(/\r?\n/)
    lines.forEach((l, i) => { if (PERSONAL.test(l)) hits.push(`${f.slice(root.length + 1)}:${i + 1}`) })
  }
  assert.deepEqual(hits, [])
})

test('resolveCursorAgent: setting wins; absolute but missing path is a Chinese error', () => {
  assert.deepEqual(resolveCursorAgent('cursor-agent', { exists: () => false }), { path: 'cursor-agent', source: 'setting', error: '' })
  assert.deepEqual(resolveCursorAgent('"D:\\tools\\cursor-agent.cmd"', { platform: 'win32', exists: (f) => f === 'D:\\tools\\cursor-agent.cmd' }), { path: 'D:\\tools\\cursor-agent.cmd', source: 'setting', error: '' })
  const miss = resolveCursorAgent('D:\\nope\\cursor-agent.cmd', { platform: 'win32', exists: () => false })
  assert.equal(miss.path, '')
  assert.match(miss.error, /未找到 cursor-agent：设置的路径不存在/)
})

test('resolveCursorAgent: empty setting searches PATH, then known locations, else Chinese error', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\someone' }
  const onPath = resolveCursorAgent('', { ...win, env: { Path: 'C:\\a;"D:\\cli"' }, exists: (f) => f === 'D:\\cli\\cursor-agent.cmd' })
  assert.deepEqual(onPath, { path: 'D:\\cli\\cursor-agent.cmd', source: 'PATH', error: '' })
  const known = resolveCursorAgent('', { ...win, env: { PATH: '', LOCALAPPDATA: 'E:\\Local' }, exists: (f) => f === 'E:\\Local\\cursor-agent\\cursor-agent.cmd' })
  assert.deepEqual(known, { path: 'E:\\Local\\cursor-agent\\cursor-agent.cmd', source: 'known', error: '' })
  const posix = resolveCursorAgent('', { platform: 'linux', home: '/home/u', env: { PATH: '/usr/bin' }, exists: (f) => f === '/home/u/.local/bin/cursor-agent' })
  assert.deepEqual(posix, { path: '/home/u/.local/bin/cursor-agent', source: 'known', error: '' })
  const none = resolveCursorAgent('', { ...win, env: { PATH: 'C:\\a' }, exists: () => false })
  assert.equal(none.path, '')
  assert.match(none.error, /^未找到 cursor-agent：请安装 Cursor CLI/)
})

test('runCursorAgent refuses a missing configured agent without spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-041-'))
  try {
    let spawned = false
    const missing = process.platform === 'win32' ? 'Z:\\no-such-dir\\cursor-agent.cmd' : '/no-such-dir/cursor-agent'
    const res = await runCursorAgent({ agentPath: missing, handoff: { action: 'brief', title: 't', repo: dir, brief: 'do something useful', resume: '' }, spawnImpl: () => { spawned = true; throw new Error('must not spawn') } })
    assert.equal(spawned, false)
    assert.equal(res.ok, false)
    assert.equal(res.status, 'error')
    assert.match(res.error, /未找到 cursor-agent/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('empty owner: Telegram owner-only group commands are refused for every sender', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-041-'))
  const cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '', chatroomSeats: [] }
  const feat = createChatroomFeature(null, () => cfg, { dir, llm: null, presets: null })
  const replies = []
  feat.bots.reply = async (chatId, text) => { replies.push([chatId, text]); return true }
  try {
    const room = await feat.store.createRoom({ title: '圆桌' })
    for (const fromId of ['123456789', '6153059771', '']) {
      assert.deepEqual(await feat.groupCommand({ cmd: 'bind', arg: '', chatId: '-1001001', title: '测试群', fromId }), { ignored: true })
    }
    assert.deepEqual((await feat.store.getRoom(room.id)).telegramChatIds || [], [])
    assert.equal(replies.length, 0)
  } finally { await feat.dispose(); await rm(dir, { recursive: true, force: true }) }
})
