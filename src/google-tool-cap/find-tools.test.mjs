import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPinStore } from './pins.mjs'
import { createSessionFindTools } from './find-tools.mjs'

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
  })
})
