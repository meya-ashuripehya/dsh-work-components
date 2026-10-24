// DeepSlate 组件：默认关闭、目录校验、启动配置；聊天室对所有人开放，gamebot / mc 场景限制不受影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import deepslate, { checkCheckout, deepslateEnv, meta } from './index.mjs'
import { isOpenTool, isOwnerOnlyTool } from '../../channels/telegram/owner-gate.mjs'
import { denyReason, allowedNames } from '../../chatroom/tool-gate.mjs'
import { isCatalogExcluded } from '../../chatroom/tool-selector.mjs'
import { clampRenderSize, DEEPSLATE_ROOM_MAX_PX } from '../../chatroom/chatroom-tools.mjs'

const node = () => ({ path: 'C:\\node\\node.exe', version: 'v22.12.0', env: {} })

async function fakeCheckout(build = true) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-deepslate-'))
  await mkdir(join(dir, 'bin')); await writeFile(join(dir, 'bin', 'deepslate-mcp.js'), '')
  if (build) { await mkdir(join(dir, 'dist')); await writeFile(join(dir, 'dist', 'server.js'), '') }
  return dir
}

test('meta: 工作组件 group, default off (no launch), no hardcoded user path', () => {
  assert.equal(meta.group, '工作组件')
  const off = deepslate.launch({ deepslateEnabled: false, deepslatePath: 'C:\\x' })
  assert.equal(off.ok, false); assert.match(off.reason, /停用/)
  assert.equal(off.config, undefined)
  assert.equal(deepslate.installed({}), false)
})

test('path validation: empty / relative / missing / not a checkout / not built', async () => {
  assert.match(checkCheckout('').reason, /未设置/)
  assert.match(checkCheckout('rel\\dir').reason, /绝对路径/)
  assert.match(checkCheckout(join(tmpdir(), 'nope-' + Date.now())).reason, /不存在/)
  const bare = await mkdtemp(join(tmpdir(), 'dsh-ds-bare-'))
  const unbuilt = await fakeCheckout(false)
  try {
    assert.match(checkCheckout(bare).reason, /bin\\deepslate-mcp\.js/)
    assert.match(checkCheckout(unbuilt).reason, /dist\\server\.js/)
  } finally { await rm(bare, { recursive: true, force: true }); await rm(unbuilt, { recursive: true, force: true }) }
})

test('launch: runs node on the local checkout entry with only the user-set env', async () => {
  const dir = await fakeCheckout()
  try {
    const r = deepslate.launch({ deepslateEnabled: true, deepslatePath: '"' + dir + '"', deepslateJarPath: 'D:\\mc\\client.jar' }, { resolveNode: node })
    assert.equal(r.ok, true)
    assert.equal(r.config.serverName, 'deepslate')
    assert.equal(r.config.command, 'C:\\node\\node.exe')
    assert.deepEqual(r.config.args, [join(dir, 'bin', 'deepslate-mcp.js')])
    assert.equal(r.config.env.DEEPSLATE_JAR_PATH, 'D:\\mc\\client.jar')
    assert.equal('DEEPSLATE_CACHE_DIR' in r.config.env, false)
    assert.deepEqual(deepslateEnv({}), {})
    const nn = deepslate.launch({ deepslateEnabled: true, deepslatePath: dir }, { resolveNode: () => null })
    assert.equal(nn.ok, false); assert.match(nn.reason, /Node\.js/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('chat room: deepslate tools open to everyone; gamebot / mc and windows gates intact', () => {
  for (const n of ['mcp__deepslate__render_structure', 'mcp__deepslate__render_blocks', 'mcp__deepslate__inspect_structure', 'mcp__deepslate__render_item']) {
    assert.equal(isOpenTool(n), true, n)
    assert.equal(isCatalogExcluded(n), false, n)
    assert.equal(denyReason(n, { owner: false, inToolset: true }), null, n)
  }
  assert.ok(allowedNames(['mcp__deepslate__render_structure'], false).includes('mcp__deepslate__render_structure'))
  assert.equal(isCatalogExcluded('mcp__gamebot-minecraft__gamebot_connect'), true)
  assert.notEqual(denyReason('mcp__gamebot-minecraft__gamebot_connect', { owner: true, inToolset: true }), null)
  assert.equal(isOpenTool('mcp__windows__PowerShell'), false)
  assert.equal(isOwnerOnlyTool('mcp__deepslate__render_structure'), false)
})

test('chat room render size cap', () => {
  assert.deepEqual(clampRenderSize({ width: 4096, height: 900, angle: 'top' }), { width: DEEPSLATE_ROOM_MAX_PX, height: 900, angle: 'top' })
  assert.deepEqual(clampRenderSize({}), {})
})
test('install: copies an existing built checkout into tools/deepslate (source kept, .git/~/test scripts skipped); used when path empty', async () => {
  const { installFromLocal, effectivePath, managedDir } = await import('./index.mjs')
  const { existsSync } = await import('node:fs')
  const home = await mkdtemp(join(tmpdir(), 'dsh-ds-home-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-ds-tools-'))
  try {
    const src = join(home, 'Desktop', 'deepslate-mcp')
    await mkdir(join(src, 'bin'), { recursive: true }); await writeFile(join(src, 'bin', 'deepslate-mcp.js'), '')
    await mkdir(join(src, 'dist')); await writeFile(join(src, 'dist', 'server.js'), '')
    await mkdir(join(src, 'node_modules', 'gl'), { recursive: true }); await writeFile(join(src, 'node_modules', 'gl', 'index.js'), '')
    await mkdir(join(src, '.git')); await writeFile(join(src, '.git', 'HEAD'), '')
    await mkdir(join(src, '~')); await writeFile(join(src, 'render-test.mjs'), '')
    const logs = []; let replaced = 0
    const r = await installFromLocal({}, { log: (t) => logs.push(t), step: () => {} }, { beforeReplace: async () => { replaced++ } }, { root, home })
    const dest = managedDir(root)
    assert.equal(r.dir, dest); assert.equal(r.from, src); assert.equal(replaced, 1)
    assert.ok(existsSync(join(dest, 'dist', 'server.js')) && existsSync(join(dest, 'node_modules', 'gl', 'index.js')))
    assert.ok(!existsSync(join(dest, '.git')) && !existsSync(join(dest, '~')) && !existsSync(join(dest, 'render-test.mjs')))
    assert.ok(existsSync(join(src, 'dist', 'server.js')), 'source kept')
    assert.equal(effectivePath({}, { root }), dest)
    assert.equal(effectivePath({ deepslatePath: 'D:\\x' }, { root }), 'D:\\x')
    const l = deepslate.launch({ deepslateEnabled: true }, { resolveNode: node, root })
    assert.equal(l.ok, true); assert.deepEqual(l.config.args, [join(dest, 'bin', 'deepslate-mcp.js')])
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})

test('install: clear Chinese error when no local checkout exists', async () => {
  const { installFromLocal } = await import('./index.mjs')
  const home = await mkdtemp(join(tmpdir(), 'dsh-ds-empty-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-ds-tools2-'))
  try {
    await assert.rejects(installFromLocal({}, {}, {}, { root, home }), /未找到本机已编译的 deepslate-mcp.*npm run build/)
    assert.equal(typeof deepslate.install, 'function')
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
})