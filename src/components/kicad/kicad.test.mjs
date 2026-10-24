import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import component, { planFor, probe, splitCommand, DEFAULT_COMMAND, PROFILES, MODES } from './index.mjs'
import { OPEN_TOOLS, DENY_MESSAGE, isOpenTool, isOwnerOnlyTool } from '../../channels/telegram/owner-gate.mjs'
import { allowedNames, denyReason } from '../../chatroom/tool-gate.mjs'

const fakeUvx = () => ({ path: 'C:\\uv\\uvx.exe', source: 'system' })

test('kicad: off by default; uvx kicad-mcp-pro with readonly defaults', () => {
  assert.equal(component.launch({}).ok, false)
  assert.equal(component.installed(), true)
  assert.equal(component.install, undefined)
  const plan = planFor({ kicadEnabled: true }, { uvx: fakeUvx })
  assert.equal(plan.ok, true)
  assert.equal(plan.viaUvx, true)
  assert.equal(plan.config.transport, 'stdio')
  assert.equal(plan.config.serverName, 'kicad')
  assert.equal(plan.config.command, 'C:\\uv\\uvx.exe')
  assert.deepEqual(plan.config.args, ['kicad-mcp-pro'])
  assert.equal(plan.config.env.KICAD_MCP_PROFILE, 'default')
  assert.equal(plan.config.env.KICAD_MCP_OPERATING_MODE, 'readonly')
  assert.equal('KICAD_MCP_PROJECT_DIR' in plan.config.env, false)
  assert.equal(DEFAULT_COMMAND, 'uvx kicad-mcp-pro')
})

test('kicad: settings map to env; bad values fall back; missing uvx / dir explained', () => {
  const plan = planFor({ kicadEnabled: true, kicadProfile: 'build', kicadMode: 'write', kicadProjectDir: 'D:\\pcb' }, { uvx: fakeUvx, exists: () => true, isDir: () => true })
  assert.equal(plan.config.env.KICAD_MCP_PROFILE, 'build')
  assert.equal(plan.config.env.KICAD_MCP_OPERATING_MODE, 'write')
  assert.equal(plan.config.env.KICAD_MCP_PROJECT_DIR, 'D:\\pcb')
  const odd = planFor({ kicadEnabled: true, kicadProfile: 'nope', kicadMode: 'experimental' }, { uvx: fakeUvx })
  assert.equal(odd.config.env.KICAD_MCP_PROFILE, 'default')
  assert.equal(odd.config.env.KICAD_MCP_OPERATING_MODE, 'readonly')
  assert.match(planFor({ kicadEnabled: true }, { uvx: () => null }).reason, /uvx/)
  assert.match(planFor({ kicadEnabled: true, kicadProjectDir: 'D:\\gone' }, { uvx: fakeUvx, exists: () => false }).reason, /项目目录不存在/)
  assert.deepEqual(splitCommand('"C:\\Program Files\\x\\kicad-mcp-pro.exe" --transport stdio'), ['C:\\Program Files\\x\\kicad-mcp-pro.exe', '--transport', 'stdio'])
  const custom = planFor({ kicadEnabled: true, kicadCommand: 'kicad-mcp-pro --transport stdio' }, { uvx: () => { throw new Error('should not resolve uvx') } })
  assert.equal(custom.source, 'setting')
  assert.equal(custom.viaUvx, false)
  assert.deepEqual([custom.config.command, ...custom.config.args], ['kicad-mcp-pro', '--transport', 'stdio'])
  assert.deepEqual(PROFILES, ['default', 'pcb_only', 'build', 'release', 'expert', 'full'])
  assert.deepEqual(MODES, ['readonly', 'write', 'manufacturing'])
})

test('kicad settings and UI fields exist', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const src = readFileSync(join(root, 'src', 'index.mjs'), 'utf8')
  assert.match(src, /kicadEnabled: z\.boolean\(\)\.default\(false\)/)
  assert.match(src, /kicadMode: z\.union\(\['readonly', 'write', 'manufacturing'\]\)\.default\('readonly'\)/)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const k of component.keys) assert.ok(client.includes(`key: "${k}"`), k)
  assert.ok(client.includes('id: "kicad", group: "工作组件"'))
})

