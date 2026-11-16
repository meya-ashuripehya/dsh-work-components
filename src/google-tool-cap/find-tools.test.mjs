import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPinStore } from './pins.mjs'
import { createSessionFindTools } from './find-tools.mjs'
import { selectExposedTools, VERTEX_FUNCTION_DECLARATIONS_CAP } from './expose.mjs'
import { mcpServerOf } from './scenes.mjs'

function mockTools(entries) {
  return {
    schemas: () => entries.map((e) => ({
      name: e.name,
      description: e.description || e.name,
      parameters: { type: 'object', properties: {} },
    })),
  }
}

describe('find_tools scene suite expand', () => {
  it('browser chrome pins full chrome preferServers suite, not lexical top-3', async () => {
    const pins = createPinStore()
    const catalog = [
      { name: 'bash', description: 'shell' },
      { name: 'mcp__windows__powershell', description: 'ps' },
      { name: 'mcp__chrome__navigate', description: 'nav' },
      { name: 'mcp__chrome__click', description: 'click' },
      { name: 'mcp__chrome__screenshot', description: 'shot' },
      { name: 'mcp__chrome__type', description: 'type' },
      { name: 'mcp__chrome__scroll', description: 'scroll' },
      { name: 'mcp__chrome-devtools__evaluate', description: 'eval' },
      { name: 'mcp__desktop__click', description: 'desk' },
    ]
    const tool = createSessionFindTools({
      getLlm: () => null,
      getTools: () => mockTools(catalog),
      pins,
      getFinder: () => ({}),
      getSessionId: () => 'test-session',
      maxPerFind: 3,
    })
    const result = await tool.execute({ query: 'browser chrome' }, {})
    assert.equal(result.ok, true)
    assert.match(String(result.text || ''), /scene suite expand/i)
    assert.ok(result.scenes?.includes('browser'))
    const expected = [
      'mcp__chrome-devtools__evaluate',
      'mcp__chrome__click',
      'mcp__chrome__navigate',
      'mcp__chrome__screenshot',
      'mcp__chrome__scroll',
      'mcp__chrome__type',
    ]
    assert.deepEqual([...result.tools].sort(), expected)
    assert.ok(result.tools.length > 3, 'must bypass maxPerFind=3')
    assert.ok(!result.tools.includes('bash'))
    assert.ok(!result.tools.includes('mcp__windows__powershell'))
    assert.ok(!result.tools.includes('mcp__desktop__click'))
    const listed = pins.list('test-session')
    for (const n of expected) assert.ok(listed.includes(n), 'pin missing ' + n)
  })

  it('non-scene query still respects maxPerFind via lexical fallback', async () => {
    const pins = createPinStore()
    const catalog = [
      { name: 'mcp__ffmpeg__convert', description: 'convert' },
      { name: 'mcp__ffmpeg__probe', description: 'probe' },
      { name: 'mcp__ffmpeg__trim', description: 'trim' },
      { name: 'mcp__ffmpeg__merge', description: 'merge' },
    ]
    const tool = createSessionFindTools({
      getLlm: () => null,
      getTools: () => mockTools(catalog),
      pins,
      getFinder: () => ({}),
      getSessionId: () => 'lex-session',
      maxPerFind: 3,
    })
    const result = await tool.execute({ query: 'ffmpeg convert video' }, {})
    assert.equal(result.ok, true)
    assert.ok(result.tools.length <= 3)
    assert.ok(!/scene suite expand/i.test(String(result.text || '')))
    assert.ok(!/exact group/i.test(String(result.text || '')))
  })
})

function names(prefix, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(`${prefix}${String(i).padStart(3, '0')}`)
  return out
}

function find(catalog, { query, pins, labels, allow, sessionId = 's' } = {}) {
  const store = pins || createPinStore()
  const entries = catalog.map((e) => (typeof e === 'string' ? { name: e, description: e } : e))
  const tool = createSessionFindTools({
    getLlm: () => null,
    getTools: () => mockTools(entries),
    pins: store,
    getFinder: () => ({}),
    getSessionId: () => sessionId,
    maxPerFind: 3,
    groupLabels: () => labels || [],
    allow,
  })
  return tool.execute({ query }, {}).then((result) => ({ result, pins: store }))
}

