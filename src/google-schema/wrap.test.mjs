// Gemini / Vertex 工具 schema：元组 items 不得以数组形式离开本包。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toGeminiTools } from '../chatroom/gemini-seat.mjs'
import { callSeat } from '../chatroom/providers.mjs'
import {
  applyGoogleToolSanitize,
  createGoogleSchemaGuard,
  isGoogleFamilyProvider,
  sanitizeGoogleRequest,
  unwrapLlmForGoogleSchemas,
  wrapLlmForGoogleSchemas,
} from './wrap.mjs'

const position = { type: 'array', items: [{ type: 'number' }, { type: 'number', description: 'y' }], additionalItems: false }
const blocks = {
  type: 'object',
  properties: {
    blocks: { type: 'array', items: { type: 'object', properties: { position } } },
  },
}

function placeTool(extra = {}) {
  return { name: 'mcp__deepslate__place', description: 'place blocks', parameters: JSON.parse(JSON.stringify(blocks)), ...extra }
}

function noTuple(value) {
  assert.equal(JSON.stringify(value).includes('"items":['), false)
}

test('isGoogleFamilyProvider matches google, gemini, and vertex ids', () => {
  for (const id of ['google', 'Gemini', 'google-ai', 'google-gemini', 'google-generative-ai', 'google-vision', 'vertex', 'vertex-ai', 'google-vertex']) {
    assert.equal(isGoogleFamilyProvider(id), true, id)
  }
  for (const id of ['', 'deepseek', 'anthropic', 'openai', 'xai', 'openai-vision']) {
    assert.equal(isGoogleFamilyProvider(id), false, id)
  }
})

test('toGeminiTools folds blocks.position tuple items from parameters, inputSchema, and input_schema', () => {
  const fromParameters = toGeminiTools([placeTool()])
  noTuple(fromParameters)
  const decl = fromParameters[0].functionDeclarations[0]
  assert.equal(decl.name, 'mcp__deepslate__place')
  assert.deepEqual(decl.parametersJsonSchema.properties.blocks.items.properties.position, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 })

  const raw = { name: 'mcp__deepslate__place', description: 'd', inputSchema: JSON.parse(JSON.stringify(blocks)) }
  const fromInput = toGeminiTools([raw])
  noTuple(fromInput)
  assert.equal(Array.isArray(raw.inputSchema.properties.blocks.items.properties.position.items), true)

  const snake = { name: 'place2', input_schema: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] } }
  const fromSnake = toGeminiTools([snake])
  noTuple(fromSnake)
  assert.equal('prefixItems' in fromSnake[0].functionDeclarations[0].parametersJsonSchema, false)
  assert.equal(fromSnake[0].functionDeclarations[0].parametersJsonSchema.minItems, 2)
  assert.equal(toGeminiTools([]), undefined)
  assert.equal(toGeminiTools(null), undefined)
})

test('sanitizeGoogleRequest copies google requests only', () => {
  const tool = placeTool()
  const google = { provider: 'vertex-ai', model: 'm', tools: [tool], system: 's' }
  const out = sanitizeGoogleRequest(google)
  assert.notEqual(out, google)
  assert.equal(out.system, 's')
  noTuple(out.tools)
  assert.equal(Array.isArray(tool.parameters.properties.blocks.items.properties.position.items), true)
  const plain = { provider: 'openai', model: 'm', tools: [tool] }
  assert.equal(sanitizeGoogleRequest(plain), plain)
  const noTools = { provider: 'google', model: 'm' }
  assert.equal(sanitizeGoogleRequest(noTools), noTools)
})