// 模拟的 KiCad MCP Pro（stdio、换行分隔 JSON-RPC），按环境变量决定公开的工具；不下载上游。
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const mode = process.env.KICAD_MCP_OPERATING_MODE
const tools = [{ name: 'kicad_get_project_info', description: 'Return KiCad project metadata for the active project.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kicad_run_drc', description: 'Run KiCad DRC through kicad-cli and return violations.', inputSchema: { type: 'object', properties: {} } }]
if (mode === 'write') tools.push({ name: 'pcb_move_footprint', description: 'Move a footprint on the PCB and save.', inputSchema: { type: 'object', properties: {} } })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  let result
  if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'kicad-mcp-pro', version: 'fake' } }
  else if (m.method === 'tools/list') result = { tools }
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ project: process.env.KICAD_MCP_PROJECT_DIR || null, profile: process.env.KICAD_MCP_PROFILE, mode }) }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
})
`

async function session(config) {
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiting = new Map()
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      const m = JSON.parse(line)
      waiting.get(m.id)?.(m.result)
    }
  })
  let n = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++n
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000)
    waiting.set(id, (r) => { clearTimeout(t); resolve(r) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { call, close: () => new Promise((r) => { child.once('exit', r); child.kill() }) }
}

test('kicad plan launches a mocked stdio MCP server with the configured env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kicad-mcp-test-'))
  try {
    const script = join(dir, 'fake-kicad-mcp.cjs')
    writeFileSync(script, FAKE)
    const project = join(dir, 'my board')
    mkdirSync(project)
    const cfg = { kicadEnabled: true, kicadCommand: `"${process.execPath}" "${script}"`, kicadProjectDir: project, kicadProfile: 'build', kicadMode: 'write' }
    const plan = component.launch(cfg)
    assert.equal(plan.ok, true)
    const s = await session(plan.config)
    try {
      const init = await s.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
      assert.equal(init.serverInfo.name, 'kicad-mcp-pro')
      const { tools } = await s.call('tools/list', {})
      assert.deepEqual(tools.map((t) => t.name), ['kicad_get_project_info', 'kicad_run_drc', 'pcb_move_footprint'])
      assert.equal(tools[1].description, 'Run KiCad DRC through kicad-cli and return violations.')
      const out = await s.call('tools/call', { name: 'kicad_get_project_info', arguments: {} })
      assert.deepEqual(JSON.parse(out.content[0].text), { project, profile: 'build', mode: 'write' })
      const names = tools.map((t) => `mcp__kicad__${t.name}`)
      const st = await probe.call(component, { cfg, tools: { schemas: () => names.map((name) => ({ name })) } })
      assert.equal(st.state, 'connected')
      assert.match(st.detail, /build \/ write，3 个工具/)
      const down = await probe.call(component, { cfg, tools: { schemas: () => [] } })
      assert.equal(down.state, 'mcp-down')
    } finally { await s.close() }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('kicad tools are owner-only in every mode (Telegram and chatroom)', () => {
  for (const t of ['mcp__kicad__kicad_get_project_info', 'mcp__kicad__pcb_move_footprint']) {
    assert.equal(isOwnerOnlyTool(t), true)
    OPEN_TOOLS.add(t)
    try {
      assert.equal(isOpenTool(t), false)
      assert.equal(denyReason(t, { owner: false, inToolset: true }), DENY_MESSAGE)
    } finally { OPEN_TOOLS.delete(t) }
    assert.equal(denyReason(t, { owner: true, inToolset: true }), null)
  }
  assert.deepEqual(allowedNames(['get_time', 'mcp__kicad__kicad_run_drc'], false), ['get_time'])
  assert.match(component.note({ kicadMode: 'write' }), /修改工程文件/)
})