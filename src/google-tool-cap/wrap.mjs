/**
 * Wrap llm.prepareCall + llm.stream / streamWithRegistration so Google/Vertex
 * requests never send >512 functionDeclarations — when discovery mode is on.
 *
 * Critical: agent-loop calls prepareCall WITHOUT tools, then
 * preparedCall.stream(request) with the full tool list. callConfigEquals does
 * not include tools, so we MUST rewrite on the prepared stream path too —
 * skipping rewrite when prepared != null was the bug that left 745 tools on Vertex.
 *
 * When googleToolCapEnabled is off, rewriteOptions is a no-op (pre-discovery:
 * pass the full tool list). That can hit Vertex's 512 functionDeclarations
 * limit again (INVALID_ARGUMENT / 400).
 */
import {
  selectExposedTools,
  historyUsedToolNames,
  VERTEX_FUNCTION_DECLARATIONS_CAP,
  isGoogleToolCapProvider,
} from './expose.mjs'
import { SESSION_FIND_TOOLS } from './find-tools.mjs'
import { sanitizeToolSchemas } from '../chatroom/schema-sanitize.mjs'

const WRAP_FLAG = '__dshGoogleToolCapWrap'

function hardCapTools(tools, cap, log) {
  if (!Array.isArray(tools) || tools.length <= cap) return tools
  log?.error?.(
    `dsh-workbench google-tool-cap: HARD CAP slice ${tools.length} → ${cap} (safety net)`,
  )
  return tools.slice(0, cap)
}

function preserveAgentLoopMark(original, next, markAgentLoopRequest) {
  if (!next || next === original || typeof markAgentLoopRequest !== 'function') return next
  try { markAgentLoopRequest(next) } catch {}
  return next
}

function discoveryEnabled(deps) {
  const v = deps?.isEnabled
  if (typeof v === 'function') {
    try { return v() !== false } catch { return true }
  }
  if (v === false) return false
  return true
}

/** Rough UTF-8 / JSON size of transcript for latency diagnostics. */
function approxMessagesBytes(messages) {
  if (!Array.isArray(messages)) return 0
  try {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8')
  } catch {
    return -1
  }
}

/** True when the latest message content is mostly tool results (post-tool continuation). */
function isPostToolContinuation(messages) {
  if (!Array.isArray(messages) || !messages.length) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const c = m?.content
    if (!Array.isArray(c) || !c.length) continue
    let toolish = 0
    let other = 0
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      const t = b.type
      if (t === 'toolResult' || t === 'tool-result' || t === 'functionResponse') toolish++
      else if (t === 'toolCall' || t === 'tool-call' || t === 'functionCall' || t === 'function_call') toolish++
      else other++
    }
    if (toolish > 0 && toolish >= other) return true
    if (other > 0) return false
  }
  return false
}

/**
 * Wrap stream return so we log TTFT (first chunk) for Google post-tool turns.
 * Supports async iterables and thenables that resolve to them.
 */
function instrumentStreamResult(result, meta, log) {
  if (!result || !log) return result

  const markFirst = () => {
    if (meta.firstAt) return
    meta.firstAt = Date.now()
    const ttft = meta.firstAt - meta.t0
    log.warn?.(
      `dsh-workbench google-tool-cap: LATENCY first_chunk_ms=${ttft} postTool=${meta.postTool} tools=${meta.toolCount} msgs=${meta.msgCount} msgBytes≈${meta.msgBytes} provider=${meta.provider} session=${meta.sessionId || '-'}`,
    )
  }

  const wrapAsyncIter = (iter) => ({
    [Symbol.asyncIterator]() {
      const it = iter[Symbol.asyncIterator]()
      return {
        async next() {
          const n = await it.next()
          if (!n.done) markFirst()
          return n
        },
        async return(v) {
          return typeof it.return === 'function' ? it.return(v) : { done: true, value: v }
        },
        async throw(e) {
          if (typeof it.throw === 'function') return it.throw(e)
          throw e
        },
      }
    },
  })

  if (typeof result[Symbol.asyncIterator] === 'function') {
    return wrapAsyncIter(result)
  }
  if (typeof result.then === 'function') {
    return result.then((resolved) => {
      if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
        return wrapAsyncIter(resolved)
      }
      markFirst()
      return resolved
    })
  }
  markFirst()
  return result
}

function withLatencyProbe(streamFn, options, log) {
  const provider = String(options?.provider || '')
  if (!isGoogleToolCapProvider(provider)) return streamFn(options)

  const messages = options?.messages
  const tools = options?.tools
  const postTool = isPostToolContinuation(messages)
  const meta = {
    t0: Date.now(),
    firstAt: 0,
    postTool,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    msgCount: Array.isArray(messages) ? messages.length : 0,
    msgBytes: approxMessagesBytes(messages),
    provider,
    sessionId: options?.sessionId,
  }
  log?.warn?.(
    `dsh-workbench google-tool-cap: LATENCY stream_start postTool=${postTool} tools=${meta.toolCount} msgs=${meta.msgCount} msgBytes≈${meta.msgBytes} provider=${provider} session=${meta.sessionId || '-'}`,
  )

  try {
    const out = streamFn(options)
    return instrumentStreamResult(out, meta, log)
  } catch (e) {
    log?.warn?.(
      `dsh-workbench google-tool-cap: LATENCY stream_throw_ms=${Date.now() - meta.t0} postTool=${postTool} err=${e?.message || e}`,
    )
    throw e
  }
}

