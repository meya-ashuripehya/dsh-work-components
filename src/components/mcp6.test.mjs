import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fusion, { probe as fusionProbe, DEFAULT_URL as FUSION_URL } from './fusion/index.mjs'
import freecad, { planFor as freecadPlan, probe as freecadProbe } from './freecad/index.mjs'
import matlab, { planFor as matlabPlan } from './matlab/index.mjs'
import espidf, { planFor as espidfPlan } from './espidf/index.mjs'
import serial, { planFor as serialPlan } from './serial/index.mjs'
import rhino, { planFor as rhinoPlan, probe as rhinoProbe } from './rhino/index.mjs'
import altium, { planFor as altiumPlan, probe as altiumProbe } from './altium/index.mjs'
import { splitCommand } from './launch-util.mjs'
import { OPEN_TOOLS, DENY_MESSAGE, isOpenTool, isOwnerOnlyTool } from '../channels/telegram/owner-gate.mjs'
import { allowedNames, denyReason } from '../chatroom/tool-gate.mjs'

const ALL = [fusion, freecad, matlab, espidf, serial, rhino, altium]
const uvx = () => ({ path: 'C:\\uv\\uvx.exe', source: 'system' })
const dirOk = { exists: () => true, isDir: () => true }

test('mcp6: every component is off by default, needs no install, and is wired into settings + UI', () => {
  const root = join(import.meta.dirname, '..', '..')
  const src = readFileSync(join(root, 'src', 'index.mjs'), 'utf8')
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const reg = readFileSync(join(root, 'src', 'components', 'registry.mjs'), 'utf8')
  for (const c of ALL) {
    assert.equal(c.launch({}).ok, false, c.id)
    assert.equal(c.installed(), true); assert.equal(c.install, undefined)
    assert.match(src, new RegExp(`${c.id}Enabled: z\\.boolean\\(\\)\\.default\\(false\\)`))
    for (const k of c.keys) assert.ok(client.includes(`key: "${k}"`), k)
    assert.ok(client.includes(`id: "${c.id}", group: "工作组件"`), c.id)
    assert.ok(reg.includes(`{ component: ${c.id}, mod: ${c.id}Mod }`), c.id)
  }
  assert.match(src, /freecadToken: z\.string\(\)\.role\('secret'\)/)
})

test('fusion: local streamable-http, default port 27182, URL validated', () => {
  const p = fusion.launch({ fusionEnabled: true })
  assert.equal(p.ok, true); assert.equal(p.source, 'remote')
  assert.equal(p.config.transport, 'streamable-http'); assert.equal(p.config.url, FUSION_URL)
  assert.equal(FUSION_URL, 'http://127.0.0.1:27182/mcp')
  assert.match(fusion.launch({ fusionEnabled: true, fusionUrl: 'ftp://x' }).reason, /http\(s\)/)
  assert.match(fusion.note(), /只读模式/)
})

test('freecad: uvx freecad-mcp, --host only for remote hosts, text-only flag, token via env (never in args)', () => {
  const p = freecadPlan({ freecadEnabled: true }, { uvx })
  assert.deepEqual([p.config.command, ...p.config.args], ['C:\\uv\\uvx.exe', 'freecad-mcp'])
  const r = freecadPlan({ freecadEnabled: true, freecadHost: '192.168.1.100', freecadTextOnly: true, freecadToken: 'TOKEN123' }, { uvx })
  assert.deepEqual(r.config.args, ['freecad-mcp', '--host', '192.168.1.100', '--only-text-feedback'])
  assert.equal(r.config.env.FREECAD_MCP_TOKEN, 'TOKEN123'); assert.ok(!r.config.args.join(' ').includes('TOKEN123'))
  assert.match(freecadPlan({ freecadEnabled: true, freecadHost: 'a b;rm' }, { uvx }).reason, /主机名无效/)
  assert.match(freecadPlan({ freecadEnabled: true }, { uvx: () => null }).reason, /uvx/)
})

