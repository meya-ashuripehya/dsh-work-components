import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrapLlmForGoogleToolCap, rewriteOptions } from './wrap.mjs'
import { createPinStore } from './pins.mjs'
import { VERTEX_FUNCTION_DECLARATIONS_CAP } from './expose.mjs'

const mk = (n) => ({ name: n, description: n, parameters: { type: 'object', properties: {} } })

function makeHugeTools(nCore = 70, nMcp = 675) {
  const tools = []
  for (let i = 0; i < nCore; i++) tools.push(mk('core_' + i))
  for (let i = 0; i < nMcp; i++) tools.push(mk('mcp__srv__t' + i))
  return tools
}

describe('google tool cap wrap', () => {
  it('rewriteOptions caps google-vertex over 512', () => {
    const tools = makeHugeTools()
    assert.ok(tools.length > VERTEX_FUNCTION_DECLARATIONS_CAP)
    const pins = createPinStore()
    const out = rewriteOptions({ provider: 'google-vertex', tools, sessionId: 's1' }, { pins, log: console })
    assert.ok(out.tools.length <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    assert.ok(out.tools.some((t) => t.name === 'find_tools') || out.tools.some((t) => t.name.startsWith('core_')))
  })

  it('preparedCall.stream path rewrites tools (the Vertex 512 bug)', async () => {
    const seen = []
    const llm = {
      async prepareCall(config) {
        return Object.freeze({
          config,
          stream(options) {
            seen.push(options?.tools?.length ?? -1)
            return { async *[Symbol.asyncIterator]() { yield { type: 'text', text: 'ok' } } }
          },
        })
      },
      stream(options) {
        seen.push(options?.tools?.length ?? -1)
        return { async *[Symbol.asyncIterator]() {} }
      },
      streamWithRegistration(options, prepared) {
        if (prepared?.stream) return prepared.stream(options)
        return this.stream(options)
      },
    }
    const pins = createPinStore()
    assert.equal(wrapLlmForGoogleToolCap(llm, { pins, log: null }), true)

    const prepared = await llm.prepareCall({ provider: 'google-vertex', model: 'gemini-3.8-flash' })
    const huge = makeHugeTools()
    assert.ok(huge.length > VERTEX_FUNCTION_DECLARATIONS_CAP)
    await prepared.stream({ provider: 'google-vertex', tools: huge, sessionId: 'session-9f9' })
    assert.equal(seen.length, 1)
    assert.ok(seen[0] <= VERTEX_FUNCTION_DECLARATIONS_CAP, 'prepared.stream sent ' + seen[0] + ' tools')
    assert.ok(seen[0] > 0)
  })

  it('streamWithRegistration always rewrites even with prepared != null', async () => {
    const seen = []
    const llm = {
      stream(options) {
        seen.push(options?.tools?.length ?? -1)
        return { async *[Symbol.asyncIterator]() {} }
      },
      streamWithRegistration(options, prepared) {
        return this.stream(options)
      },
    }
    const pins = createPinStore()
    wrapLlmForGoogleToolCap(llm, { pins, log: null })
    const huge = makeHugeTools()
    await llm.streamWithRegistration({ provider: 'google-vertex', tools: huge }, { stream: llm.stream })
    assert.equal(seen.length, 1)
    assert.ok(seen[0] <= VERTEX_FUNCTION_DECLARATIONS_CAP)
  })

  it('rewriteOptions skips cap when isEnabled is false (full tool list)', () => {
    const tools = makeHugeTools()
    assert.ok(tools.length > VERTEX_FUNCTION_DECLARATIONS_CAP)
    const pins = createPinStore()
    const out = rewriteOptions(
      { provider: 'google-vertex', tools, sessionId: 's-off' },
      { pins, log: null, isEnabled: false },
    )
    assert.equal(out.tools.length, tools.length)
    // schemas may be sanitized copies; discovery off must not cap
  })

  it('rewriteOptions skips cap when isEnabled getter returns false', () => {
    const tools = makeHugeTools()
    const pins = createPinStore()
    let on = true
    const outOn = rewriteOptions(
      { provider: 'google-vertex', tools: tools.slice(), sessionId: 's-tog' },
      { pins, log: null, isEnabled: () => on },
    )
    assert.ok(outOn.tools.length <= VERTEX_FUNCTION_DECLARATIONS_CAP)
    on = false
    const outOff = rewriteOptions(
      { provider: 'google-vertex', tools, sessionId: 's-tog' },
      { pins, log: null, isEnabled: () => on },
    )
    assert.equal(outOff.tools.length, tools.length)
  })

  it('sanitizes tuple items even under cap', () => {
    const tools = [{
      name: 't1',
      description: 't',
      parameters: {
        type: 'object',
        properties: {
          position: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] },
        },
      },
    }]
    const out = rewriteOptions({ provider: 'google', tools, sessionId: 's-san' }, { pins: createPinStore(), log: null })
    assert.deepEqual(out.tools[0].parameters.properties.position.items, { type: 'number' })
  })

})
