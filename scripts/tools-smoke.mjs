// 工具安装冒烟：走插件同一套安装代码（createComponentManager().install，和设置页「下载安装」一样），
// 把 uv / OfficeMCP / Blender MCP / Unity MCP / Figma / Photoshop / Chrome / Godot / FFmpeg（kinocut）/ Obsidian 装进插件的 tools/
// （可用 DSH_WORKBENCH_TOOLS_DIR 指到别处），然后按启动方案拉起各 MCP 服务器，走一遍 initialize + tools/list，
// 再调几个不依赖外部软件的工具（Chrome：无头 + 临时配置目录打开 example.com 取快照 / 截图；Godot：只读的
// session_manage(list) / editor_state，没开 Godot 时后者报「没有会话」属于预期）。
// --uninstall：最后再走设置页「卸载」同一套代码（manager.uninstall）删掉这些组件，确认 tools/<id> 已删除。
//
//   node scripts/tools-smoke.mjs [uv node office blender unity figma photoshop chrome godot ffmpeg obsidian] [--skip-install] [--uninstall] [--proxy http://127.0.0.1:7890]
//   node 不在默认列表里：系统里已有带 npm 的 Node.js 时用不到 tools/node；要测下载 Node.js 就显式写上 node。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, componentById, createComponentManager, dirSize, killProcessesUnder, managedPaths } from '../lib/index.mjs'

const argv = process.argv.slice(2)
const proxyAt = argv.indexOf('--proxy')
const proxy = proxyAt >= 0 ? argv[proxyAt + 1] : ''
const skipInstall = argv.includes('--skip-install')
const uninstallAfter = argv.includes('--uninstall')
const KNOWN = ['uv', 'node', 'office', 'blender', 'unity', 'figma', 'photoshop', 'chrome', 'godot', 'ffmpeg', 'obsidian']
const ALL = KNOWN.filter((id) => id !== 'node')
const PROBE = ['blender', 'unity', 'figma', 'photoshop', 'chrome', 'godot', 'ffmpeg', 'obsidian']
const picked = argv.filter((a, i) => KNOWN.includes(a) && argv[i - 1] !== '--proxy')
const ids = picked.length ? picked : ALL

// Chrome 只用无头 + 一次性的配置目录，不碰用户平时的 Chrome。
const chromeProfile = mkdtempSync(join(tmpdir(), 'dsh-workbench-chrome-'))
const cfg = SettingsSchema({
  proxy,
  figmaEnabled: true,
  photoshopEnabled: true,
  chromeEnabled: true,
  chromeHeadless: true,
  chromeUserDataDir: chromeProfile,
  godotEnabled: true,
  ffmpegEnabled: true,
  // smoke 用占位密钥；真实探测连库仍需本机 Obsidian + Local REST API
  obsidianEnabled: true,
  obsidianApiKey: 'smoke-placeholder',
})
const fakeLoader = { import: async () => ({ name: 'fake-dsh-mcp-client' }) }
const ctx = {
  get: (n) => (n === 'loader' ? fakeLoader : undefined),
  plugin: () => ({ dispose() {} }),
  logger: { warn: (...a) => console.warn('[warn]', ...a), info() {} },
}
const manager = createComponentManager(ctx, () => cfg)
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
const secs = (ms) => (ms / 1000).toFixed(1) + ' s'

async function printList(title) {
  console.log(`\n== ${title}`)
  for (const c of await manager.list()) console.log(`  ${c.id.padEnd(9)} installed=${c.installed} status=${c.status} source=${c.source} | ${c.detail}${c.command ? `\n            cmd: ${c.command}` : ''}`)
}

await manager.sync()
await printList('安装前')
console.log('tools:', managedPaths().root, proxy ? `proxy=${proxy}` : '(无代理设置)')

const results = []
const seen = new Map()
if (!skipInstall) {
  for (const id of ids) {
    console.log(`\n== 安装 ${id}`)
    const t0 = Date.now()
    const { done } = await manager.install(id)
    let lastStep = ''
    const tick = async () => {
      for (const c of await manager.list()) {
        const log = manager.installLog(c.id)
        let n = seen.get(c.id) ?? 0
        if (n > log.length) n = 0
        for (const line of log.slice(n)) console.log(`  [${c.id}] ${line}`)
        seen.set(c.id, log.length)
        if (c.id === id && c.install.step !== lastStep) {
          lastStep = c.install.step
          if (!/^下载.*MB$/.test(lastStep)) console.log(`  [${c.id}] 步骤：${lastStep}`)
        }
      }
    }
    const timer = setInterval(() => { void tick() }, 500)
    await done
    clearInterval(timer)
    tick()
    const job = (await manager.list()).find((c) => c.id === id)
    const ms = Date.now() - t0
    console.log(`  => ${id}: ${job.install.state}${job.install.error ? ' ' + job.install.error : ''}，用时 ${secs(ms)}`)
    results.push({ id, state: job.install.state, ms })
  }
}

await printList('安装后（组件已自动重挂）')

