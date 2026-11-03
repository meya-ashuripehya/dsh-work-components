/**
 * 发往 Google / Gemini / Vertex 的工具 schema：折叠 draft-04 元组 items: [...]。
 * 本仓库没有独立的 google-tool-cap；宿主主循环经 llm.stream / prepareCall（以及 llm/stream 瀑布）把
 * MCP / deepslate 一类工具原样交给适配器，聊天室视频席位则走 toGeminiTools，都不经过 chatroom schemas()。
 * 净化逻辑只复用 chatroom/schema-sanitize.mjs。
 */
import { sanitizeToolSchemas } from '../chatroom/schema-sanitize.mjs'

const STREAM_FLAG = '__dshGoogleSchemaSanitize'
const originals = new WeakMap()

/** 服务商 id 含 google / gemini / vertex（含 google-vision 等转接，它们仍把 schema 交给 Gemini）。 */
export function isGoogleFamilyProvider(provider) {
  const p = String(provider ?? '').toLowerCase()
  return p.includes('google') || p.includes('gemini') || p.includes('vertex')
}

function googleTools(options) {
  if (!options || typeof options !== 'object') return null
  if (!isGoogleFamilyProvider(options.provider)) return null
  if (!Array.isArray(options.tools) || options.tools.length === 0) return null
  return options.tools
}

/** 复制请求并净化 tools。非 Google、或没有 tools 时返回原引用。不修改输入。 */
export function sanitizeGoogleRequest(options) {
  const tools = googleTools(options)
  if (!tools) return options
  return { ...options, tools: sanitizeToolSchemas(tools) }
}

/**
 * 就地替换 options.tools（llm/stream 瀑布的最终回调闭包住原对象，只能改这个对象）。
 * 冻结对象会抛错，由调用方吞掉；方法包装会先复制，不依赖这里。
 */
export function applyGoogleToolSanitize(options) {
  const tools = googleTools(options)
  if (!tools) return false
  options.tools = sanitizeToolSchemas(tools)
  return true
}

function wrapPreparedStream(prepared) {
  if (!prepared || typeof prepared.stream !== 'function') return prepared
  if (prepared.stream[STREAM_FLAG]) return prepared
  const prev = prepared.stream
  function stream(options) {
    return prev.call(this, sanitizeGoogleRequest(options))
  }
  stream[STREAM_FLAG] = true
  const next = { ...prepared, stream }
  return Object.isFrozen(prepared) ? Object.freeze(next) : next
}

/**
 * 包住一个 LlmRuntime：stream 与 prepareCall().stream 在进入适配器前净化 Google 工具 schema。
 * 已包装过则不再套一层。返回是否因此处于已包装状态。
 */
export function wrapLlmForGoogleSchemas(llm) {
  if (!llm || typeof llm !== 'object') return false
  let did = false
  if (typeof llm.stream === 'function' && !llm.stream[STREAM_FLAG]) {
    const prev = llm.stream
    function stream(options) {
      return prev.call(this, sanitizeGoogleRequest(options))
    }
    stream[STREAM_FLAG] = true
    llm.stream = stream
    const rec = originals.get(llm) || {}
    if (!rec.stream) rec.stream = prev
    originals.set(llm, rec)
    did = true
  }
  if (typeof llm.prepareCall === 'function' && !llm.prepareCall[STREAM_FLAG]) {
    const prev = llm.prepareCall
    async function prepareCall(config, signal) {
      const prepared = await prev.call(this, sanitizeGoogleRequest(config), signal)
      return wrapPreparedStream(prepared)
    }
    prepareCall[STREAM_FLAG] = true
    llm.prepareCall = prepareCall
    const rec = originals.get(llm) || {}
    if (!rec.prepareCall) rec.prepareCall = prev
    originals.set(llm, rec)
    did = true
  }
  return did || !!(llm.stream?.[STREAM_FLAG] || llm.prepareCall?.[STREAM_FLAG])
}

/** 仅当当前方法仍是本模块包上去的那一层时还原。 */
export function unwrapLlmForGoogleSchemas(llm) {
  const rec = llm ? originals.get(llm) : null
  if (!rec) return
  if (llm.stream?.[STREAM_FLAG] && rec.stream) llm.stream = rec.stream
  if (llm.prepareCall?.[STREAM_FLAG] && rec.prepareCall) llm.prepareCall = rec.prepareCall
  originals.delete(llm)
}

function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(name)
      if (v != null) return v
    }
  } catch { /* 服务未就绪 */ }
  try { return ctx?.[name] ?? null } catch { return null }
}

function onLlmStream(options, next) {
  try { applyGoogleToolSanitize(options) } catch { /* 冻结的 options 改不了；方法包装会另复制一份 */ }
  return typeof next === 'function' ? next() : undefined
}

/**
 * 插件生命周期：包住看得到的 llm（含 compaction 引擎上的那份），并监听 llm/stream。
 * sync 可重复调用（陪伴压缩等稍后替换 stream 时再包一层）。
 */
export function createGoogleSchemaGuard(ctx) {
  const log = ctx?.logger
  const wrapped = new Set()
  let disposed = false
  let offStream = null
  let injectFork = null
  let announced = false

  function consider(llm) {
    if (disposed || !llm) return false
    const ok = wrapLlmForGoogleSchemas(llm)
    if (ok) wrapped.add(llm)
    return ok
  }

  function announce() {
    if (announced) return
    announced = true
    log?.info?.('dsh-workbench: Gemini/Vertex 工具参数里的元组 items 会在发出前折叠')
  }

  function sync() {
    if (disposed) return
    if (consider(service(ctx, 'llm'))) announce()
    try {
      const engine = service(ctx, 'compaction')
      if (consider(engine?.ctx?.llm)) announce()
    } catch { /* compaction 未就绪 */ }
    if (!offStream && typeof ctx?.on === 'function') {
      try {
        const off = ctx.on('llm/stream', onLlmStream)
        offStream = typeof off === 'function' ? off : true
        announce()
      } catch (error) {
        log?.warn?.('dsh-workbench: google schema sanitize cannot hook llm/stream', error?.name || 'error')
      }
    }
    if (!injectFork && typeof ctx?.inject === 'function') {
      try {
        injectFork = ctx.inject(['llm', 'compaction'], (sub) => {
          if (disposed) return
          if (consider(service(sub, 'llm'))) announce()
          try {
            if (consider(service(sub, 'compaction')?.ctx?.llm)) announce()
          } catch { /* ignore */ }
        }) || true
      } catch (error) {
        log?.warn?.('dsh-workbench: google schema sanitize inject failed', error?.name || 'error')
      }
    }
  }

  return {
    sync,
    dispose() {
      disposed = true
      if (typeof offStream === 'function') { try { offStream() } catch { /* ignore */ } }
      offStream = null
      for (const llm of wrapped) unwrapLlmForGoogleSchemas(llm)
      wrapped.clear()
      try { injectFork?.dispose?.() } catch { /* ignore */ }
      injectFork = null
    },
  }
}
