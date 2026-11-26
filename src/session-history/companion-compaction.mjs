/**
 * Companion-oriented override of official DSH compaction instruction.
 *
 * Official @deepseek-ai/dsh-compaction-basic freezes a coding-assistant
 * COMPACTION_INSTRUCTION inside summarizeWithLlm (purpose: "compaction").
 * Wrapping workbench ctx.llm alone is unreliable (different fork / timing).
 * We therefore:
 *  1) patch ctx.compaction.summarize so each summary temporarily wraps THAT
 *     engine's ctx.llm.stream;
 *  2) also wrap any reachable llm.stream as a belt-and-suspenders;
 *  3) rewrite when purpose==="compaction" OR the last user message looks like
 *     the official coding instruction.
 */
import { COMPANION_COMPACTION_INSTRUCTION } from './companion-instruction.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MARKER_OFFICIAL_A = 'AI coding assistant'
const MARKER_OFFICIAL_B = '## Primary Request and Intent'
const WRAP_FLAG = '__dshCompanionCompactionWrap'
const SUMMARIZE_FLAG = '__dshCompanionSummarizeOrig'
const DEBUG_DIR = join(homedir(), '.dsh', 'data', 'dsh-work-components')
const DEBUG_LOG = join(DEBUG_DIR, 'companion-compaction.log')

let debugSink = null

/** Tests capture lines here. Production keeps the file log. Never pass instruction or transcript text. */
export function setCompanionCompactionDebugSink(sink) {
  debugSink = typeof sink === 'function' ? sink : null
}