describe('find_tools exact group name', () => {
  const figma = [
    ...names('mcp__figma__figjam_', 4),
    'mcp__figma__get_design_context',
    'mcp__figma__create_new_file',
  ]
  const desktop = names('mcp__figma_desktop__click_', 3)
  const chrome = names('mcp__chrome__t', 4)
  const devtools = ['mcp__chrome-devtools__evaluate']
  const notes = ['mcp__notes__page']

  it('Figma and fIgMa pin the whole figma namespace, not other groups', async () => {
    const catalog = [...figma, ...desktop, ...chrome, ...devtools, ...notes, { name: 'bash', description: 'shell' }]
    for (const query of ['Figma', '  fIgMa  ', 'mcp__figma', 'mcp__figma__']) {
      const { result, pins } = await find(catalog, { query, sessionId: 'fig-' + query.trim() })
      assert.match(result.text, /exact group: figma/i)
      assert.deepEqual([...result.tools].sort(), [...figma].sort())
      assert.ok(result.tools.length > 3)
      assert.ok(result.tools.every((n) => mcpServerOf(n) === 'figma'))
      assert.deepEqual(pins.list('fig-' + query.trim()).sort(), [...figma].sort())
      assert.equal(result.omitted.length, 0)
    }
  })

  it('a substring is not a group match and does not pull in other servers', async () => {
    const catalog = [...figma, ...desktop, ...notes]
    const { result } = await find(catalog, { query: 'fig' })
    assert.ok(!/exact group/i.test(result.text))
    assert.ok(result.tools.length <= 3)
    assert.ok(result.tools.every((n) => mcpServerOf(n) === 'figma' || mcpServerOf(n) === 'figma_desktop'))
    assert.ok(!result.tools.includes('mcp__notes__page'))
    const phrase = await find(catalog, { query: 'figma desktop layout' })
    assert.ok(!/exact group/i.test(phrase.result.text))
    assert.ok(phrase.result.tools.length <= 3)
  })

  it('underscore and hyphen server names stay in their own group', async () => {
    const catalog = [...figma, ...desktop, ...devtools, ...chrome]
    const under = await find(catalog, { query: 'Figma_Desktop' })
    assert.match(under.result.text, /exact group: figma_desktop/i)
    assert.deepEqual([...under.result.tools].sort(), [...desktop].sort())
    const hyphen = await find(catalog, { query: 'chrome-devtools' })
    assert.deepEqual(hyphen.result.tools, ['mcp__chrome-devtools__evaluate'])
    assert.ok(!hyphen.result.tools.some((n) => mcpServerOf(n) === 'chrome'))
  })

  it('display names come only from registration metadata', async () => {
    const catalog = [
      { name: 'mcp__officemcp__open', description: 'open', serverTitle: 'Office' },
      { name: 'mcp__officemcp__save', description: 'save' },
      { name: 'mcp__chrome__navigate', description: 'nav' },
    ]
    const { result } = await find(catalog, {
      query: 'Office',
      labels: [{ server: 'officemcp', names: ['officemcp', 'office'] }],
    })
    assert.deepEqual([...result.tools].sort(), ['mcp__officemcp__open', 'mcp__officemcp__save'])
    const alias = await find(catalog, { query: '设计稿' })
    assert.equal(alias.result.tools.length, 0)
    assert.ok(!/exact group/i.test(alias.result.text))
  })

  it('permission filter drops tools the session may not use', async () => {
    const catalog = ['mcp__windows__a', 'mcp__windows__b', 'mcp__deepslate__render'].map((name) => ({ name, description: name }))
    const { result, pins } = await find(catalog, {
      query: 'windows',
      allow: (name) => !name.startsWith('mcp__windows__'),
    })
    assert.deepEqual(result.tools, [])
    assert.deepEqual(result.denied, ['mcp__windows__a', 'mcp__windows__b'])
    assert.equal(pins.list('s').length, 0)
    assert.match(result.text, /not permitted/i)
  })

  it('groups larger than 3, 48, and 64 are pinned in full when they fit the declaration cap', async () => {
    const big = names('mcp__figma__t', 70)
    const { result, pins } = await find(big.map((name) => ({ name, description: name })), { query: 'figma' })
    assert.equal(result.tools.length, 70)
    assert.equal(pins.list('s').length, 70)
    assert.equal(result.omitted.length, 0)
    assert.ok(!/Not pinned/.test(result.text))
    assert.ok(result.tools.length > 64)
  })

  it('declaration cap is reported and only actually exposed pins are listed', async () => {
    const core = names('core_', 10).map((name) => ({ name, description: name }))
    const figma = names('mcp__figma__t', 600).map((name) => ({ name, description: name }))
    const other = names('mcp__notes__t', 5).map((name) => ({ name, description: name }))
    const catalog = [...core, ...figma, ...other]
    const { result, pins } = await find(catalog, { query: 'figma' })
    const room = VERTEX_FUNCTION_DECLARATIONS_CAP - 10 - 1
    assert.equal(result.tools.length, room)
    assert.equal(result.omitted.length, 600 - room)
    assert.equal(pins.list('s').length, room)
    assert.match(result.text, /functionDeclarations cap is 512/)
    assert.equal(result.tools.every((n) => pins.list('s').includes(n)), true)
    const exposed = selectExposedTools({
      tools: catalog,
      provider: 'google-vertex',
      pins: pins.list('s'),
      findToolsSchema: { name: 'find_tools', description: 'find', parameters: { type: 'object', properties: {} } },
    })
    const exposedNames = new Set(exposed.tools.map((t) => t.name))
    assert.equal(exposed.mode, 'discovery')
    assert.ok(exposed.tools.length <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    for (const n of result.tools) assert.ok(exposedNames.has(n), n)
    for (const n of result.omitted) assert.ok(!exposedNames.has(n))
  })

  it('later finds do not drop pins that were already reported', async () => {
    const catalog = [
      ...names('mcp__alpha__t', 30),
      ...names('mcp__beta__t', 40),
      ...names('mcp__gamma__t', 500),
      ...names('core_', 10),
    ].map((name) => ({ name, description: name }))
    const pins = createPinStore()
    const alpha = await find(catalog, { query: 'alpha', pins, sessionId: 'cum' })
    const beta = await find(catalog, { query: 'beta', pins, sessionId: 'cum' })
    assert.equal(alpha.result.tools.length, 30)
    assert.equal(beta.result.tools.length, 40)
    const gamma = await find(catalog, { query: 'gamma', pins, sessionId: 'cum' })
    const held = pins.list('cum')
    for (const n of alpha.result.tools) assert.ok(held.includes(n))
    for (const n of beta.result.tools) assert.ok(held.includes(n))
    assert.equal(gamma.result.tools.every((n) => held.includes(n)), true)
    assert.ok(gamma.result.omitted.length > 0)
    const exposed = selectExposedTools({
      tools: catalog,
      provider: 'google-vertex',
      pins: held,
      findToolsSchema: { name: 'find_tools', description: 'find', parameters: { type: 'object', properties: {} } },
    })
    const exposedNames = new Set(exposed.tools.map((t) => t.name))
    assert.ok(exposed.tools.length <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    for (const n of held) assert.ok(exposedNames.has(n), 'pinned but not exposed ' + n)
    for (const n of gamma.result.omitted) assert.ok(!held.includes(n))
  })

  it('browser chrome still expands the scene suite', async () => {
    const catalog = [
      { name: 'mcp__chrome__navigate', description: 'nav' },
      { name: 'mcp__chrome__click', description: 'click' },
      { name: 'mcp__chrome-devtools__evaluate', description: 'eval' },
      { name: 'mcp__windows__powershell', description: 'ps' },
    ]
    const { result } = await find(catalog, { query: 'browser chrome' })
    assert.match(result.text, /scene suite expand/i)
    assert.ok(result.tools.includes('mcp__chrome__navigate'))
    assert.ok(result.tools.includes('mcp__chrome-devtools__evaluate'))
    assert.ok(!result.tools.includes('mcp__windows__powershell'))
  })
})