test('matlab: exe path or PATH lookup, README flags, existing mode drops root/folder/display, telemetry off by default', () => {
  assert.match(matlabPlan({ matlabEnabled: true }, { exists: () => false, env: { PATH: '' } }).reason, /GitHub Releases/)
  const p = matlabPlan({ matlabEnabled: true, matlabServerPath: '"C:\\m\\matlab-mcp-server-windows-x64.exe"', matlabRoot: 'C:\\Program Files\\MATLAB\\R2026a', matlabWorkFolder: 'D:\\proj', matlabDisplayMode: 'nodesktop' }, { exists: () => true })
  assert.equal(p.config.command, 'C:\\m\\matlab-mcp-server-windows-x64.exe')
  assert.deepEqual(p.config.args, ['--matlab-session-mode=auto', '--matlab-root=C:\\Program Files\\MATLAB\\R2026a', '--initial-working-folder=D:\\proj', '--matlab-display-mode=nodesktop', '--disable-telemetry=true'])
  const e = matlabPlan({ matlabEnabled: true, matlabServerPath: 'x.exe', matlabRoot: 'R', matlabSessionMode: 'existing', matlabTelemetry: true }, { exists: () => true })
  assert.deepEqual(e.config.args, ['--matlab-session-mode=existing'])
  const found = matlabPlan({ matlabEnabled: true }, { exists: (f) => /matlab-mcp-server/.test(f) && f.startsWith('C:\\bin'), env: { PATH: 'C:\\bin' } })
  assert.equal(found.ok, true); assert.equal(found.source, 'system')
  assert.match(matlab.note(), /MathWorks 软件许可协议/)
})

test('espidf: eim run "idf.py mcp-server" with IDF_MCP_WORKSPACE_FOLDER; project dir required', () => {
  assert.match(espidfPlan({ espidfEnabled: true }).reason, /项目目录/)
  assert.match(espidfPlan({ espidfEnabled: true, espidfProjectDir: 'D:\\nope' }, { exists: () => false }).reason, /不存在/)
  const p = espidfPlan({ espidfEnabled: true, espidfProjectDir: 'D:\\esp\\blink' }, dirOk)
  assert.deepEqual([p.config.command, ...p.config.args], ['eim', 'run', 'idf.py mcp-server'])
  assert.equal(p.config.env.IDF_MCP_WORKSPACE_FOLDER, 'D:\\esp\\blink')
  assert.deepEqual(splitCommand('eim run "idf.py mcp-server"'), ['eim', 'run', 'idf.py mcp-server'])
})

test('serial: uvx --from serial-mcp-server serial_mcp, underscore tool names, plugins off unless listed', () => {
  const p = serialPlan({ serialEnabled: true }, { uvx })
  assert.deepEqual(p.config.args, ['--from', 'serial-mcp-server', 'serial_mcp'])
  assert.equal(p.config.env.SERIAL_MCP_TOOL_SEPARATOR, '_'); assert.equal(p.config.env.SERIAL_MCP_TRACE, '0')
  assert.equal('SERIAL_MCP_PLUGINS' in p.config.env, false)
  assert.equal(serialPlan({ serialEnabled: true, serialPlugins: 'mydevice, ota' }, { uvx }).config.env.SERIAL_MCP_PLUGINS, 'mydevice,ota')
  assert.match(serialPlan({ serialEnabled: true, serialPlugins: 'x;y' }, { uvx }).reason, /插件名单无效/)
})

test('rhino: official router by default (Rhino 8), community rhinomcp via uvx with port / script switches', () => {
  const o = rhinoPlan({ rhinoEnabled: true }, { uvx })
  assert.deepEqual([o.config.command, ...o.config.args], ['rhino-mcp-router', '--default-version', '8'])
  assert.deepEqual(rhinoPlan({ rhinoEnabled: true, rhinoVersion: '9' }, { uvx }).config.args, ['--default-version', '9'])
  const custom = rhinoPlan({ rhinoEnabled: true, rhinoCommand: '"C:\\Rhino Router\\rhino-mcp-router.exe" --default-version 8' }, { uvx })
  assert.deepEqual([custom.config.command, ...custom.config.args], ['C:\\Rhino Router\\rhino-mcp-router.exe', '--default-version', '8'])
  const c = rhinoPlan({ rhinoEnabled: true, rhinoSource: 'community', rhinoPort: '2001', rhinoScripts: false }, { uvx })
  assert.deepEqual([c.config.command, ...c.config.args], ['C:\\uv\\uvx.exe', 'rhinomcp'])
  assert.deepEqual(c.config.env, { UV_HTTP_TIMEOUT: '600', RHINO_MCP_HOST: '127.0.0.1', RHINO_MCP_PORT: '2001', RHINO_MCP_ENABLE_RUN_COMMAND: '0', RHINO_MCP_ENABLE_RHINOSCRIPT: '0', RHINO_MCP_ENABLE_CSHARP: '0' })
  assert.match(rhinoPlan({ rhinoEnabled: true, rhinoSource: 'community', rhinoPort: '99999' }, { uvx }).reason, /端口无效/)
})

