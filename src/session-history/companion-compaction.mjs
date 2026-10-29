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

function debugLog(line) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
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

function wrapStreamOnLlm(llm, getConfig, log, tag) {
  if (!llm || typeof llm.stream !== 'function') return false
  if (llm[WRAP_FLAG] && llm.stream !== llm[WRAP_FLAG]) return true
  const bound = llm.stream.bind(llm)
  function companionCompactionStream(options) {
    try {
      const cfg = getConfig() || {}
      if (isCompanionCompactionEnabled(cfg)) {
        const purposeHit = options?.purpose === 'compaction'
        const markerHit = looksLikeOfficialCompactionInstruction(lastUserText(options?.messages))
        if (purposeHit || markerHit) {
          const instruction = resolveCompanionInstruction(cfg)
          const rewritten = applyCompanionCompactionOptions(options, instruction)
          debugLog(`stream-wrap hit tag=${tag} purpose=${options?.purpose} marker=${markerHit}`)
          log.info?.(`dsh-workbench: companion compaction instruction applied (${tag})`)
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
  llm[WRAP_FLAG] = bound
  debugLog(`stream-wrap installed tag=${tag}`)
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
function patchSummarize(engine, getConfig, log) {
  if (!engine || typeof engine.summarize !== 'function') return false
  if (engine[SUMMARIZE_FLAG]) return true
  const original = engine.summarize.bind(engine)
  engine[SUMMARIZE_FLAG] = original
  engine.summarize = async function companionSummarize(input, agent, signal) {
    const cfg = getConfig() || {}
    if (!isCompanionCompactionEnabled(cfg)) {
      return original(input, agent, signal)
    }
    const llm = getService(this.ctx, 'llm') || this.ctx?.llm
    const instruction = resolveCompanionInstruction(cfg)
    let installedHere = false
    let prev = null
    if (llm && typeof llm.stream === 'function') {
      // Always install a nested wrap for this call even if a permanent wrap exists:
      // chain through current stream so we still rewrite.
      prev = llm.stream.bind(llm)
      llm.stream = function (options) {
        try {
          const purposeHit = options?.purpose === 'compaction'
          const markerHit = looksLikeOfficialCompactionInstruction(lastUserText(options?.messages))
          if (purposeHit || markerHit) {
            debugLog(`summarize-nested hit purpose=${options?.purpose} marker=${markerHit}`)
            return prev(applyCompanionCompactionOptions(options, instruction))
          }
        } catch (error) {
          debugLog(`summarize-nested error ${error?.name || error}`)
        }
        return prev(options)
      }
      installedHere = true
    } else {
      debugLog('summarize patch: no llm on engine.ctx')
    }
    try {
      debugLog('summarize patch: calling original summarize')
      return await original(input, agent, signal)
    } finally {
      if (installedHere && prev) {
        try { llm.stream = prev } catch {}
      }
    }
  }
  debugLog('summarize patch installed')
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
  const state = { status: 'off', detail: '未启用', gen: 0 }
  let disposed = false
  let snapshot = ''
  const wrappedLlms = new Set()
  let patchedEngine = null
  let injectFork = null
  let pendingInstall = false

  function uninstall() {
    unpatchSummarize(patchedEngine)
    patchedEngine = null
    for (const llm of wrappedLlms) unwrapStreamOnLlm(llm)
    wrappedLlms.clear()
  }

  function tryInstall() {
    let ok = false
    const engine = getService(ctx, 'compaction')
    if (engine && patchSummarize(engine, getConfig, log)) {
      patchedEngine = engine
      ok = true
      // Also wrap engine.ctx.llm permanently
      const engLlm = getService(engine.ctx, 'llm') || engine.ctx?.llm
      if (engLlm && wrapStreamOnLlm(engLlm, getConfig, log, 'engine.ctx.llm')) {
        wrappedLlms.add(engLlm)
      }
    }
    const llm = getService(ctx, 'llm')
    if (llm && wrapStreamOnLlm(llm, getConfig, log, 'workbench.ctx.llm')) {
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
        if (eng && patchSummarize(eng, getConfig, log)) patchedEngine = eng
        const llm = getService(sub, 'llm')
        if (llm && wrapStreamOnLlm(llm, getConfig, log, 'inject.llm')) wrappedLlms.add(llm)
        if (eng?.ctx?.llm && wrapStreamOnLlm(eng.ctx.llm, getConfig, log, 'inject.engine.llm')) {
          wrappedLlms.add(eng.ctx.llm)
        }
        if (patchedEngine || wrappedLlms.size) {
          state.status = 'on'
          state.detail = '已启用 · 陪伴压缩指令'
          debugLog('inject installed patches')
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
    const custom = typeof cfg.companionCompactionInstruction === 'string' && cfg.companionCompactionInstruction.trim()
      ? 'custom'
      : 'default'
    const snap = enabled ? `1:${custom}` : '0'
    const healthy = !!(patchedEngine || wrappedLlms.size)
    if (snap === snapshot && (!enabled || healthy)) return
    const gen = ++state.gen
    uninstall()
    pendingInstall = false
    if (gen !== state.gen) return
    if (!enabled) {
      snapshot = snap
      state.status = 'off'
      state.detail = '未启用'
      debugLog('disabled')
      return
    }
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
      state.status = 'error'
      state.detail = '等待 compaction/llm 就绪'
      debugLog('install pending — compaction/llm not ready')
      return
    }
    snapshot = snap
    state.status = 'on'
    state.detail = custom === 'custom'
      ? '已启用 · 自定义陪伴压缩指令'
      : '已启用 · 陪伴压缩指令'
    debugLog(`enabled status=${state.status} engine=${!!patchedEngine} llms=${wrappedLlms.size}`)
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
      state.detail = '未启用'
      debugLog('disposed')
    },
    state() {
      return { status: state.status, detail: state.detail, mounted: !!(patchedEngine || wrappedLlms.size) }
    },
  }
}
