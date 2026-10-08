// 「已连接」冒烟（Windows 实机）：用一个最小的 stdio MCP 客户端代替 dsh-mcp-client（照它的样子把工具注册成
// mcp__<server>__<tool>），按插件的启动方案真的拉起各 MCP 服务器，再走 createComponentManager().refreshConnections()
// 看 list() 里的 status / connection。
//
//   node scripts/connect-smoke.mjs [chrome chrome-url chrome-auto office blender unity figma photoshop godot]
//
//   chrome      launch 模式（无头 + 一次性配置目录）：先确认没开 Chrome 时是「已启动 / 程序未运行」且探测不会拉起 Chrome，
//               再像模型第一次用工具那样调 list_pages 让它启动 Chrome → 应为「已连接」；强制结束这个 Chrome → 回到「程序未运行」。
//   chrome-url  browserUrl 模式：自己起一个无头 Chrome（一次性配置目录 + 调试端口）→ 「已连接」；结束它 → 「程序未运行」。
//   chrome-auto autoConnect：若本机默认配置目录已有 DevToolsActivePort（用户已在 chrome://inspect 打开远程调试），
//               则挂上 --autoConnect 的 MCP，探测应为「已连接」；不动用户的 Chrome，不杀进程。没有 DevToolsActivePort 则跳过。
//   其余        只拉起服务器看当前真实状态（程序没开时应为「已启动 / 程序未运行」）。
//               godot：godot-ai attach 会顺带起一个共享后端（脱离的 pythonw），结束时一并结束 tools/godot 下的进程。
// 结束时关掉所有服务器、结束本脚本起的 Chrome、删掉临时配置目录。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, createComponentManager, killProcessesUnder, managedPaths } from '../lib/index.mjs'

const argv = process.argv.slice(2)
const ALL = ['chrome', 'chrome-url', 'chrome-auto', 'office', 'blender', 'unity', 'figma', 'photoshop', 'godot']
const ids = argv.filter((a) => ALL.includes(a))
const picked = ids.length ? ids : ALL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
function check(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed++ }

// ── 最小 MCP 客户端（代替 dsh-mcp-client）──
function fakeToolRuntime() {
  const map = new Map()
  return { map, get: (n) => map.get(n), view: () => ({ visible: map }), register(def) { map.set(def.name, def); return () => map.delete(def.name) } }
}

function mountServer(tools, config) {
  const child = spawn(config.command, config.args, { cwd: config.cwd || undefined, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  let nextId = 1
  let stderr = ''
  const pending = new Map()
  const names = []
  let exited = false
  child.on('exit', () => { exited = true; for (const p of pending.values()) p.reject(new Error('server exited')); pending.clear() })
  child.on('error', (e) => { stderr += String(e) })
  child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-10000) })
  child.stdout.setEncoding('utf8')
  const send = (msg) => { if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n') }
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.method && msg.id !== undefined) { send({ id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'not supported' } }) }); continue }
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  })
  const rpc = (method, params, signal) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    signal?.addEventListener('abort', () => { if (pending.delete(id)) { send({ method: 'notifications/cancelled', params: { requestId: id } }); reject(new Error('aborted')) } })
    send({ id, method, params })
  })
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'connect-smoke', version: '0' } })
    send({ method: 'notifications/initialized' })
    const list = await rpc('tools/list', {})
    for (const t of list.tools ?? []) {
      const name = `mcp__${config.serverName}__${t.name}`
      names.push(name)
      tools.register({
        name,
        async execute(args, exec) {
          const r = await rpc('tools/call', { name: t.name, arguments: args ?? {} }, exec?.signal)
          const text = (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          if (r.isError) throw new Error(text || 'isError')
          return { content: r.content ?? [], ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) }
        },
      })
    }
    return names.length
  })()
  ready.catch(() => {})
  return {
    ready, names, stderr: () => stderr,
    async dispose() {
      for (const n of names) tools.map.delete(n)
      if (exited) return
      // 先关 stdin 让服务器自己收尾（chrome-devtools-mcp 会关掉它启动的 Chrome），5 秒还没退再结束整棵进程树。
      const gone = new Promise((r) => child.once('exit', r))
      try { child.stdin.end() } catch {}
      const t = await Promise.race([gone.then(() => 'exit'), sleep(5000).then(() => 'timeout')])
      if (t === 'timeout') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch {} await Promise.race([gone, sleep(3000)]) }
    },
  }
}