export function rewriteOptions(options, { pins, log, markAgentLoopRequest, isEnabled } = {}) {
  if (!options || !isGoogleToolCapProvider(options.provider)) return options
  const tools = options.tools
  if (!Array.isArray(tools)) return options

  let nextTools = tools
  // Setting off = pre-discovery: pass all available tools (may exceed Vertex 512).
  // Still sanitize schemas below so Gemini/Vertex never see tuple items arrays.
  if (discoveryEnabled({ isEnabled }) && tools.length > VERTEX_FUNCTION_DECLARATIONS_CAP) {
    const sessionId = options.sessionId
    const pinList = pins?.list?.(sessionId) || []
    const used = historyUsedToolNames(options.messages)
    const { tools: selected, mode, dropped, kept } = selectExposedTools({
      tools,
      provider: options.provider,
      cap: VERTEX_FUNCTION_DECLARATIONS_CAP,
      pins: pinList,
      historyUsed: used,
      findToolsSchema: SESSION_FIND_TOOLS,
    })
    if (mode !== 'passthrough') {
      nextTools = hardCapTools(selected, VERTEX_FUNCTION_DECLARATIONS_CAP, log)
      log?.warn?.(
        `dsh-workbench google-tool-cap: discovery mode provider=${options.provider} kept=${kept} dropped=${dropped} pins=${pinList.length} sent=${nextTools.length}`,
      )
    }
  }

  nextTools = sanitizeToolSchemas(nextTools)

  // Prefer in-place mutation so the agent-loop WeakSet mark stays on the same object.
  if (!Object.isFrozen(options)) {
    try {
      options.tools = nextTools
      return options
    } catch {}
  }
  const next = { ...options, tools: nextTools }
  return preserveAgentLoopMark(options, next, markAgentLoopRequest)
}

/**
 * @param {object} llm
 * @param {{ pins: ReturnType<import('./pins.mjs').createPinStore>, log?: any, markAgentLoopRequest?: Function, isEnabled?: boolean|(() => boolean) }} deps
 */
export function wrapLlmForGoogleToolCap(llm, deps) {
  if (!llm || typeof llm.stream !== 'function') return false
  if (llm[WRAP_FLAG] && llm.stream === llm[WRAP_FLAG]) return true

  const log = deps.log
  const pins = deps.pins
  const markAgentLoopRequest = deps.markAgentLoopRequest
  const isEnabled = deps.isEnabled
  const rewrite = (options) => rewriteOptions(options, { pins, log, markAgentLoopRequest, isEnabled })

  const boundStream = llm.stream.bind(llm)
  const boundPrepare = typeof llm.prepareCall === 'function' ? llm.prepareCall.bind(llm) : null
  const boundReg = typeof llm.streamWithRegistration === 'function'
    ? llm.streamWithRegistration.bind(llm)
    : null

  function cappedStream(options) {
    const rewritten = rewrite(options)
    return withLatencyProbe(boundStream, rewritten, log)
  }

  async function cappedPrepareCall(config, signal, configure) {
    // prepareCall usually has no tools yet (agent-loop attaches them later).
    // Still rewrite if present; always wrap the returned stream entrypoint.
    const prepared = boundPrepare
      ? await boundPrepare(rewrite(config), signal, configure)
      : null
    if (!prepared || typeof prepared.stream !== 'function') return prepared
    const innerStream = prepared.stream.bind(prepared)
    return Object.freeze({
      ...prepared,
      stream: (options) => {
        const rewritten = rewrite(options)
        return withLatencyProbe(innerStream, rewritten, log)
      },
      ...(typeof prepared.configure === 'function'
        ? { configure: prepared.configure.bind(prepared) }
        : {}),
    })
  }

  llm.stream = cappedStream
  llm[WRAP_FLAG] = cappedStream
  if (boundPrepare) llm.prepareCall = cappedPrepareCall

  // Always rewrite options — even when a prepared call is passed through.
  if (boundReg) {
    llm.streamWithRegistration = function streamWithRegistration(options, prepared) {
      const rewritten = rewrite(options)
      return withLatencyProbe((opts) => boundReg(opts, prepared), rewritten, log)
    }
  }
  return true
}

export function unwrapLlmGoogleToolCap(llm) {
  if (!llm || !llm[WRAP_FLAG]) return false
  delete llm[WRAP_FLAG]
  return true
}

export { rewriteOptions as rewriteOptionsForTest, hardCapTools as hardCapToolsForTest }
