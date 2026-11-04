import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectExposedTools,
  historyUsedToolNames,
  isGoogleToolCapProvider,
  VERTEX_FUNCTION_DECLARATIONS_CAP,
} from './expose.mjs'
import { createPinStore } from './pins.mjs'

const mk = (n) => ({ name: n, description: n, parameters: { type: 'object', properties: {} } })

describe('google tool cap expose', () => {
  it('detects google providers', () => {
    assert.equal(isGoogleToolCapProvider('google-vertex'), true)
    assert.equal(isGoogleToolCapProvider('google'), true)
    assert.equal(isGoogleToolCapProvider('deepseek'), false)
  })

  it('passthrough under cap', () => {
    const tools = [mk('bash'), mk('mcp__a__x')]
    const r = selectExposedTools({ tools, provider: 'google-vertex' })
    assert.equal(r.mode, 'passthrough')
    assert.equal(r.tools.length, 2)
  })

  it('discovery keeps non-mcp + find_tools + pins + history, drops other mcp', () => {
    const tools = []
    for (let i = 0; i < 40; i++) tools.push(mk('core_' + i))
    for (let i = 0; i < 500; i++) tools.push(mk('mcp__ffmpeg__t' + i))
    tools.push(mk('mcp__windows__powershell'))
    tools.push(mk('mcp__desktop__click'))
    assert.ok(tools.length > VERTEX_FUNCTION_DECLARATIONS_CAP)

    const pins = ['mcp__desktop__click']
    const r = selectExposedTools({
      tools,
      provider: 'google-vertex',
      pins,
      historyUsed: ['mcp__windows__powershell'],
      findToolsSchema: mk('find_tools'),
    })
    assert.equal(r.mode, 'discovery')
    assert.ok(r.kept <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    const names = new Set(r.tools.map((t) => t.name))
    assert.ok(names.has('find_tools'))
    assert.ok(names.has('core_0'))
    assert.ok(names.has('mcp__desktop__click'))
    assert.ok(names.has('mcp__windows__powershell'))
    assert.ok(!names.has('mcp__ffmpeg__t0'), 'should not fill budget with unrelated mcp')
  })

  it('historyUsedToolNames reads toolCall blocks', () => {
    const msgs = [{
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'mcp__desktop__click', arguments: {} }],
    }]
    const s = historyUsedToolNames(msgs)
    assert.ok(s.has('mcp__desktop__click'))
  })

  it('pin store LRU-ish add', () => {
    const pins = createPinStore({ maxPerSession: 3 })
    pins.add('s1', ['a', 'b', 'c'])
    pins.add('s1', ['d'])
    assert.deepEqual(pins.list('s1'), ['b', 'c', 'd'])
  })
})
