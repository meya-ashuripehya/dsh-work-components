import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools, chatroomPinBudget } from './chatroom-tools.mjs'
import { FIND_TOOLS_NAME } from './tool-selector.mjs'
import { VERTEX_FUNCTION_DECLARATIONS_CAP } from '../google-tool-cap/expose.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-gs-'))

function schemasOf(names) {
  return names.map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
}

function toolkit(dir, names, { llm, labels, toolsetMax = 12 } = {}) {
  return createChatroomTools({
    roomDir: (id) => join(dir, id),
    getTools: () => ({ schemas: () => schemasOf(names), get: () => null }),
    getLlm: () => llm || null,
    getSettings: () => ({ enabled: true, toolsetMax }),
    providers: async () => ({ available: true, providers: [{ id: 'deepseek', models: [] }] }),
    groupLabels: () => labels || [],
  })
}

test('chatroom exact name: Figma/fIgMa, substring, underscore, permission', async () => {
  const dir = await tmp()
  const figma = []
  for (let i = 0; i < 70; i++) figma.push('mcp__figma__t' + String(i).padStart(3, '0'))
  const names = [
    ...figma,
    'mcp__figma_desktop__click',
    'mcp__windows__powershell',
    'mcp__windows__registry',
    'mcp__deepslate__render',
    'read_file',
  ]
  const llm = { stream() { throw new Error('selector should not run for an exact group name') } }
  try {
    const tk = toolkit(dir, names, {
      llm,
      labels: [{ server: 'figma', names: ['figma'] }],
    })
    const call = (query, owner) => tk.run('r', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query }) }, { owner, seat: { id: 's' } })
    const hit = await call('  fIgMa  ', true)
    assert.match(hit.modelText, /exact group: figma/)
    assert.equal(hit.room.data.tools.length, 70)
    assert.ok(hit.room.data.tools.length > 64)
    assert.ok(!hit.room.data.tools.includes('mcp__figma_desktop__click'))
    assert.equal((await tk.toolsets.list('r')).length, 70)
    const exposed = (await tk.schemas('r', { owner: true })).map((t) => t.name)
    for (const n of hit.room.data.tools) assert.ok(exposed.includes(n))

    const under = await call('figma_desktop', true)
    assert.deepEqual(under.room.data.tools, ['mcp__figma_desktop__click'])
    assert.equal((await tk.toolsets.list('r')).some((x) => x.name.startsWith('mcp__figma__')), true)

    const member = toolkit(dir, names, { llm })
    const denied = await member.run('r2', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: 'Windows' }) }, { owner: false, seat: { id: 's' } })
    assert.deepEqual(denied.room.data.tools, [])
    assert.equal(denied.room.data.denied.length, 2)
    assert.match(denied.modelText, /没有使用权限/)
    assert.equal((await member.toolsets.list('r2')).length, 0)

    const ownerWin = await member.run('r2', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: 'windows' }) }, { owner: true, seat: { id: 's' } })
    assert.deepEqual(ownerWin.room.data.tools.sort(), ['mcp__windows__powershell', 'mcp__windows__registry'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('chatroom exact name stays callable past toolsetMax and under the declaration cap', async () => {
  const dir = await tmp()
  const big = []
  for (let i = 0; i < 600; i++) big.push('mcp__big__t' + String(i).padStart(3, '0'))
  const alpha = []
  for (let i = 0; i < 20; i++) alpha.push('mcp__alpha__t' + String(i).padStart(3, '0'))
  const names = [...alpha, ...big, 'read_file']
  let reply = '{"tools":["read_file"]}'
  const llm = { stream: async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  try {
    const tk = toolkit(dir, names, { llm, toolsetMax: 12 })
    const first = await tk.run('r', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: 'alpha' }) }, { owner: true, seat: { id: 's' } })
    assert.equal(first.room.data.tools.length, 20)
    const budget = chatroomPinBudget({ owner: true })
    const huge = await tk.run('r', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: 'big' }) }, { owner: true, seat: { id: 's' } })
    assert.equal(huge.room.data.tools.length, budget.room - 20)
    assert.equal(huge.room.data.omitted.length, 600 - huge.room.data.tools.length)
    assert.match(huge.modelText, /functionDeclarations 512/)
    const held = (await tk.toolsets.list('r')).map((x) => x.name)
    for (const n of first.room.data.tools) assert.ok(held.includes(n))
    for (const n of huge.room.data.tools) assert.ok(held.includes(n))
    for (const n of huge.room.data.omitted) assert.ok(!held.includes(n))
    const exposed = (await tk.schemas('r', { owner: true })).map((t) => t.name)
    assert.ok(exposed.length <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    for (const n of held) assert.ok(exposed.includes(n))

    const casual = await tk.run('r', { name: FIND_TOOLS_NAME, arguments: JSON.stringify({ query: 'read a file' }) }, { owner: true, seat: { id: 's' } })
    const after = (await tk.toolsets.list('r')).map((x) => x.name)
    for (const n of first.room.data.tools) assert.ok(after.includes(n), 'casual find evicted an exact pin')
    for (const n of huge.room.data.tools) assert.ok(after.includes(n))
    assert.equal(casual.room.data.tools.includes('read_file'), after.includes('read_file'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