test('callSeat sanitizes Google and Vertex tool schemas and leaves other providers untouched', async () => {
  const seen = []
  const llm = {
    stream(req) {
      seen.push(req)
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
  }
  const prompt = { system: '', messages: [{ role: 'user', content: 'hi' }] }
  const tools = [placeTool(), { name: 'raw', description: 'd', inputSchema: JSON.parse(JSON.stringify(blocks)) }]
  const before = JSON.parse(JSON.stringify(tools))
  await callSeat({ seat: { name: 'Gemini', provider: 'google', model: 'gemini-x' }, prompt, llm, tools })
  noTuple(seen[0].tools)
  assert.deepEqual(seen[0].tools[0].parameters.properties.blocks.items.properties.position.items, { type: 'number' })
  noTuple(seen[0].tools[1].inputSchema)
  assert.deepEqual(tools, before)

  const vertexTools = [{ name: 'v', description: '', parametersJsonSchema: { type: 'array', items: [{ type: 'integer' }, { type: 'integer' }] } }]
  await callSeat({ seat: { name: 'Vertex', provider: 'vertex', model: 'gemini-x' }, prompt, llm, tools: vertexTools })
  noTuple(seen[1].tools)
  assert.equal(seen[1].tools[0].parametersJsonSchema.items.type, 'integer')
  assert.equal(Array.isArray(vertexTools[0].parametersJsonSchema.items), true)

  const kept = [placeTool()]
  await callSeat({ seat: { name: 'DS', provider: 'deepseek', model: 'm' }, prompt, llm, tools: kept })
  assert.equal(seen[2].tools, kept)
  assert.equal(Array.isArray(seen[2].tools[0].parameters.properties.blocks.items.properties.position.items), true)
})

test('wrapLlmForGoogleSchemas rewrites stream and prepareCall, then unwraps', async () => {
  const seen = []
  const llm = {
    stream(options) { seen.push(['stream', options]); return 's' },
    async prepareCall(config) {
      seen.push(['prepare', config])
      return Object.freeze({
        model: config?.model,
        stream(options) { seen.push(['prepared-stream', options]); return 'p' },
      })
    },
  }
  assert.equal(wrapLlmForGoogleSchemas(llm), true)
  assert.equal(wrapLlmForGoogleSchemas(llm), true)
  const tool = placeTool()
  assert.equal(llm.stream({ provider: 'google', model: 'g', tools: [tool] }), 's')
  noTuple(seen[0][1].tools)
  assert.equal(Array.isArray(tool.parameters.properties.blocks.items.properties.position.items), true)
  const openai = { provider: 'openai', model: 'o', tools: [tool] }
  assert.equal(llm.stream(openai), 's')
  assert.equal(seen[1][1], openai)

  const prepared = await llm.prepareCall({ provider: 'vertex-ai', model: 'v', tools: [tool] })
  noTuple(seen[2][1].tools)
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(prepared.stream({ provider: 'vertex-ai', model: 'v', tools: [{ name: 'snake', input_schema: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } }] }), 'p')
  noTuple(seen[3][1].tools)
  assert.equal(seen[3][1].tools[0].input_schema.items.anyOf.length, 2)

  const frozen = Object.freeze({ provider: 'gemini', model: 'g', tools: [placeTool()] })
  llm.stream(frozen)
  noTuple(seen[4][1].tools)
  assert.equal(Array.isArray(frozen.tools[0].parameters.properties.blocks.items.properties.position.items), true)

  unwrapLlmForGoogleSchemas(llm)
  const again = { provider: 'google', model: 'g', tools: [placeTool()] }
  llm.stream(again)
  assert.equal(seen[5][1], again)
  assert.equal(Array.isArray(again.tools[0].parameters.properties.blocks.items.properties.position.items), true)
})

test('wrap again after another replacement still sanitizes', () => {
  const seen = []
  const llm = { stream(options) { seen.push(options) } }
  wrapLlmForGoogleSchemas(llm)
  function replaced(options) { seen.push(['inner', options]) }
  llm.stream = replaced
  wrapLlmForGoogleSchemas(llm)
  llm.stream({ provider: 'google', model: 'm', tools: [placeTool()] })
  assert.equal(seen[0][0], 'inner')
  noTuple(seen[0][1].tools)
})

test('llm/stream listener sanitizes writable google options and still continues when frozen', () => {
  let listener = null
  const ctx = {
    on(name, fn) { if (name === 'llm/stream') listener = fn; return () => { listener = null } },
    get() { return null },
    logger: {},
  }
  const guard = createGoogleSchemaGuard(ctx)
  guard.sync()
  guard.sync()
  assert.equal(typeof listener, 'function')
  const tool = placeTool()
  const tools = [tool]
  const options = { provider: 'vertex', model: 'm', tools }
  assert.equal(listener(options, () => 'next'), 'next')
  assert.notEqual(options.tools, tools)
  noTuple(options.tools)
  assert.equal(Array.isArray(tool.parameters.properties.blocks.items.properties.position.items), true)

  const other = { provider: 'xai', model: 'm', tools }
  assert.equal(listener(other, () => 1), 1)
  assert.equal(other.tools, tools)

  const frozen = Object.freeze({ provider: 'google', model: 'm', tools: [placeTool()] })
  let called = 0
  assert.equal(listener(frozen, () => { called++; return 7 }), 7)
  assert.equal(called, 1)
  assert.equal(Array.isArray(frozen.tools[0].parameters.properties.blocks.items.properties.position.items), true)
  assert.equal(applyGoogleToolSanitize({ provider: 'deepseek', tools: [tool] }), false)
  guard.dispose()
  assert.equal(listener, null)
})

test('guard wraps ctx.llm and injected llm', () => {
  const seen = []
  const llm = { stream(options) { seen.push(options) } }
  let injected = null
  const ctx = {
    llm,
    on() { return () => {} },
    get(name) { return name === 'llm' ? llm : null },
    inject(deps, fn) { injected = fn; return { dispose() { injected = null } } },
    logger: {},
  }
  const guard = createGoogleSchemaGuard(ctx)
  guard.sync()
  llm.stream({ provider: 'google', model: 'm', tools: [placeTool()] })
  noTuple(seen[0].tools)
  const late = { stream(options) { seen.push(['late', options]) } }
  injected({ get: (name) => (name === 'llm' ? late : null) })
  late.stream({ provider: 'google-vertex', model: 'm', tools: [placeTool()] })
  noTuple(seen[1][1].tools)
  guard.dispose()
  const raw = { provider: 'google', model: 'm', tools: [placeTool()] }
  llm.stream(raw)
  assert.equal(seen[2], raw)
})
