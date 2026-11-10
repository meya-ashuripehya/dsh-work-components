/**
 * Google / Vertex functionDeclarations cap (512): discovery mode instead of silent truncate.
 *
 * When googleToolCapEnabled (default true) and provider is google* and tools.length > 512:
 *   expose core (non-MCP) + find_tools + session pins + history-used tools.
 * When disabled: pass the full tool list (pre-discovery); may hit Vertex 512 again.
 * find_tools uses scene/exclusivity routing so windows MCP does not shadow desktop-control.
 *
 * Wraps llm.prepareCall + llm.stream (frozen options cannot be fixed in llm/stream waterfall).
 * Mounts find_tools via ctx.plugin + defineTool (same as notes/boards) so agent-loop can execute it.
 */
import { createPinStore } from './pins.mjs'
import { createSessionFindTools, SESSION_FIND_TOOLS_NAME } from './find-tools.mjs'
import { wrapLlmForGoogleToolCap } from './wrap.mjs'
import { VERTEX_FUNCTION_DECLARATIONS_CAP } from './expose.mjs'

export { VERTEX_FUNCTION_DECLARATIONS_CAP, selectExposedTools, isGoogleToolCapProvider } from './expose.mjs'
export { matchScenes, annotateCatalog, lexicalSceneMatch, suiteNamesForScenes, SUITE_CAP, SCENES } from './scenes.mjs'

export const GOOGLE_TOOL_CAP_KEYS = ['googleToolCapEnabled']

export function googleToolCapSettings(cfg) {
  return {
    enabled: cfg?.googleToolCapEnabled !== false,
  }
}

function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(name)
      if (v != null) return v
    }
  } catch {}
  try { return ctx?.[name] ?? null } catch { return null }
}

/** Resolve host markAgentLoopRequest without bundling (WeakSet must be the host copy). */
function resolveMarkAgentLoopRequest() {
  try {
    // Banner createRequire in lib/index.mjs; keep spec dynamic so esbuild does not bundle.
    const spec = ['@deepseek-ai', 'dsh-llm'].join('/')
    const req = typeof require === 'function' ? require : null
    if (!req) return null
    const mod = req(spec)
    return typeof mod?.markAgentLoopRequest === 'function' ? mod.markAgentLoopRequest : null
  } catch {
    return null
  }
}

