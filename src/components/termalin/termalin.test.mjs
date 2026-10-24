import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import component, { probe, resolveLocalCommand, checkHostedUrl, DEFAULT_URL, modeOf } from './index.mjs'
import { OPEN_TOOLS, DENY_MESSAGE, isOpenTool, isOwnerOnlyTool, OWNER_ONLY_PREFIXES } from '../../channels/telegram/owner-gate.mjs'
import { allowedNames, denyReason, isOpen, isOwnerMessage } from '../../chatroom/tool-gate.mjs'

const KEY = 'tk_live_TESTONLY_not_a_real_key'
const OWNER = '9000000001'

test('termalin: off by default, local mode by default', () => {
  assert.equal(component.launch({}).ok, false)
  assert.match(component.launch({}).reason, /停用/)
  assert.equal(modeOf({}), 'local')
  assert.equal(component.installed(), true)
  assert.equal(component.install, undefined)
  assert.deepEqual(component.keys, ['termalinEnabled', 'termalinMode', 'termalinCommand', 'termalinUrl', 'termalinApiKey'])
})

test('termalin hosted: needs key, sends Bearer, rejects OAuth / non-http endpoints', () => {
  const noKey = component.launch({ termalinEnabled: true, termalinMode: 'hosted' })
  assert.equal(noKey.ok, false)
  assert.match(noKey.reason, /API 密钥/)
  const plan = component.launch({ termalinEnabled: true, termalinMode: 'hosted', termalinApiKey: `Bearer ${KEY}` })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'remote')
  assert.equal(plan.config.transport, 'streamable-http')
  assert.equal(plan.config.serverName, 'termalin')
  assert.equal(plan.config.url, DEFAULT_URL)
  assert.equal(plan.config.headers.Authorization, `Bearer ${KEY}`)
  for (const url of ['https://termal.in/mcp', 'https://termal.in/mcp/', 'https://termal.in']) {
    const r = component.launch({ termalinEnabled: true, termalinMode: 'hosted', termalinApiKey: KEY, termalinUrl: url })
    assert.equal(r.ok, false, url)
    assert.match(r.reason, /OAuth/)
  }
  assert.match(checkHostedUrl('ftp://x/y').reason, /http\(s\)/)
  assert.match(checkHostedUrl('not a url').reason, /地址无效/)
  // 说明文字不带密钥
  assert.ok(!component.note({ termalinMode: 'hosted', termalinApiKey: KEY }).includes(KEY))
})

test('termalin local: configured path wins, detection is optional, no install', () => {
  const plan = component.launch({ termalinEnabled: true, termalinCommand: '"C:\\Apps\\Termalin\\termalin-mcp.exe"' })
  assert.equal(plan.ok, true)
  assert.equal(plan.source, 'setting')
  assert.equal(plan.config.transport, 'stdio')
  assert.equal(plan.config.command, 'C:\\Apps\\Termalin\\termalin-mcp.exe')
  assert.deepEqual(plan.config.args, [])
  assert.equal(resolveLocalCommand({}, { env: { PATH: '' }, home: '/h', exists: () => false }), null)
  const hit = resolveLocalCommand({}, { env: { PATH: '/opt/bin', LOCALAPPDATA: '/la' }, home: '/h', exists: (p) => /opt.bin/.test(p) })
  assert.equal(hit.source, 'system')
  assert.match(hit.path, /termalin-mcp/)
})

test('termalin settings: API key is a secret, UI fields exist', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const src = readFileSync(join(root, 'src', 'index.mjs'), 'utf8')
  assert.match(src, /termalinApiKey: z\.string\(\)\.role\('secret'\)/)
  assert.match(src, /termalinEnabled: z\.boolean\(\)\.default\(false\)/)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const k of component.keys) assert.ok(client.includes(`key: "${k}"`), k)
  assert.ok(client.includes('{ key: "termalinApiKey", label: "API 密钥", type: "password"'))
  assert.ok(client.includes('id: "termalin", group: "工作组件"'))
})

/** 模拟的 Termalin 托管 MCP（streamable-http，JSON 响应），不访问 termal.in。 */
function fakeTermalin() {
  const seen = []
  const tools = [
    { name: 'hosts_list', description: 'List the SSH hosts available to this key.', inputSchema: { type: 'object', properties: {} } },
    { name: 'ssh_exec', description: 'Run a shell command on a host and return stdout, stderr and exit code.', inputSchema: { type: 'object', properties: { host: { type: 'string' }, command: { type: 'string' } }, required: ['host', 'command'] } },
  ]
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, accept: req.headers.accept })
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end(); return }
      const msg = JSON.parse(body)
      if (msg.id === undefined) { res.writeHead(202).end(); return }
      let result
      if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'termalin', version: 'test' } }
      else if (msg.method === 'tools/list') result = { tools }
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `ran ${msg.params.arguments.command}` }] }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  return { server, seen, tools }
}