test('altium: eda-agent with minimal toolset by default, dashboard off, UI automation switch', () => {
  const p = altiumPlan({ altiumEnabled: true })
  assert.deepEqual([p.config.command, ...p.config.args], ['eda-agent'])
  assert.equal(p.config.env.EDA_AGENT_TOOLSET, 'minimal'); assert.equal(p.config.env.EDA_AGENT_BACKEND, 'altium')
  assert.equal(p.config.env.EDA_AGENT_DISABLE_DASHBOARD, '1'); assert.equal('EDA_AGENT_UI_AUTOMATION' in p.config.env, false)
  const f = altiumPlan({ altiumEnabled: true, altiumToolset: 'full', altiumDashboard: true, altiumUiAutomation: false, altiumCommand: 'python -m eda_agent' })
  assert.deepEqual([f.config.command, ...f.config.args], ['python', '-m', 'eda_agent'])
  assert.equal(f.config.env.EDA_AGENT_TOOLSET, 'full'); assert.equal('EDA_AGENT_DISABLE_DASHBOARD' in f.config.env, false); assert.equal(f.config.env.EDA_AGENT_UI_AUTOMATION, '0')
})

// ── 模拟 MCP 服务器 ──
const DESCS = { a: 'Read the active document and return its structure.', b: 'Execute a script inside the host application.' }