function makeManager(cfgPatch) {
  const tools = fakeToolRuntime()
  const mounts = []
  const cfg = SettingsSchema({ officeEnabled: false, blenderEnabled: false, unityEnabled: false, figmaEnabled: false, photoshopEnabled: false, chromeEnabled: false, godotEnabled: false, ...cfgPatch })
  const ctx = {
    get: (n) => (n === 'loader' ? { import: async () => ({ name: 'connect-smoke-mcp-client' }) } : n === 'tools' ? tools : undefined),
    plugin: (_plugin, config) => { const m = mountServer(tools, config); mounts.push(m); return { dispose: () => { m.dispose() } } },
    logger: { warn: (...a) => console.warn('[warn]', ...a), info() {} },
  }
  const manager = createComponentManager(ctx, () => cfg)
  return {
    manager, tools, mounts, cfg,
    async close() { manager.dispose(); await Promise.all(mounts.map((m) => m.dispose())) },
  }
}

async function waitTools(env, id, ms = 90000) {
  const t0 = Date.now()
  const m = env.mounts[env.mounts.length - 1]
  if (!m) return 0
  const n = await Promise.race([m.ready, sleep(ms).then(() => -1)]).catch((e) => { console.log(`  ${id}: 服务器启动失败 ${e.message}\n  stderr: ${m.stderr().slice(-600)}`); return 0 })
  console.log(`  ${id}: ${n} 个工具（${((Date.now() - t0) / 1000).toFixed(1)} s）`)
  return n
}

async function state(env, id, force = true) {
  const t0 = Date.now()
  await env.manager.refreshConnections({ force })
  const c = (await env.manager.list()).find((x) => x.id === id)
  console.log(`  ${id}: status=${c.status} connection=${c.connection ? `${c.connection.state}｜${c.connection.detail}` : 'null'}（探测 ${Date.now() - t0} ms）`)
  return c
}

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')].find((p) => existsSync(p))

/** 结束命令行里带某个目录的 Chrome 进程（只动本脚本起的那些，按一次性配置目录匹配）。 */
function killChromeUsing(dir) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`
  try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).length } catch { return 0 }
}
function countChromeUsing(dir) {
  const ps = `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') }).Count`
  try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()) } catch { return -1 }
}
function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); return true } catch (e) { console.log(`  （没删掉临时目录 ${dir}：${e.code || e.message}）`); return false }
}
function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
}

