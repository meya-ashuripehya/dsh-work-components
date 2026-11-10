/**
 * Exact tool-group lookup shared by Google discovery find_tools and chatroom find_tools.
 *
 * A query matches only when, after trim and case-folding, it equals a name that is
 * actually registered: the MCP server id parsed from tool names, the `mcp__<server>`
 * namespace spelling, or a display name / id carried on the tool or on component
 * registration (label, title, id, serverName). Substrings do not match. No aliases
 * are invented.
 *
 * The full matched set is then limited only by a caller's admission budget. The
 * platform ceiling is Vertex/Gemini functionDeclarations (512). SUITE_CAP (48) and
 * the session pin default (64) are not applied here.
 */
import { mcpServerOf } from './scenes.mjs'
import { VERTEX_FUNCTION_DECLARATIONS_CAP, isMcpToolName } from './expose.mjs'

export { mcpServerOf }

const GROUP_META_FIELDS = ['serverName', 'namespace', 'group', 'serverTitle', 'serverLabel', 'groupTitle', 'groupLabel']

export function normalizeExactKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Display names and ids from component registration records.
 * `server` is the MCP server id those names refer to. Records without serverName are skipped.
 * @param {Array<{ id?: string, serverName?: string, label?: string, title?: string, meta?: { title?: string, label?: string } }>} records
 */
export function labelsFromRegistration(records) {
  const out = []
  for (const rec of records || []) {
    const server = String(rec?.serverName || '').trim()
    if (!server) continue
    const names = []
    for (const value of [rec.serverName, rec.id, rec.label, rec.title, rec.meta?.title, rec.meta?.label]) {
      const key = normalizeExactKey(value)
      if (key && !names.includes(key)) names.push(key)
    }
    out.push({ server, names })
  }
  return out
}

/**
 * How many MCP pins can still be sent with this schema list under the declaration cap.
 * Counts unique non-MCP tools other than find_tools, and always reserves find_tools itself,
 * matching selectExposedTools (core + find_tools, then pins).
 */
export function declarationRoom(schemas, { cap = VERTEX_FUNCTION_DECLARATIONS_CAP } = {}) {
  const seen = new Set()
  let core = 0
  for (const tool of schemas || []) {
    const name = String(tool?.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (name === 'find_tools' || isMcpToolName(name)) continue
    core++
  }
  const reserved = core + 1
  return { cap, core, reserved, room: Math.max(0, cap - reserved) }
}

function addKey(map, key, serverKey) {
  const k = normalizeExactKey(key)
  if (!k || !serverKey) return
  if (!map.has(k)) map.set(k, new Set())
  map.get(k).add(serverKey)
}

/**
 * @param {string} query
 * @param {Array<{ name: string }>} catalog enabled tools only
 * @param {{ labels?: Array<{ server: string, names: string[] }>, allow?: (name: string) => boolean }} [opts]
 * @returns {null | { matched: true, server: string, tools: string[], denied: string[], empty: boolean, ambiguous?: string[] }}
 *   null when the query is not an exact registered group name.
 */
export function exactGroupMatch(query, catalog, { labels = [], allow = null } = {}) {
  const q = normalizeExactKey(query)
  if (!q) return null

  /** @type {Map<string, { server: string, tools: string[] }>} */
  const groups = new Map()
  const ensure = (serverKey, display) => {
    if (!groups.has(serverKey)) groups.set(serverKey, { server: display || serverKey, tools: [] })
    return groups.get(serverKey)
  }

  const serverKeyOf = (tool) => {
    const parsed = mcpServerOf(tool?.name)
    if (parsed) return parsed
    return normalizeExactKey(tool?.serverName) || normalizeExactKey(tool?.namespace) || normalizeExactKey(tool?.group)
  }

  for (const tool of catalog || []) {
    const name = String(tool?.name || '').trim()
    if (!name) continue
    const serverKey = serverKeyOf(tool)
    if (!serverKey) continue
    const group = ensure(serverKey, mcpServerOf(name) || String(tool.serverName || tool.namespace || tool.group || serverKey))
    if (!group.tools.includes(name)) group.tools.push(name)
  }

  /** @type {Map<string, Set<string>>} */
  const keys = new Map()
  for (const [serverKey, group] of groups) {
    addKey(keys, serverKey, serverKey)
    addKey(keys, `mcp__${serverKey}`, serverKey)
    addKey(keys, `mcp__${serverKey}__`, serverKey)
    addKey(keys, group.server, serverKey)
  }
  for (const tool of catalog || []) {
    const serverKey = serverKeyOf(tool)
    if (!serverKey) continue
    for (const field of GROUP_META_FIELDS) addKey(keys, tool?.[field], serverKey)
  }
  for (const row of labels || []) {
    const serverKey = normalizeExactKey(row?.server)
    if (!serverKey) continue
    ensure(serverKey, String(row.server).trim())
    addKey(keys, row.server, serverKey)
    for (const name of row.names || []) addKey(keys, name, serverKey)
    addKey(keys, `mcp__${serverKey}`, serverKey)
    addKey(keys, `mcp__${serverKey}__`, serverKey)
  }

  if (!keys.has(q)) return null
  const hits = [...keys.get(q)]
  if (hits.length !== 1) {
    return { matched: true, ambiguous: hits.sort(), server: '', tools: [], denied: [], empty: true }
  }
  const serverKey = hits[0]
  const group = groups.get(serverKey) || { server: serverKey, tools: [] }
  const tools = []
  const denied = []
  for (const name of group.tools) {
    let permitted = true
    if (typeof allow === 'function') {
      try { permitted = allow(name) !== false } catch { permitted = false }
    }
    if (permitted) tools.push(name)
    else denied.push(name)
  }
  tools.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  denied.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { matched: true, server: group.server || serverKey, tools, denied, empty: tools.length === 0 }
}

/** English note when some matched tools were not pinned. Empty when nothing was omitted. */
export function declarationLimitNote({ cap, reserved, room, omitted } = {}) {
  const n = Number(omitted) || 0
  if (n <= 0) return ''
  return `Not pinned (${n}): functionDeclarations cap is ${cap}. ${reserved} declarations are reserved, leaving ${room} pin slots. Omitted tools were not added and are not callable.`
}