const m = managedPaths()
console.log('\n== tools 目录大小')
for (const [name, p] of [['uv', join(m.root, 'uv')], ['python', m.python], ['.uv-cache', m.cache], ['officemcp', m.officeRepo], ['blender', m.dir('blender')], ['unity', m.dir('unity')],
  ['node', m.node], ['figma', m.dir('figma')], ['photoshop', m.dir('photoshop')], ['chrome', m.dir('chrome')], ['godot', m.dir('godot')], ['ffmpeg', m.dir('ffmpeg')], ['obsidian', m.dir('obsidian')], ['(合计)', m.root]]) {
  console.log(`  ${name.padEnd(10)} ${mb(dirSize(p))}`)
}

// 各组件探测时额外调用的工具（page 2 是 new_page 打开的新标签页）。
const CALLS = {
  chrome: [
    ['list_pages', {}],
    ['new_page', { url: 'https://example.com' }],
    ['take_snapshot', { pageId: 2 }],
    ['evaluate_script', { pageId: 2, function: '() => document.title' }],
    ['take_screenshot', { pageId: 2 }],
    ['close_page', { pageId: 2 }],
  ],
  figma: [['figma_get_status', {}]],
  photoshop: [['photoshop_ping', {}]],
  // 都是只读的：session_manage 只查服务器自己的会话表；没开 Godot 时 editor_state 报没有会话。
  godot: [['session_manage', { op: 'list', params: {} }], ['editor_state', {}]],
}

function summarize(result) {
  if (!result) return ''
  return (result.content ?? []).map((c) => c.type === 'text' ? c.text.replace(/\s+/g, ' ').slice(0, 160) : `[${c.type} ${c.mimeType ?? ''} ${c.data ? Math.round(c.data.length * 3 / 4 / 1024) + ' KB' : ''}]`).join(' | ')
}

async function probe(id) {
  return new Promise((resolve) => {
    const plan = componentById(id).launch(cfg)
    if (!plan.ok) return resolve({ id, ok: false, error: plan.reason })
    if (plan.config.transport !== 'stdio') return resolve({ id, ok: false, error: `不是 stdio：${plan.config.url}` })
    const { command, args, env, cwd } = plan.config
    console.log(`\n== 启动 ${id}（${plan.source}${plan.runtime ? '，' + plan.runtime : ''}）：${command} ${args.join(' ')}`)
    const t0 = Date.now()
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buf = ''
    let stderr = ''
    let finished = false
    let exited = false
    child.once('exit', () => { exited = true })
    // 先关 stdin 让服务器自己收尾（Chrome 随之退出、释放临时配置目录），5 秒还没退再强杀。
    const finish = (r) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const result = { id, ms: Date.now() - t0, ...r }
      if (exited) return resolve(result)
      const kill = setTimeout(() => child.kill(), 5000)
      child.once('exit', () => { clearTimeout(kill); resolve(result) })
      try { child.stdin.end() } catch { child.kill() }
    }
    const timer = setTimeout(() => finish({ ok: false, error: '120 秒内没有完成', stderr: stderr.slice(-800) }), 120000)
    if (id === 'godot') console.log(`  env: ${JSON.stringify(env)}`)
    child.on('error', (e) => finish({ ok: false, error: e.message }))
    child.on('exit', (code) => finish({ ok: false, error: `进程提前退出 ${code}`, stderr: stderr.slice(-800) }))
    child.stderr.on('data', (c) => { stderr += c })
    child.stdout.setEncoding('utf8')
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    let serverInfo = null
    let tools = []
    const calls = CALLS[id] ?? []
    const callResults = []
    const nextCall = () => {
      const i = callResults.length
      if (i >= calls.length) return finish({ ok: true, serverInfo, tools, calls: callResults })
      callResults.push({ name: calls[i][0], args: calls[i][1], t0: Date.now() })
      send({ id: 100 + i, method: 'tools/call', params: { name: calls[i][0], arguments: calls[i][1] } })
    }
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: JSON.stringify(msg.error) })
          serverInfo = msg.result.serverInfo
          send({ method: 'notifications/initialized' })
          send({ id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2) {
          tools = msg.result?.tools?.map((t) => t.name) ?? []
          nextCall()
        } else if (msg.id >= 100) {
          const r = callResults[msg.id - 100]
          r.ms = Date.now() - r.t0
          r.error = msg.error ? JSON.stringify(msg.error) : null
          r.isError = !!msg.result?.isError
          r.summary = summarize(msg.result)
          nextCall()
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tools-smoke', version: '0' } } })
  })
}