const tmpDirs = []
try {
  if (picked.includes('chrome')) {
    console.log('\n== chrome（launch，无头，一次性配置目录）')
    const profile = mkdtempSync(join(tmpdir(), 'dsh-connect-chrome-'))
    tmpDirs.push(profile)
    const env = makeManager({ chromeEnabled: true, chromeHeadless: true, chromeUserDataDir: profile })
    try {
      await env.manager.sync()
      const n = await waitTools(env, 'chrome')
      check(n > 0, 'chrome-devtools-mcp started and registered tools')
      let c = await state(env, 'chrome')
      check(c.status === 'on' && c.connection?.state === 'no-app', 'own Chrome not running -> 已启动 + 程序未运行')
      await sleep(1500)
      check(countChromeUsing(profile) === 0, 'probe did not launch Chrome (no chrome.exe using the profile)')
      // 模型第一次用浏览器工具：Chrome 被 chrome-devtools-mcp 启动
      const r = await env.tools.get('mcp__chrome__list_pages').execute({}, { signal: AbortSignal.timeout(60000) })
      console.log('  (model) list_pages ->', r.content.map((b) => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 120))
      c = await state(env, 'chrome')
      check(c.status === 'connected' && c.connection?.state === 'connected' && c.connection.via === 'tool:list_pages', 'after Chrome launched -> 已连接')
      c = await state(env, 'chrome', false)
      check(c.status === 'connected', 'cached result within TTL still 已连接')
      const killed = killChromeUsing(profile)
      console.log(`  结束了 ${killed} 个 chrome.exe（本脚本的无头 Chrome）`)
      await sleep(2500)
      c = await state(env, 'chrome')
      check(c.status === 'on' && c.connection?.state === 'no-app', 'Chrome gone -> back to 已启动 + 程序未运行')
      await sleep(1500)
      check(countChromeUsing(profile) === 0, 'probe did not relaunch Chrome')
    } finally {
      await env.close()
      killChromeUsing(profile)
    }
  }

  if (picked.includes('chrome-url')) {
    console.log('\n== chrome（browserUrl，自己起一个无头 Chrome）')
    if (!CHROME) { console.log('  找不到 chrome.exe，跳过'); failed++ } else {
      const profile = mkdtempSync(join(tmpdir(), 'dsh-connect-chrome-url-'))
      tmpDirs.push(profile)
      const port = await freePort()
      const env = makeManager({ chromeEnabled: true, chromeConnect: 'browserUrl', chromeBrowserUrl: `http://127.0.0.1:${port}` })
      let chrome = null
      try {
        await env.manager.sync()
        const n = await waitTools(env, 'chrome')
        check(n > 0, 'chrome-devtools-mcp (browserUrl) registered tools')
        let c = await state(env, 'chrome')
        check(c.status === 'on' && c.connection?.state === 'no-app', 'debug port closed -> 已启动 + 程序未运行')
        chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true })
        for (let i = 0; i < 30; i++) { await sleep(500); try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break } catch {} }
        c = await state(env, 'chrome')
        check(c.status === 'connected' && /list_pages 成功/.test(c.connection?.detail || ''), 'debug port up -> 已连接')
        killChromeUsing(profile)
        await sleep(2500)
        c = await state(env, 'chrome')
        check(c.status === 'on' && c.connection?.state === 'no-app', 'Chrome closed -> 已启动 + 程序未运行')
      } finally {
        await env.close()
        killChromeUsing(profile)
      }
    }
  }

  if (picked.includes('chrome-auto')) {
    console.log('\n== chrome（autoConnect，连正在运行的 Chrome）')
    // 就地读默认配置目录的 DevToolsActivePort（不杀用户 Chrome）
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const dir = process.platform === 'win32'
      ? join(local, 'Google', 'Chrome', 'User Data')
      : join(home, '.config', 'google-chrome')
    let port = null
    try {
      const raw = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')
      const n = Number(String(raw).split(/\r?\n/)[0])
      if (n > 0 && n < 65536) port = n
    } catch {}
    const chromeRunning = (() => {
      try {
        if (process.platform === 'win32') {
          const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).trim()
          return Number(out) > 0
        }
        execFileSync('pgrep', ['-x', 'chrome'], { stdio: 'ignore' })
        return true
      } catch { return false }
    })()
    if (!port || !chromeRunning) {
      console.log(`  跳过：${!chromeRunning ? 'Chrome 没在运行' : dir + ' 没有 DevToolsActivePort'}（请先打开 Chrome，并在 chrome://inspect/#remote-debugging 打开远程调试）`)
    } else {
      console.log(`  发现 DevToolsActivePort 端口 ${port}（${dir}），Chrome 在运行`)
      const env = makeManager({ chromeEnabled: true, chromeConnect: 'autoConnect', chromeChannel: 'stable' })
      try {
        await env.manager.sync()
        const n = await waitTools(env, 'chrome')
        check(n > 0, 'chrome-devtools-mcp (autoConnect) registered tools')
        // 先确认探测认得出远程调试端口
        let c = await state(env, 'chrome')
        // 若还没「已连接」，像模型那样调一次 list_pages（会触发 Chrome「允许调试」弹窗；用户已允许过则会直接成功）
        if (c.connection?.state !== 'connected') {
          try {
            const r = await env.tools.get('mcp__chrome__list_pages').execute({}, { signal: AbortSignal.timeout(30000) })
            console.log('  (model) list_pages ->', (r.content || []).map((b) => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 120))
          } catch (e) {
            console.log('  (model) list_pages failed:', e.message)
          }
          c = await state(env, 'chrome')
        }
        check(c.status === 'connected' && c.connection?.state === 'connected', `autoConnect -> 已连接（${c.connection?.detail || c.status}）`)
        const launched = (await env.manager.list()).find((x) => x.id === 'chrome')
        check(/--autoConnect/.test(String(launched?.command || '')), 'mounted command includes --autoConnect: ' + String(launched?.command || '').slice(0, 180))
      } finally {
        await env.close()
        // 不杀用户的 Chrome
      }
    }
  }

  for (const id of ['office', 'blender', 'unity', 'figma', 'photoshop', 'godot']) {
    if (!picked.includes(id)) continue
    console.log(`\n== ${id}（真实服务器，当前机器状态）`)
    const env = makeManager({ [`${id}Enabled`]: true })
    try {
      await env.manager.sync()
      const first = (await env.manager.list()).find((x) => x.id === id)
      if (first.status !== 'on') { console.log(`  ${id}: 没有启动（${first.status}：${first.detail}），跳过`); continue }
      const n = await waitTools(env, id)
      check(n > 0, `${id} server registered tools`)
      const c = await state(env, id)
      check(['connected', 'on'].includes(c.status) && c.connection && c.connection.state !== 'checking', `${id}: probe finished (${c.status} / ${c.connection?.state})`)
      if (process.env.EXPECT && process.env.EXPECT.split(',').includes(`${id}=${c.connection?.state}`)) console.log(`  (EXPECT ${id}=${c.connection?.state} ok)`)
      else if (process.env.EXPECT && process.env.EXPECT.includes(`${id}=`)) check(false, `${id}: expected ${process.env.EXPECT}`)
    } finally {
      await env.close()
      if (id === 'godot') {
        const n = await killProcessesUnder(managedPaths().dir('godot'), (l) => console.log('  ' + l))
        console.log(`  godot: 结束了 ${n} 个 tools\\godot 下的进程（attach 起的共享后端）`)
      }
    }
  }
} finally {
  await sleep(1000)
  for (const d of tmpDirs) removeDir(d)
}
console.log(failed ? `\nconnect-smoke: ${failed} FAILED` : '\nconnect-smoke: ok')
process.exit(failed ? 1 : 0)
