/**
 * cross_session_list / cross_session_search tool registration (pull only).
 * Gate: OPEN_TOOLS naming + owner-authorized turn + Memory Circle (OPEN_TOOLS alone is not enough).
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { getActiveGate } from './telegram/owner-gate.mjs'
import {
  CAPS,
  LIST_NAME,
  SEARCH_NAME,
  TOOL_NAMES,
  DEFAULT_CONFIG,
  gateAllowsCrossSession,
  gateBumpCall,
  listPeers,
  loadBindings,
  normalizeConfig,
  searchPeers,
} from './cross-session-memory.mjs'

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function callerSessionId(exec) {
  return String(exec?.agent?.id || exec?.sessionId || '').trim()
}

function denyBudget() {
  return { text: `cross-session memory call budget exceeded (max ${CAPS.maxCallsPerTurn} calls/turn).` }
}

function denyAuth(reason) {
  return { text: reason || 'cross-session memory requires an owner-authorized turn' }
}

/**
 * @param {{
 *   getConfig?: () => any,
 *   bindingsFile?: string,
 *   loadBindingsFn?: () => object,
 *   getGate?: () => any,
 *   findSessionLogPath?: Function,
 *   readSessionLog?: Function,
 * }} [options]
 */
export function createCrossSessionTools(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => DEFAULT_CONFIG
  const getGate = typeof options.getGate === 'function' ? options.getGate : () => getActiveGate()
  const loadBindingsFn = typeof options.loadBindingsFn === 'function'
    ? options.loadBindingsFn
    : () => loadBindings(options.bindingsFile)

  function runtimeCtx(exec) {
    const cfgRaw = getConfig() || {}
    const nested = cfgRaw.crossSessionMemory && typeof cfgRaw.crossSessionMemory === 'object'
      ? cfgRaw.crossSessionMemory
      : cfgRaw
    return {
      bindings: loadBindingsFn(),
      bindingsFile: options.bindingsFile,
      config: normalizeConfig({
        enabled: cfgRaw.crossSessionMemoryEnabled !== false && nested.enabled !== false,
        ownerLinks: nested.ownerLinks,
        crossSessionAliases: cfgRaw.crossSessionAliases ?? nested.aliasesText,
        crossSessionOwnerTelegramIds: cfgRaw.crossSessionOwnerTelegramIds,
        crossSessionOwnerQqOpenIds: cfgRaw.crossSessionOwnerQqOpenIds,
        crossSessionPresets: cfgRaw.crossSessionPresets,
        crossSessionShareGroups: cfgRaw.crossSessionShareGroups,
        ...nested,
        ...cfgRaw,
      }),
      callerSessionId: callerSessionId(exec),
      findSessionLogPath: options.findSessionLogPath,
      readSessionLog: options.readSessionLog,
    }
  }

  function precheck(exec) {
    const sid = callerSessionId(exec)
    const gate = getGate()
    const auth = gateAllowsCrossSession(gate, sid)
    if (!auth.ok) return { error: denyAuth(auth.reason) }
    const n = gateBumpCall(gate, sid)
    if (n > CAPS.maxCallsPerTurn) return { error: denyBudget() }
    return { ctx: runtimeCtx(exec) }
  }

  const listTool = defineTool({
    name: LIST_NAME,
    description:
      'List other channel sessions you may recall from (QQ / Telegram Memory Circle). Pull only — never auto-injected. Each row labels person (dm) vs group and peer id. Filter by channel, conversationType (dm|group), peerId. No message bodies; use cross_session_search to read. Owner-authorized turns only.',
    parameters: {
      channel: { type: 'string', description: 'Optional: qq | telegram.' },
      conversationType: { type: 'string', description: 'Optional: dm (person) | group.' },
      peerId: { type: 'string', description: 'Optional: conversation / peer id (Telegram user or chat id, QQ OpenID / group OpenID).' },
      preset: { type: 'string', description: 'Optional: agent preset filter; default = caller preset.' },
      limit: { type: 'integer', description: `Max peers to list, 1-${CAPS.listLimitMax}, default ${CAPS.listLimitDefault}.` },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const check = precheck(exec)
      if (check.error) return check.error
      return listPeers(args || {}, check.ctx)
    },
  })

  const searchTool = defineTool({
    name: SEARCH_NAME,
    description:
      'Search history in other channel sessions (QQ ↔ Telegram Memory Circle). Pull only. Hits are labeled with channel, person/group, and peer id. Caps apply (sessions/hits/chars/tokens/calls). Strips harness tokens; omits reasoning and tools by default. Owner-authorized turns only. Prefer note_* for stable facts.',
    parameters: {
      sessionId: { type: 'string', description: 'Optional: one peer session id from cross_session_list. Omit to search up to 4 peers.' },
      query: { type: 'string', description: 'Keywords; case-insensitive; whitespace = AND (CJK OK). Required unless lastN or since/until or sessionId+lastN.' },
      lastN: { type: 'integer', description: `Optional: last N user/assistant messages per touched session, max ${CAPS.lastNMax}.` },
      since: { type: 'string', description: 'Optional ISO time lower bound.' },
      until: { type: 'string', description: 'Optional ISO time upper bound.' },
      role: { type: 'string', description: 'Optional: user | assistant | any (default any).' },
      channel: { type: 'string', description: 'Optional peer filter: qq | telegram.' },
      conversationType: { type: 'string', description: 'Optional peer filter: dm (person) | group.' },
      peerId: { type: 'string', description: 'Optional peer / conversation id filter.' },
      includeTools: { type: 'boolean', description: 'Default false. Include tool markers.' },
      includeReasoning: { type: 'boolean', description: 'Default false. Never return reasoning unless true.' },
      context: { type: 'integer', description: `Neighbour messages each side, 0-${CAPS.contextMax}, default 0.` },
      limit: { type: 'integer', description: `Max hits, 1-${CAPS.searchLimitMax}, default ${CAPS.searchLimitDefault}.` },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const check = precheck(exec)
      if (check.error) return check.error
      return searchPeers(args || {}, check.ctx)
    },
  })

  return [listTool, searchTool]
}

export { LIST_NAME, SEARCH_NAME, TOOL_NAMES, CAPS }