export function createGoogleToolCapFeature(ctx, getConfig, extras = {}) {
  const log = ctx.logger ?? console
  const pins = createPinStore()
  const state = { status: 'off', detail: '未启用', gen: 0, fork: null }
  let disposed = false
  let snapshot = ''
  let registeredTool = null
  let injectFork = null
  let pendingInstall = false
  const wrappedLlms = new Set()
  const markAgentLoopRequest = resolveMarkAgentLoopRequest()

  function finderConfig() {
    const c = getConfig?.() || {}
    return {
      provider: String(c.chatroomToolFinderProvider || c.chatroomFinderProvider || c.finderProvider || 'deepseek').trim() || 'deepseek',
      model: String(c.chatroomToolFinderModel || c.chatroomFinderModel || c.finderModel || 'deepseek-flash').trim() || 'deepseek-flash',
    }
  }

  function wrapLlm(llm) {
    if (!llm || typeof llm.stream !== 'function') return false
    // Live getter: when googleToolCapEnabled flips off, rewrite becomes a no-op
    // (full tool list) without tearing down the llm.stream wrapper.
    wrapLlmForGoogleToolCap(llm, {
      pins,
      log,
      markAgentLoopRequest,
      isEnabled: () => googleToolCapSettings(getConfig()).enabled,
    })
    wrappedLlms.add(llm)
    return true
  }

  function registerFindTools(toolCtx) {
    const tools = toolCtx?.tools
    if (!tools || typeof tools.register !== 'function') return false
    try {
      const existing = typeof tools.get === 'function' ? tools.get(SESSION_FIND_TOOLS_NAME) : null
      if (existing && typeof existing.execute === 'function') {
        registeredTool = existing
        return true
      }
      const findTool = createSessionFindTools({
        getLlm: () => getService(ctx, 'llm'),
        getTools: () => getService(toolCtx, 'tools') || getService(ctx, 'tools') || tools,
        pins,
        getFinder: finderConfig,
        getSessionId: (exec) => exec?.agent?.id || exec?.sessionId || exec?.session?.id,
        maxPerFind: 3,
        groupLabels: () => extras.groupLabels || [],
      })
      tools.register(findTool)
      registeredTool = findTool
      return true
    } catch (e) {
      log.warn?.('dsh-workbench google-tool-cap: register find_tools failed', e?.message || e)
      return false
    }
  }

  function ensureLlmInject() {
    if (injectFork || typeof ctx.inject !== 'function') return
    try {
      injectFork = ctx.inject(['llm'], (sub) => {
        if (disposed || !pendingInstall) return
        const llm = getService(sub, 'llm') || getService(ctx, 'llm')
        wrapLlm(llm)
        if (registeredTool) {
          state.status = 'on'
          state.detail = '已启用 · discovery ≤' + VERTEX_FUNCTION_DECLARATIONS_CAP
        } else if (wrappedLlms.size) {
          state.status = 'on'
          state.detail = '已启用 · wrap only ≤' + VERTEX_FUNCTION_DECLARATIONS_CAP
        }
      })
    } catch (e) {
      log.warn?.('dsh-workbench google-tool-cap: llm inject failed', e?.name || e)
    }
  }

  async function stop() {
    pendingInstall = false
    const fork = state.fork
    state.fork = null
    registeredTool = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench google-tool-cap: stop fork failed', error?.name || 'error')
      }
    }
    // Keep wraps: re-wrapping is idempotent via WRAP_FLAG; clearing stream fn is unsafe.
  }

  async function sync() {
    if (disposed) return
    const s = googleToolCapSettings(getConfig())
    const snap = s.enabled ? 'on' : 'off'
    if (snap === snapshot && state.status === (s.enabled ? 'on' : 'off') && (!s.enabled || registeredTool)) return
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!s.enabled) {
      snapshot = snap
      state.status = 'off'
      state.detail = '未启用'
      return
    }

    pendingInstall = true
    const llm = getService(ctx, 'llm')
    wrapLlm(llm)
    ensureLlmInject()

    if (typeof ctx.plugin !== 'function') {
      snapshot = snap
      state.status = wrappedLlms.size ? 'on' : 'pending'
      state.detail = wrappedLlms.size
        ? ('已启用 · wrap only ≤' + VERTEX_FUNCTION_DECLARATIONS_CAP + '（无 ctx.plugin，find_tools 未注册）')
        : '等待 ctx.llm / ctx.plugin'
      return
    }

    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-google-tool-cap',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            registerFindTools(toolCtx)
          })
          // Also wrap llm from the fork if present.
          sub.inject(['llm'], (llmCtx) => {
            if (disposed || !pendingInstall) return
            wrapLlm(getService(llmCtx, 'llm') || getService(sub, 'llm'))
          })
        },
      })
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = 'find_tools 挂载失败'
      log.warn?.('dsh-workbench google-tool-cap: plugin start failed', error?.name || error)
      return
    }

    if (gen !== state.gen) {
      await stop()
      return
    }
    snapshot = snap
    if (registeredTool) {
      state.status = 'on'
      state.detail = '已启用 · discovery ≤' + VERTEX_FUNCTION_DECLARATIONS_CAP
    } else if (wrappedLlms.size) {
      state.status = 'on'
      state.detail = '已启用 · wrap only ≤' + VERTEX_FUNCTION_DECLARATIONS_CAP
    } else {
      state.status = 'pending'
      state.detail = '等待 ctx.llm / tools'
    }
  }

  return {
    sync,
    pins,
    state,
    async dispose() {
      disposed = true
      await stop()
      try { await injectFork?.dispose?.() } catch {}
      injectFork = null
      pins.clearAll()
      wrappedLlms.clear()
      state.status = 'off'
      state.detail = '已卸载'
    },
  }
}
