/**
 * Session-scoped find_tools for Google discovery mode.
 * Reuses chatroom selectTools but annotates catalog with scene exclusivity
 * so overlapping generalists (windows) do not permanently shadow specialists (desktop).
 *
 * Registered as a real host tool (defineTool) so agent-loop can execute it;
 * SESSION_FIND_TOOLS stays the schema stub inject into Vertex functionDeclarations.
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import { selectTools, listCatalog, lexicalCurrentMatch } from '../chatroom/tool-selector.mjs'
import { matchScenes, annotateCatalog, lexicalSceneMatch, suiteNamesForScenes } from './scenes.mjs'

export const SESSION_FIND_TOOLS_NAME = 'find_tools'

export const SESSION_FIND_TOOLS = {
  name: SESSION_FIND_TOOLS_NAME,
  description:
    'Search the DSH tool catalog (including MCP servers) for tools that match a capability. ' +
    'Use when none of your currently listed tools cover the task — especially specialized desktop UI, browser, or OS tools that may be hidden under the Google 512-tool cap. ' +
    'Describe what you need in plain words. Matching tools are pinned for this session and become callable on the next step. When the query matches a scene (e.g. browser/desktop/windows), the full preferServers suite is pinned; otherwise up to 3 tools from LLM/lexical pick. ' +
    'Prefer calling find_tools before claiming a capability is unavailable.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you need a tool for, e.g. "click a button on the desktop" or "run PowerShell".',
      },
    },
    required: ['query'],
  },
}

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      text: { type: 'string', required: true },
      ok: { type: 'boolean' },
      query: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      added: { type: 'array', items: { type: 'string' } },
      pins: { type: 'array', items: { type: 'string' } },
      scenes: { type: 'array', items: { type: 'string' } },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function callerSessionId(exec) {
  return String(exec?.agent?.id || exec?.sessionId || exec?.session?.id || '').trim() || undefined
}

/**
 * @param {object} deps
 * @param {() => any} deps.getLlm
 * @param {() => any} deps.getTools - host tools registry
 * @param {ReturnType<import('./pins.mjs').createPinStore>} deps.pins
 * @param {() => { provider: string, model: string }} deps.getFinder
 * @param {(exec?: any) => string|undefined} [deps.getSessionId]
 * @param {number} [deps.maxPerFind=3]
 */
export function createSessionFindTools(deps) {
  const maxPerFind = Math.max(1, Math.min(5, deps.maxPerFind ?? 3))

  async function run(args, exec = {}) {
    const query = String(args?.query || '').trim()
    if (!query) return { text: 'find_tools needs a non-empty query.', ok: false }

    const toolsSvc = deps.getTools?.()
    const catalog = listCatalog(toolsSvc)
    if (!catalog.length) {
      return { text: 'Tool catalog is empty or unreadable.', ok: false, query }
    }

    const sessionId = (deps.getSessionId?.(exec) ?? callerSessionId(exec)) || undefined
    const current = deps.pins.list(sessionId)
    const scenes = matchScenes(query, { current })
    const { catalog: annotated, hints } = annotateCatalog(catalog, scenes)

    // Scene hit → pin full preferServers suite (bypass maxPerFind / top-3).
    const suite = suiteNamesForScenes(catalog, scenes)
    let sel = { tools: [], reason: '', error: '' }
    if (scenes.length && suite.length) {
      sel = { tools: suite, reason: 'scene suite expand', error: '' }
    } else {
      const finder = deps.getFinder?.() || {}
      const llm = deps.getLlm?.()
      if (llm && finder.provider && finder.model) {
        try {
          sel = await selectTools({
            llm,
            provider: finder.provider,
            model: finder.model,
            query,
            catalog: annotated,
            current,
            max: maxPerFind,
            hints,
            signal: exec?.signal,
          })
        } catch (e) {
          if (exec?.signal?.aborted || e?.aborted) throw e
          sel = { tools: [], reason: '', error: String(e?.message || e) }
        }
      }

      if (!sel.tools?.length) {
        const lex = lexicalSceneMatch(query, catalog, scenes, maxPerFind)
        if (lex.length) sel = { tools: lex, reason: sel.reason || 'lexical scene fallback', error: sel.error }
        else {
          const curLex = lexicalCurrentMatch(query, current, maxPerFind)
          if (curLex.length) sel = { tools: curLex, reason: 'lexical current fallback', error: sel.error }
        }
      }
    }

    if (!sel.tools?.length) {
      const hint = scenes.length ? ` (scenes: ${scenes.map((s) => s.id).join(', ')})` : ''
      return {
        text: `No suitable tools found for "${query.slice(0, 120)}"${hint}${sel.error ? ' — ' + sel.error : ''}. Try a more specific capability description.`,
        ok: true,
        query,
        tools: [],
        scenes: scenes.map((s) => s.id),
      }
    }

    const { added, pins } = deps.pins.add(sessionId, sel.tools)
    const byName = new Map(catalog.map((t) => [t.name, t]))
    const lines = sel.tools.map((n) => {
      const d = String(byName.get(n)?.description || '').replace(/\s+/g, ' ').slice(0, 240)
      const pin = added.includes(n) ? ' (newly pinned)' : ' (already pinned)'
      return `- ${n}${pin}: ${d}`
    })
    const sceneNote = scenes.length
      ? `\nScene routing: ${scenes.map((s) => s.id).join(', ')} — specialists preferred over overlapping generalists.`
      : ''
    const text =
      `Pinned for this session (${pins.length} total). Call them on the next step:` +
      `\n${lines.join('\n')}` +
      (sel.reason ? `\nReason: ${sel.reason}` : '') +
      sceneNote

    return {
      text,
      ok: true,
      query,
      tools: sel.tools,
      added,
      pins,
      scenes: scenes.map((s) => s.id),
    }
  }

  return defineTool({
    name: SESSION_FIND_TOOLS_NAME,
    description: SESSION_FIND_TOOLS.description,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What you need a tool for, e.g. "click a button on the desktop" or "run PowerShell".',
      },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return run(args, exec || {})
    },
  })
}