async function rpc(cfg, id, method, params) {
  const r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...cfg.headers }, body: JSON.stringify({ jsonrpc: '2.0', ...(id == null ? {} : { id }), method, params }) })
  if (r.status === 202) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).result
}

test('termalin hosted plan talks to a mocked MCP server; English tool descriptions pass through', async () => {
  const fake = fakeTermalin()
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${fake.server.address().port}/api/v1/mcp`
    const plan = component.launch({ termalinEnabled: true, termalinMode: 'hosted', termalinUrl: url, termalinApiKey: KEY })
    assert.equal(plan.ok, true)
    const init = await rpc(plan.config, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.serverInfo.name, 'termalin')
    await rpc(plan.config, null, 'notifications/initialized', {})
    const listed = await rpc(plan.config, 2, 'tools/list', {})
    assert.deepEqual(listed.tools.map((t) => t.description), fake.tools.map((t) => t.description))
    const out = await rpc(plan.config, 3, 'tools/call', { name: 'ssh_exec', arguments: { host: 'web', command: 'uptime' } })
    assert.equal(out.content[0].text, 'ran uptime')
    assert.ok(fake.seen.every((s) => s.auth === `Bearer ${KEY}`))
    // 错误密钥被拒
    await assert.rejects(rpc({ ...plan.config, headers: { Authorization: 'Bearer wrong' } }, 4, 'tools/list', {}), /401/)

    // 探测：按挂载后的工具名计数
    const names = listed.tools.map((t) => `mcp__termalin__${t.name}`)
    const ctx = { cfg: { termalinEnabled: true, termalinMode: 'hosted', termalinUrl: url, termalinApiKey: KEY }, tools: { schemas: () => names.map((name) => ({ name })) } }
    const st = await probe.call(component, ctx)
    assert.equal(st.state, 'connected')
    assert.match(st.detail, /2 个工具/)
    assert.ok(!JSON.stringify(st).includes(KEY))
    const down = await probe.call(component, { ...ctx, tools: { schemas: () => [] } })
    assert.equal(down.state, 'mcp-down')
    const noKey = await probe.call(component, { ...ctx, cfg: { ...ctx.cfg, termalinApiKey: '' } })
    assert.equal(noKey.via, 'auth')
  } finally {
    await new Promise((r) => fake.server.close(r))
  }
})

test('termalin tools are owner-only in Telegram and chatroom, even if listed as open', () => {
  assert.ok(OWNER_ONLY_PREFIXES.includes('mcp__termalin__'))
  const t = 'mcp__termalin__hosts_list'
  assert.equal(isOwnerOnlyTool(t), true)
  OPEN_TOOLS.add(t)
  try {
    assert.equal(isOpenTool(t), false)
    assert.equal(isOpen(t), false)
    assert.equal(denyReason(t, { owner: false, inToolset: true }), DENY_MESSAGE)
    assert.equal(denyReason(t, { owner: false, inToolset: true, gameTurn: true }), DENY_MESSAGE)
  } finally { OPEN_TOOLS.delete(t) }
  assert.equal(denyReason('mcp__termalin__ssh_exec', { owner: false, inToolset: false }), DENY_MESSAGE)
  assert.equal(denyReason('mcp__termalin__ssh_exec', { owner: true, inToolset: true }), null)
  assert.deepEqual(allowedNames(['web_search', 'mcp__termalin__ssh_exec'], false), ['web_search'])
  assert.deepEqual(allowedNames(['web_search', 'mcp__termalin__ssh_exec'], true), ['web_search', 'mcp__termalin__ssh_exec'])
  assert.equal(isOpenTool('web_search'), true)
  // 真实发送者：本机桌面端算所有者；Telegram 只认所有者 ID
  assert.equal(isOwnerMessage({ kind: 'user', source: 'local' }, OWNER), true)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: true, speaker: { id: `tg:${OWNER}` } }, OWNER), true)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: true, speaker: { id: 'tg:7000000001' } }, OWNER), false)
  assert.equal(isOwnerMessage({ kind: 'user', source: 'telegram', owner: false, speaker: { id: `tg:${OWNER}` } }, OWNER), false)
})