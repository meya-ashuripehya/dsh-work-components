import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRepeatExempt, bareToolName } from './repeat-guard.mjs'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'

test('isRepeatExempt: snapshot / screenshot tools only, MCP prefixes stripped, case-insensitive', () => {
  for (const n of ['mcp__chrome__take_snapshot', 'mcp__chrome__take_screenshot', 'take_snapshot', 'TAKE_SCREENSHOT',
    'mcp_windows__Screenshot', 'mcp_windows__Snapshot', 'mcp_windows__State-Tool', 'screenshot', 'snapshot',
    'mcp__blender__get_viewport_screenshot', 'mcp__figma__figma_take_screenshot', 'figma_capture_screenshot',
    'browser_snapshot', 'capture_web_screenshot', 'capture_screen', 'screen_capture', 'screenCapture', 'takeScreenshot', 'page-screenshot']) {
    assert.equal(isRepeatExempt(n), true, n)
  }
  for (const n of ['mcp_windows__PowerShell', 'mcp__chrome__click', 'read_file', 'mcp__chrome__take_heapsnapshot', 'memory_snapshot',
    'compare_screenshot', 'upload_screenshot', 'get_world_state_snapshot', 'note_snapshot', 'restore_task_snapshot',
    'get_heapsnapshot_summary', 'list_snapshots', 'snapshot_restore', 'mcp_windows__Scrape', 'web_search', '', undefined]) {
    assert.equal(isRepeatExempt(n), false, String(n))
  }
  assert.equal(bareToolName('mcp__chrome__take_snapshot'), 'take_snapshot')
  assert.equal(bareToolName('mcp_windows__PowerShell'), 'power_shell')
})

const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const settle = () => new Promise((r) => setTimeout(r, 20))

async function run(toolName, times) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-repeat-'))
  try {
    const store = createStore(dir)
    const seats = resolveSeats({ chatroomSeats: [{ id: 'cl', name: 'Claude', provider: 'anthropic', model: 'c' }] })
    let executed = 0
    const registry = () => ({
      schemas: () => [{ name: toolName, description: 'observe', parameters: { type: 'object', properties: {} } }],
      get: () => ({ execute: async () => { executed++; return { content: [{ type: 'text', text: 'page state #' + executed }] } } }),
    })
    const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => registry(), getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }) })
    let i = 0
    const results = []
    const call = async (o) => {
      i++
      for (const m of o.prompt.messages) if (m.toolResult && !results.includes(m.toolResult)) results.push(m.toolResult)
      // 每一步调用一次同名同参（无参数）的工具，共 times 次，然后回复
      if (i <= times) return { usage: {}, toolCalls: [tc('c' + i, toolName, {})] }
      return { usage: {}, toolCalls: [], text: '好了' }
    }
    const cfg = { seats, userName: 'Shiro', budget: 5, maxTokens: 100, ownerId: '1', defaultMain: 'cl', tools: {} }
    const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg: { typing: () => () => {}, relay: async () => [] }, emit: () => {} })
    const room = await store.createRoom({ title: 't' })
    await toolkit.toolsets.add(room.id, [toolName], { max: 10, by: 'test' })
    const out = await moderator.post(room.id, '看看', { owner: true, source: 'local', userName: 'Shiro' })
    await out.promise; await settle()
    const msgs = await store.readMessages(room.id)
    return { executed, blocked: msgs.filter((m) => m.data?.blocked === 'repeat').length, errors: results.filter((r) => r.isError && /已阻止/.test(r.text)).length }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('repeat guard: a snapshot tool called 5x with the same args is never blocked', async () => {
  const r = await run('mcp__chrome__take_snapshot', 5)
  assert.equal(r.blocked, 0); assert.equal(r.errors, 0); assert.equal(r.executed, 5)
})

test('repeat guard: other tools are still blocked on the 3rd identical call', async () => {
  const r = await run('mcp__chrome__list_pages', 5)
  assert.equal(r.executed, 2)
  assert.ok(r.blocked >= 1); assert.ok(r.errors >= 1)
})
