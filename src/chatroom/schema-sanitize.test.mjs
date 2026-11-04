// 工具 schema 净化：元组 items 数组 → 单 schema + minItems/maxItems。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSchema, sanitizeToolSchemas } from './schema-sanitize.mjs'
import { toGeminiTools } from './gemini-seat.mjs'

const tuple3 = { type: 'array', minItems: 3, maxItems: 3, items: [{ type: 'integer' }, { type: 'integer' }, { type: 'integer' }] }

test('同类元组折叠为单个 schema', () => {
  const r = sanitizeSchema({ type: 'object', properties: { size: tuple3 } })
  assert.deepEqual(r.properties.size, { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer' } })
})

test('嵌套 items/properties 里的元组与 additionalItems/prefixItems', () => {
  const r = sanitizeSchema({ type: 'object', properties: { blocks: { type: 'array', items: { type: 'object', properties: { position: { type: 'array', items: [{ type: 'number' }, { type: 'number', description: 'y' }], additionalItems: false } } } } } })
  const p = r.properties.blocks.items.properties.position
  assert.deepEqual(p, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 })
  const q = sanitizeSchema({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] })
  assert.deepEqual(q.items, { anyOf: [{ type: 'string' }, { type: 'integer' }] })
  assert.equal(q.minItems, 2); assert.equal('prefixItems' in q, false)
})

test('anyOf / $defs / additionalProperties 递归，且不修改输入', () => {
  const src = { anyOf: [{ $defs: { v: tuple3 } }], additionalProperties: { items: [{ type: 'string' }] } }
  const copy = JSON.parse(JSON.stringify(src))
  const r = sanitizeSchema(src)
  assert.deepEqual(r.anyOf[0].$defs.v.items, { type: 'integer' })
  assert.deepEqual(r.additionalProperties.items, { type: 'string' })
  assert.deepEqual(src, copy)
  assert.ok(!JSON.stringify(sanitizeToolSchemas([{ name: 'mcp__deepslate__x', parameters: src }])).includes('"items":['))
})

test('sanitizeToolSchemas also cleans inputSchema/input_schema', () => {
  const tuple = { type: 'array', items: [{ type: 'number' }, { type: 'number' }] }
  const [a] = sanitizeToolSchemas([{ name: 'x', inputSchema: { type: 'object', properties: { position: tuple } } }])
  const [b] = sanitizeToolSchemas([{ name: 'y', input_schema: { type: 'object', properties: { position: tuple } } }])
  assert.deepEqual(a.inputSchema.properties.position.items, { type: 'number' })
  assert.deepEqual(b.input_schema.properties.position.items, { type: 'number' })
})

test('toGeminiTools sanitizes nested tuple items (Gemini 400)', () => {
  const tools = [{
    name: 'mcp__deepslate__place',
    description: 'place',
    parameters: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              position: { type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }] },
            },
          },
        },
      },
    },
  }]
  const decls = toGeminiTools(tools)[0].functionDeclarations[0]
  const items = decls.parametersJsonSchema.properties.blocks.items.properties.position.items
  assert.equal(Array.isArray(items), false)
  assert.deepEqual(items, { type: 'number' })
})