let failed = results.some((r) => r.state !== 'done')
if (ids.includes('godot')) {
  try {
    const mk = JSON.parse(readFileSync(join(m.dir('godot'), '.dsh-install.json'), 'utf8'))
    console.log(`\n== godot 安装记录：godot-ai ${mk.version}，插件包 ${mk.addon ? `${mk.addon.version}（${mk.addon.files} 个文件，sha256 ${mk.addon.sha256.slice(0, 12)}…，签名已校验）` : '没有下载'}`)
    const note = (await manager.list()).find((c) => c.id === 'godot').note
    console.log(`  note: ${note}`)
    if (!mk.addon || mk.addon.version !== mk.version) failed = true
  } catch (e) { console.log(`  （读不到 tools/godot 的安装记录：${e.message}）`); failed = true }
}
const probeIds = picked.length ? PROBE.filter((id) => picked.includes(id)) : PROBE
for (const id of probeIds) {
  const r = await probe(id)
  if (r.ok) {
    console.log(`  ${id}: ${JSON.stringify(r.serverInfo)}，${r.tools.length} 个工具，用时 ${secs(r.ms)}\n  tools: ${r.tools.join(', ')}`)
    for (const c of r.calls ?? []) console.log(`  call ${c.name} ${JSON.stringify(c.args)} → ${c.error ? 'ERROR ' + c.error : c.isError ? 'isError' : 'ok'}（${c.ms} ms）${c.summary ? '：' + c.summary : ''}`)
    // Chrome 能跑就应该全部成功；Figma / Photoshop 没开对应软件时工具报错属于预期。
    if (id === 'chrome' && (r.calls ?? []).some((c) => c.error || c.isError)) failed = true
    // Godot：session_manage 必须成功（没开 Godot 时会话数为 0）。
    if (id === 'godot' && !(r.calls?.[0] && !r.calls[0].error && !r.calls[0].isError && /"count"\s*:\s*0|"sessions"\s*:\s*\[\]/.test(r.calls[0].summary))) failed = true
  } else { failed = true; console.log(`  ${id}: 失败 ${r.error}${r.stderr ? '\n  stderr: ' + r.stderr : ''}`) }
  // godot-ai attach 会起一个脱离的共享后端（pythonw，空闲约 2 分钟自己退出）；测试完直接结束，不留进程。
  if (id === 'godot') {
    const n = await killProcessesUnder(m.dir('godot'), (l) => console.log('  ' + l))
    console.log(`  godot: 结束了 ${n} 个 tools\\godot 下的进程`)
  }
}

// Godot「安装插件到项目」：在临时目录里造一个假项目走一遍（新装 → 同版本不动 → 换版本先备份），外加两种拒绝。
if (ids.includes('godot') && existsSync(join(m.dir('godot'), 'addon'))) {
  console.log('\n== godot 安装插件到项目（临时假项目）')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-godot-proj-'))
  const expect = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true }
  try {
    const proj = join(tmp, 'MyGame')
    mkdirSync(proj)
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="MyGame"\n')
    const r1 = await manager.installAddon('godot', proj)
    expect(r1.action === 'installed' && existsSync(join(proj, 'addons', 'godot_ai', 'plugin.cfg')), `新装：${r1.message}`)
    const r2 = await manager.installAddon('godot', join(proj, 'project.godot'))
    expect(r2.action === 'same', `同版本：${r2.message}`)
    const cfgPath = join(proj, 'addons', 'godot_ai', 'plugin.cfg')
    writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/version="[^"]*"/, 'version="4.0.0"'))
    const r3 = await manager.installAddon('godot', proj)
    const backups = existsSync(join(proj, 'addons', '.godot_ai_backup')) ? readdirSync(join(proj, 'addons', '.godot_ai_backup')) : []
    expect(r3.action === 'replaced' && r3.previous === '4.0.0' && backups.some((n) => n.startsWith('4.0.0-')) && backups.includes('.gdignore'), `换版本：${r3.message}（备份 ${backups.join(', ')}）`)
    expect(readdirSync(join(proj, 'addons')).every((n) => !n.startsWith('.godot_ai_dsh_stage')), '没有残留的临时目录')
    for (const [bad, why] of [[tmp, '没有 project.godot 的文件夹'], ['relative\\path', '相对路径'], ['', '空路径']]) {
      try { await manager.installAddon('godot', bad); expect(false, `${why} 应该被拒绝`) } catch (e) { expect(e.status === 400, `${why} 被拒绝（${e.status}）：${e.message}`) }
    }
  } catch (e) { expect(false, `异常：${e.stack || e.message}`) } finally { rmSync(tmp, { recursive: true, force: true }) }
}
if (uninstallAfter) {
  for (const id of ids) {
    const dir = id === 'office' ? m.officeRepo : id === 'uv' ? join(m.root, 'uv') : id === 'node' ? m.node : m.dir(id)
    const t0 = Date.now()
    try {
      const c = await manager.uninstall(id)
      const gone = !existsSync(dir)
      console.log(`\n== 卸载 ${id}：${gone ? '已删除' : '还在'} ${dir}，installed=${c.installed} status=${c.status}（${secs(Date.now() - t0)}）`)
      if (!gone) failed = true
    } catch (e) { console.log(`\n== 卸载 ${id} 失败：${e.message}`); failed = true }
  }
}
manager.dispose()
try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 }) } catch (e) { console.log(`  （临时 Chrome 配置目录没删掉：${chromeProfile}，${e.code || e.message}）`) }
console.log(failed ? '\ntools-smoke: FAILED' : '\ntools-smoke: ok')
process.exit(failed ? 1 : 0)