test('fusion plan talks to a mocked streamable-http MCP server; probe counts tools and checks the port', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const m = JSON.parse(body)
      if (m.id === undefined) { res.writeHead(202).end(); return }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fusion', version: 'fake' } }
        : { tools: [{ name: 'fusion_mcp_read', description: DESCS.a, inputSchema: { type: 'object' } }, { name: 'fusion_mcp_execute', description: DESCS.b, inputSchema: { type: 'object' } }] }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`
    const plan = fusion.launch({ fusionEnabled: true, fusionUrl: url })
    const post = async (id, method) => (await (await fetch(plan.config.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...plan.config.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) })).json()).result
    assert.equal((await post(1, 'initialize')).serverInfo.name, 'fusion')
    const tools = (await post(2, 'tools/list')).tools
    assert.deepEqual(tools.map((t) => t.description), [DESCS.a, DESCS.b])
    const names = tools.map((t) => `mcp__fusion__${t.name}`)
    let asked = null
    const ctx = { cfg: { fusionUrl: url }, tools: { schemas: () => names.map((name) => ({ name })) }, procs: async () => new Set(['fusion360']), env: { tcpOpen: async (h, p) => { asked = [h, p]; return true } } }
    const st = await fusionProbe.call(fusion, ctx)
    assert.equal(st.state, 'connected'); assert.match(st.detail, /2 个工具/); assert.deepEqual(asked, ['127.0.0.1', server.address().port])
    assert.equal((await fusionProbe.call(fusion, { ...ctx, procs: async () => new Set() })).state, 'no-app')
    assert.equal((await fusionProbe.call(fusion, { ...ctx, env: { tcpOpen: async () => false } })).state, 'unreachable')
  } finally { await new Promise((r) => server.close(r)) }
})

const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  let result
  if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } }
  else if (m.method === 'tools/list') result = { tools: [{ name: 'read_doc', description: ${JSON.stringify(DESCS.a)}, inputSchema: { type: 'object' } }, { name: 'run_script', description: ${JSON.stringify(DESCS.b)}, inputSchema: { type: 'object' } }] }
  else result = { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), env: pick(process.env, ['FREECAD_MCP_TOKEN', 'IDF_MCP_WORKSPACE_FOLDER', 'SERIAL_MCP_TOOL_SEPARATOR', 'RHINO_MCP_PORT', 'EDA_AGENT_TOOLSET']) }) }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
})
`

async function talk(config) {
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''; const wait = new Map(); let n = 0
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait.get(m.id)?.(m.result) } })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++n; const t = setTimeout(() => reject(new Error('timeout ' + method)), 10000); wait.set(id, (r) => { clearTimeout(t); resolve(r) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  try {
    await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    const { tools } = await call('tools/list')
    const out = JSON.parse((await call('tools/call', { name: 'read_doc', arguments: {} })).content[0].text)
    return { tools, out }
  } finally { await new Promise((r) => { child.once('exit', r); child.kill() }) }
}

test('stdio components spawn the configured command against a mocked MCP server (args / env pass through, English descriptions intact)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp6-test-'))
  try {
    const script = join(dir, 'fake mcp.cjs'); writeFileSync(script, FAKE)
    const proj = join(dir, 'proj'); mkdirSync(proj)
    const cmd = `"${process.execPath}" "${script}"`
    const cases = [
      [freecad, { freecadEnabled: true, freecadCommand: cmd, freecadHost: 'cad-box', freecadToken: 'T0K' }, (o) => { assert.deepEqual(o.argv, ['--host', 'cad-box']); assert.equal(o.env.FREECAD_MCP_TOKEN, 'T0K') }],
      [espidf, { espidfEnabled: true, espidfCommand: cmd, espidfProjectDir: proj }, (o) => assert.equal(o.env.IDF_MCP_WORKSPACE_FOLDER, proj)],
      [serial, { serialEnabled: true, serialCommand: cmd }, (o) => assert.equal(o.env.SERIAL_MCP_TOOL_SEPARATOR, '_')],
      [rhino, { rhinoEnabled: true, rhinoSource: 'community', rhinoCommand: cmd, rhinoPort: '2005' }, (o) => assert.equal(o.env.RHINO_MCP_PORT, '2005')],
      [altium, { altiumEnabled: true, altiumCommand: cmd }, (o) => assert.equal(o.env.EDA_AGENT_TOOLSET, 'minimal')],
    ]
    for (const [c, cfg, check] of cases) {
      const plan = c.launch(cfg)
      assert.equal(plan.ok, true, c.id + ': ' + plan.reason)
      const { tools, out } = await talk(plan.config)
      assert.deepEqual(tools.map((t) => t.description), [DESCS.a, DESCS.b], c.id)
      check(out)
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('probes: host app required where it must be running; bridge ports checked; tool count reported', async () => {
  const names = (s) => ({ schemas: () => ['a', 'b', 'c'].map((n) => ({ name: `mcp__${s}__${n}` })) })
  const base = (s, procs, tcp = true) => ({ tools: names(s), procs: async () => new Set(procs), env: { tcpOpen: async () => tcp } })
  assert.equal((await rhinoProbe.call(rhino, { cfg: {}, ...base('rhino', []) })).state, 'no-app')
  assert.match((await rhinoProbe.call(rhino, { cfg: {}, ...base('rhino', ['rhino']) })).detail, /官方.*3 个工具/)
  assert.match((await rhinoProbe.call(rhino, { cfg: { rhinoSource: 'community' }, ...base('rhino', ['rhino'], false) })).detail, /mcpstart/)
  assert.match((await freecadProbe.call(freecad, { cfg: {}, ...base('freecad', ['freecad'], false) })).detail, /Start RPC Server/)
  assert.equal((await freecadProbe.call(freecad, { cfg: { freecadHost: 'cad-box' }, ...base('freecad', []) })).state, 'connected')
  assert.match((await altiumProbe.call(altium, { cfg: {}, ...base('altium', ['x2']) })).detail, /工具集 minimal.*3 个工具/)
  assert.equal((await altiumProbe.call(altium, { cfg: {}, ...base('altium', ['x2']), tools: { schemas: () => [] } })).state, 'mcp-down')
})

test('every tool of the new components is owner-only in Telegram and chatroom, even if put on the open list', () => {
  for (const s of ['fusion', 'freecad', 'matlab', 'espidf', 'serial', 'rhino', 'altium']) {
    const t = `mcp__${s}__some_tool`
    assert.equal(isOwnerOnlyTool(t), true, s)
    OPEN_TOOLS.add(t)
    try {
      assert.equal(isOpenTool(t), false)
      assert.equal(denyReason(t, { owner: false, inToolset: true }), DENY_MESSAGE)
      assert.equal(denyReason(t, { owner: false, inToolset: true, gameTurn: true }), DENY_MESSAGE)
    } finally { OPEN_TOOLS.delete(t) }
    assert.equal(denyReason(t, { owner: true, inToolset: true }), null)
    assert.deepEqual(allowedNames(['get_time', t], false), ['get_time'])
  }
})