function debugLog(line) {
  const text = String(line)
  if (debugSink) {
    try { debugSink(text) } catch {}
    return
  }
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${text}\n`)
  } catch {}
}

/** `off` when disabled, `custom` when the textarea has non-whitespace text, else `default`. */
export function instructionSourceOf(cfg) {
  if (!isCompanionCompactionEnabled(cfg)) return 'off'
  const custom = typeof cfg?.companionCompactionInstruction === 'string' && cfg.companionCompactionInstruction.trim()
  return custom ? 'custom' : 'default'
}

/**
 * Badge for the settings list. Text names the phase and the instruction
 * source category. It does not include the instruction body.
 */
export function companionStatusBadge(runtime, cfg) {
  if (cfg?.companionCompactionEnabled === false) {
    return { text: '未启用', cls: 'off', title: runtime?.detail || '' }
  }
  const source = runtime?.instructionSource === 'custom' ? '自定义指令' : '内置指令'
  const title = runtime?.detail || ''
  switch (runtime?.phase) {
    case 'pending':
      return { text: '等待压缩引擎', cls: 'busy', title }
    case 'miss':
      return { text: '已安装但未命中', cls: 'error', title }
    case 'hit':
      return { text: '已命中 · ' + source, cls: 'on', title }
    case 'installed':
      return { text: '已安装 · ' + source, cls: 'on', title }
    case 'off':
      return { text: '未启用', cls: 'off', title }
    default:
      return { text: '未安装', cls: 'error', title: title || '启动后尚未安装陪伴压缩包装' }
  }
}

/** Resolve instruction text: non-empty config override wins, else built-in. */
export function resolveCompanionInstruction(cfg) {
  const custom = typeof cfg?.companionCompactionInstruction === 'string'
    ? cfg.companionCompactionInstruction.trim()
    : ''
  return custom || COMPANION_COMPACTION_INSTRUCTION
}

/** Default ON when key missing. */
export function isCompanionCompactionEnabled(cfg) {
  return cfg?.companionCompactionEnabled !== false
}

/**
 * Replace the last user message's text with `instruction`.
 * Returns a new messages array; does not mutate deepFrozen content blocks.
 * If there is no trailing user message, appends one.
 */
export function rewriteCompactionMessages(messages, instruction) {
  const list = Array.isArray(messages) ? messages : []
  const text = String(instruction ?? '')
  const newUser = {
    role: 'user',
    content: [{ type: 'text', text }],
  }
  if (!list.length) return [newUser]
  let lastUser = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return [...list, newUser]
  const out = list.slice()
  out[lastUser] = newUser
  return out
}

/** Optional safety: looks like official coding instruction. */
export function looksLikeOfficialCompactionInstruction(text) {
  const s = String(text || '')
  return s.includes(MARKER_OFFICIAL_A) || s.includes(MARKER_OFFICIAL_B)
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
    }
    return ''
  }
  return ''
}

/**
 * Pure options rewrite for tests / stream wrap.
 * Touches purpose === 'compaction' OR last-user official coding markers.
 * Returns same options reference if untouched.
 */
export function applyCompanionCompactionOptions(options, instruction) {
  if (!options) return options
  const purposeHit = options.purpose === 'compaction'
  const markerHit = looksLikeOfficialCompactionInstruction(lastUserText(options.messages))
  if (!purposeHit && !markerHit) return options
  const nextMessages = rewriteCompactionMessages(options.messages, instruction)
  if (nextMessages === options.messages) return options
  return { ...options, messages: nextMessages }
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

function wrapStreamOnLlm(llm, getConfig, log, tag, note) {
  if (!llm || typeof llm.stream !== 'function') return false
  if (llm.stream?.__dshCompanionCompaction === true && llm[WRAP_FLAG]) return true
  const raw = llm.stream
  const bound = raw.bind(llm)
  function companionCompactionStream(options) {
    try {
      const cfg = getConfig() || {}
      if (isCompanionCompactionEnabled(cfg)) {
        const purposeHit = options?.purpose === 'compaction'
        const markerHit = looksLikeOfficialCompactionInstruction(lastUserText(options?.messages))
        if (purposeHit || markerHit) {
          const instruction = resolveCompanionInstruction(cfg)
          const rewritten = applyCompanionCompactionOptions(options, instruction)
          const source = instructionSourceOf(cfg)
          debugLog(`phase=hit via=stream tag=${tag} source=${source} purpose=${purposeHit} marker=${markerHit}`)
          log.info?.(`dsh-workbench: companion compaction instruction applied (${tag}, ${source})`)
          note?.({ kind: 'hit', via: 'stream', tag, source })
          return bound(rewritten)
        }
      }
    } catch (error) {
      debugLog(`stream-wrap error tag=${tag} ${error?.name || error}`)
      log.warn?.('dsh-workbench: companion compaction rewrite failed, using original', error?.name || 'error')
    }
    return bound(options)
  }
  companionCompactionStream.__dshCompanionCompaction = true
  llm.stream = companionCompactionStream
  llm[WRAP_FLAG] = raw
  debugLog(`phase=installed via=stream tag=${tag}`)
  return true
}

function unwrapStreamOnLlm(llm) {
  if (!llm || !llm[WRAP_FLAG]) return
  try {
    llm.stream = llm[WRAP_FLAG]
    delete llm[WRAP_FLAG]
  } catch {}
}

/**
 * Patch compaction.summarize: for each call, wrap THAT engine's ctx.llm.stream
 * around the original summarize (guarantees we hit the same llm summarizeWithLlm uses).
 */
function patchSummarize(engine, getConfig, log, note) {
  if (!engine || typeof engine.summarize !== 'function') return false
  if (engine[SUMMARIZE_FLAG]) return true
  const raw = engine.summarize
  const original = raw.bind(engine)
  engine[SUMMARIZE_FLAG] = raw
  engine.summarize = async function companionSummarize(input, agent, signal) {
    const cfg = getConfig() || {}
    if (!isCompanionCompactionEnabled(cfg)) {
      return original(input, agent, signal)
    }
    const llm = getService(this.ctx, 'llm') || this.ctx?.llm
    const instruction = resolveCompanionInstruction(cfg)
    const source = instructionSourceOf(cfg)
    let installedHere = false
    let nestedHit = false
    let prev = null
    let prevFn = null
    if (llm && typeof llm.stream === 'function') {
      // Chain through the stream this engine actually calls. A closed-over
      // stream on another object is reported as a miss after the call returns.
      // If a permanent wrap is already on this function, it records the hit.
      prevFn = llm.stream
      const prevWasWrap = prevFn.__dshCompanionCompaction === true
      prev = prevFn.bind(llm)
      llm.stream = function (options) {
        try {
          const purposeHit = options?.purpose === 'compaction'
          const markerHit = looksLikeOfficialCompactionInstruction(lastUserText(options?.messages))
          if (purposeHit || markerHit) {
            nestedHit = true
            if (!prevWasWrap) {
              debugLog(`phase=hit via=summarize source=${source} purpose=${purposeHit} marker=${markerHit}`)
              note?.({ kind: 'hit', via: 'summarize', tag: 'engine.summarize', source })
            } else {
              debugLog(`summarize-nested forwarded source=${source}`)
            }
            return prev(applyCompanionCompactionOptions(options, instruction))
          }
        } catch (error) {
          debugLog(`summarize-nested error ${error?.name || error}`)
        }
        return prev(options)
      }
      installedHere = true
    } else {
      debugLog('phase=miss via=summarize-no-llm')
    }
    try {
      debugLog('summarize entered')
      return await original(input, agent, signal)
    } finally {
      if (installedHere && prevFn) {
        try { llm.stream = prevFn } catch {}
      }
      if (!nestedHit) {
        debugLog(`phase=miss via=${installedHere ? 'summarize' : 'summarize-no-llm'} source=${source}`)
        note?.({ kind: 'miss', via: installedHere ? 'summarize' : 'summarize-no-llm', source })
      }
    }
  }
  debugLog('phase=installed via=summarize')
  log.info?.('dsh-workbench: companion compaction summarize patch installed')
  return true
}

function unpatchSummarize(engine) {
  if (!engine || !engine[SUMMARIZE_FLAG]) return
  try {
    engine.summarize = engine[SUMMARIZE_FLAG]
    delete engine[SUMMARIZE_FLAG]
  } catch {}
}

/**
 * Feature: when enabled, patch compaction.summarize + wrap reachable llm.stream.
 */
export function createCompanionCompactionFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = {
    status: 'off',
    phase: 'idle',
    detail: '未安装',
    instructionSource: 'off',
    hits: 0,
    misses: 0,
    gen: 0,
  }
  let disposed = false
  let snapshot = ''
  const wrappedLlms = new Set()
  let patchedEngine = null
  let injectFork = null
  let pendingInstall = false

  function note(event) {
    if (disposed || !event) return
    if (event.kind === 'hit') {
      state.hits += 1
      state.phase = 'hit'
      state.status = 'on'
      state.instructionSource = event.source || state.instructionSource
      state.detail = state.instructionSource === 'custom' ? '已命中 · 自定义指令' : '已命中 · 内置指令'
      return
    }
    if (event.kind === 'miss') {
      state.misses += 1
      state.phase = 'miss'
      state.status = 'error'
      state.detail = '已安装但未命中'
    }
  }

  function markInstalled(source) {
    state.instructionSource = source
    state.status = 'on'
    if (state.phase !== 'hit' && state.phase !== 'miss') {
      state.phase = 'installed'
      state.detail = source === 'custom' ? '已安装 · 自定义指令' : '已安装 · 内置指令'
    }
  }

  function uninstall() {
    unpatchSummarize(patchedEngine)
    patchedEngine = null
    for (const llm of wrappedLlms) unwrapStreamOnLlm(llm)
    wrappedLlms.clear()
  }

  function tryInstall() {
    let ok = false
    const engine = getService(ctx, 'compaction')
    if (engine && patchSummarize(engine, getConfig, log, note)) {
      patchedEngine = engine
      ok = true
      const engLlm = getService(engine.ctx, 'llm') || engine.ctx?.llm
      if (engLlm && wrapStreamOnLlm(engLlm, getConfig, log, 'engine.ctx.llm', note)) {
        wrappedLlms.add(engLlm)
      }
    }
    const llm = getService(ctx, 'llm')
    if (llm && wrapStreamOnLlm(llm, getConfig, log, 'workbench.ctx.llm', note)) {
      wrappedLlms.add(llm)
      ok = true
    }
    return ok
  }

  function ensureInject() {
    if (injectFork || typeof ctx.inject !== 'function') return
    try {
      injectFork = ctx.inject(['compaction', 'llm'], (sub) => {
        if (disposed || !pendingInstall) return
        const eng = getService(sub, 'compaction')
        if (eng && patchSummarize(eng, getConfig, log, note)) patchedEngine = eng
        const llm = getService(sub, 'llm')
        if (llm && wrapStreamOnLlm(llm, getConfig, log, 'inject.llm', note)) wrappedLlms.add(llm)
        if (eng?.ctx?.llm && wrapStreamOnLlm(eng.ctx.llm, getConfig, log, 'inject.engine.llm', note)) {
          wrappedLlms.add(eng.ctx.llm)
        }
        if (patchedEngine || wrappedLlms.size) {
          const cfg = getConfig() || {}
          markInstalled(instructionSourceOf(cfg))
          debugLog(`phase=${state.phase} via=inject source=${state.instructionSource}`)
        }
      })
    } catch (error) {
      debugLog(`inject failed ${error?.name || error}`)
      log.warn?.('dsh-workbench: companion compaction inject failed', error?.name || 'error')
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = isCompanionCompactionEnabled(cfg)
    const source = instructionSourceOf(cfg)
    const snap = enabled ? `1:${source}` : '0'
    const healthy = !!(patchedEngine || wrappedLlms.size)
    if (snap === snapshot && (!enabled || healthy)) return
    const gen = ++state.gen
    uninstall()
    pendingInstall = false
    if (gen !== state.gen) return
    if (!enabled) {
      snapshot = snap
      state.status = 'off'
      state.phase = 'off'
      state.instructionSource = 'off'
      state.detail = '未启用'
      debugLog('phase=off')
      return
    }
    state.hits = 0
    state.misses = 0
    state.phase = 'pending'
    state.status = 'error'
    state.instructionSource = source
    state.detail = '等待 compaction/llm 就绪'
    pendingInstall = true
    ensureInject()
    const ok = tryInstall()
    if (gen !== state.gen) {
      uninstall()
      pendingInstall = false
      return
    }
    if (!ok) {
      snapshot = ''
      debugLog('phase=pending compaction/llm not ready')
      return
    }
    snapshot = snap
    markInstalled(source)
    debugLog(`phase=${state.phase} source=${source} engine=${!!patchedEngine} llms=${wrappedLlms.size}`)
  }

  return {
    sync,
    async dispose() {
      disposed = true
      pendingInstall = false
      state.gen++
      snapshot = ''
      uninstall()
      try { await injectFork?.dispose?.() } catch {}
      injectFork = null
      state.status = 'off'
      state.phase = 'idle'
      state.instructionSource = 'off'
      state.detail = '已卸载'
      debugLog('phase=idle disposed')
    },
    state() {
      return {
        status: state.status,
        phase: state.phase,
        detail: state.detail,
        instructionSource: state.instructionSource,
        hits: state.hits,
        misses: state.misses,
        mounted: !!(patchedEngine || wrappedLlms.size),
      }
    },
  }
}
