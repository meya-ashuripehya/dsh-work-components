/**
 * Pure selection of which tools to send when a provider hard-caps declarations
 * (Google / Vertex: 512 functionDeclarations). Prefer discovery (core + find_tools
 * + session pins + history-used) over silent truncate.
 */

export const VERTEX_FUNCTION_DECLARATIONS_CAP = 512

/** Providers that undefer everything (toolUpdate undefined) and hit Vertex/Gemini 512. */
export function isGoogleToolCapProvider(provider) {
  const p = String(provider || '').toLowerCase()
  return p === 'google' || p === 'google-vertex' || p === 'google-gemini' || p.startsWith('google-')
}

export function isMcpToolName(name) {
  return /^mcp__/i.test(String(name || ''))
}

/**
 * Collect tool names already referenced in the request transcript (so multi-step
 * calls keep working after we shrink the declaration set).
 * @param {Array<{role?:string, content?:any}>} [messages]
 */
export function historyUsedToolNames(messages) {
  const out = new Set()
  if (!Array.isArray(messages)) return out
  for (const m of messages) {
    const c = m?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'toolCall' || b.type === 'tool-call' || b.type === 'functionCall' || b.type === 'function_call') {
        const n = b.name || b.toolName || b.function?.name
        if (typeof n === 'string' && n) out.add(n)
      }
      if (b.type === 'toolResult' || b.type === 'tool-result' || b.type === 'functionResponse') {
        const n = b.name || b.toolName
        if (typeof n === 'string' && n) out.add(n)
      }
    }
  }
  return out
}

/**
 * Final safety: never return more than cap tools for a google* provider in
 * discovery mode (core-alone overflow, bad pins, etc.).
 */
export function assertUnderCap(tools, cap = VERTEX_FUNCTION_DECLARATIONS_CAP) {
  if (!Array.isArray(tools) || tools.length <= cap) return tools
  return tools.slice(0, cap)
}

/**
 * @param {object} opts
 * @param {Array<{name:string}>} opts.tools - full tool schemas for this request
 * @param {string} opts.provider
 * @param {number} [opts.cap=512]
 * @param {string[]} [opts.pins] - session-pinned names (from find_tools)
 * @param {Iterable<string>} [opts.historyUsed]
 * @param {{name:string, description?:string, parameters?:object}} [opts.findToolsSchema] - inject if missing
 * @returns {{ tools: typeof opts.tools, mode: 'passthrough'|'discovery', dropped: number, kept: number }}
 */
export function selectExposedTools({
  tools,
  provider,
  cap = VERTEX_FUNCTION_DECLARATIONS_CAP,
  pins = [],
  historyUsed = [],
  findToolsSchema = null,
  findToolsName = 'find_tools',
} = {}) {
  const list = Array.isArray(tools) ? tools : []
  if (!isGoogleToolCapProvider(provider) || list.length <= cap) {
    return { tools: list, mode: 'passthrough', dropped: 0, kept: list.length }
  }

  const byName = new Map()
  for (const t of list) {
    if (t && typeof t.name === 'string' && !byName.has(t.name)) byName.set(t.name, t)
  }
  if (findToolsSchema && typeof findToolsSchema.name === 'string' && !byName.has(findToolsSchema.name)) {
    byName.set(findToolsSchema.name, findToolsSchema)
  }

  const must = new Set()
  // Core: non-MCP always kept (bash, fs, web, …)
  for (const name of byName.keys()) {
    if (!isMcpToolName(name)) must.add(name)
  }
  must.add(findToolsName)
  for (const n of pins || []) if (typeof n === 'string' && n) must.add(n)
  for (const n of historyUsed || []) if (typeof n === 'string' && n) must.add(n)

  const exposed = []
  const seen = new Set()
  const push = (name) => {
    if (!name || seen.has(name) || exposed.length >= cap) return
    const t = byName.get(name)
    if (!t) return
    seen.add(name)
    exposed.push(t)
  }

  // Order: find_tools first (discoverability), then other core, then pins/history, then nothing else
  push(findToolsName)
  for (const name of [...must].sort()) {
    if (name === findToolsName) continue
    if (!isMcpToolName(name)) push(name)
  }
  for (const name of pins || []) push(name)
  for (const name of historyUsed || []) push(name)

  // If still under cap after must-haves, do NOT fill with random MCP — discovery only.
  // (Filling would recreate the shadowing problem and burn the budget on generalists.)

  const finalTools = assertUnderCap(exposed, cap)
  return {
    tools: finalTools,
    mode: 'discovery',
    dropped: Math.max(0, byName.size - finalTools.length),
    kept: finalTools.length,
  }
}
