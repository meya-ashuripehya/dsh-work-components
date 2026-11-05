/**
 * 工具参数 JSON Schema 兼容化：把 draft-04 元组写法 items: [...]（zod-to-json-schema 的 tuple）
 * 改写为单个 schema + minItems/maxItems，并去掉 prefixItems / additionalItems。
 * xAI / Gemini / Claude 都拒绝数组形式的 items（Gemini / Vertex 会回 HTTP 400：
 * items must be a boolean or an object）。纯函数，不修改输入。
 *
 * 工具对象上可能出现的 schema 字段：parameters、inputSchema、input_schema、parametersJsonSchema。
 * 聊天室目录、toGeminiTools、以及 google-schema 对宿主 llm.stream / prepareCall 的改写都走这里。
 */
const MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions']
const LIST_KEYS = ['anyOf', 'oneOf', 'allOf']
const ONE_KEYS = ['additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']

function mergeTuple(list) {
  const parts = list.map((x) => sanitizeSchema(x)).filter((x) => x !== undefined)
  if (!parts.length) return {}
  const keys = parts.map((p) => JSON.stringify(p))
  if (keys.every((k) => k === keys[0])) return parts[0]
  const types = parts.map((p) => (p && typeof p === 'object' && typeof p.type === 'string' ? p.type : null))
  if (types[0] && types.every((t) => t === types[0])) return { type: types[0] }
  return { anyOf: parts.filter((p, i) => keys.indexOf(keys[i]) === i) }
}

export function sanitizeSchema(s) {
  if (Array.isArray(s)) return s.map(sanitizeSchema)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalItems' || k === 'prefixItems') continue
    if (MAP_KEYS.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, sanitizeSchema(x)]))
    } else if (LIST_KEYS.includes(k) && Array.isArray(v)) out[k] = v.map(sanitizeSchema)
    else if (ONE_KEYS.includes(k) && v && typeof v === 'object') out[k] = sanitizeSchema(v)
    else if (k === 'items') out[k] = Array.isArray(v) ? mergeTuple(v) : sanitizeSchema(v)
    else out[k] = v
  }
  const tuple = Array.isArray(s.items) ? s.items : (Array.isArray(s.prefixItems) ? s.prefixItems : null)
  if (tuple) {
    if (!Array.isArray(s.items)) out.items = mergeTuple(tuple)
    if (out.minItems === undefined) out.minItems = tuple.length
    if (out.maxItems === undefined && s.additionalItems !== true && (s.additionalItems !== undefined || Array.isArray(s.items) || s.items === false || s.items === undefined)) out.maxItems = tuple.length
  }
  return out
}

/** 工具定义上需要折叠元组的 schema 字段（DSH parameters、MCP inputSchema、Anthropic input_schema、Gemini parametersJsonSchema）。 */
export const TOOL_SCHEMA_KEYS = ['parameters', 'inputSchema', 'input_schema', 'parametersJsonSchema']

function isSchemaValue(v) {
  return !!v && typeof v === 'object'
}

/**
 * 对工具定义列表逐个净化 schema 字段。没有这些字段的条目原样返回。
 * 非数组输入原样返回。不修改输入工具对象。
 */
export function sanitizeToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t
    let touch = false
    const patch = {}
    for (const key of TOOL_SCHEMA_KEYS) {
      if (!isSchemaValue(t[key])) continue
      patch[key] = sanitizeSchema(t[key])
      touch = true
    }
    return touch ? { ...t, ...patch } : t
  })
}