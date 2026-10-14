/**
 * 网关核验：单次模型调用的采集结果 → 五项判定（通过 / 可疑 / 无数据）。
 * 判定函数来自 llm-gateway-bench 的 probe/metrics.mjs（运行时动态导入，见 ./bench.mjs）；
 * 这里只做「把 DSH 的流式块换算成 bench 的入参」和本插件自有的 Token 计数、乱码补充规则。
 */

export const STATUS = Object.freeze({ PASS: 'pass', WARN: 'warn', NONE: 'none' })
export const ROW_KEYS = ['model', 'stream', 'tokens', 'cjk', 'cache']

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g
// 常见的 UTF-8 / GBK 互转乱码片段（「锟斤拷」「烫烫烫」、Latin-1 误解码的 Ã / â€）。
const MOJIBAKE_RE = /锟斤拷|烫烫烫|屯屯屯|Ã[\u0080-\u00bf]|â€[\u0080-\u00bf™œ“”˜]/g

/** 采集器：包住一次 llm/stream，记录时序、文本、用量与回包模型。now 可替换（测试用）。 */
export function createCallRecorder({ provider, model, now = () => Date.now() } = {}) {
  const t0 = now()
  const rec = {
    provider: provider == null ? '' : String(provider),
    requestedModel: model == null ? '' : String(model),
    responseModel: null,
    startedAt: t0,
    firstChunkAt: null,
    lastChunkAt: null,
    endedAt: null,
    chunks: 0,
    textChars: 0,
    reasoningChars: 0,
    toolArgChars: 0,
    usage: null,
    finish: null,
  }
  let text = ''
  return {
    rec,
    onChunk(chunk) {
      if (!chunk || typeof chunk !== 'object') return
      const t = now()
      const type = chunk.type
      if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') {
        const piece = String(type === 'tool-call-delta' ? chunk.argumentsDelta ?? '' : chunk.text ?? '')
        if (rec.firstChunkAt == null) rec.firstChunkAt = t
        rec.lastChunkAt = t
        rec.chunks += 1
        if (type === 'text-delta') { rec.textChars += piece.length; if (text.length < 200000) text += piece }
        else if (type === 'reasoning-delta') rec.reasoningChars += piece.length
        else rec.toolArgChars += piece.length
      } else if (type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        rec.usage = { ...chunk.usage }
      } else if (type === 'finish') {
        rec.finish = chunk.reason?.kind ?? 'stop'
        const response = chunk.replayState?.response
        if (response && typeof response.responseModel === 'string') rec.responseModel = response.responseModel
      }
    },
    end() {
      if (rec.endedAt == null) rec.endedAt = now()
      return { rec, text }
    },
  }
}

function row(status, value, note) {
  return { status, value: value == null ? '' : String(value), note: note == null ? '' : String(note) }
}

/** 粗估输出 token：汉字约 0.6 tok/字，其余约 4 字符/tok。 */
export function estimateTokens(cjkChars, otherChars) {
  return cjkChars * 0.6 + otherChars / 4
}

/**
 * 判定一次调用。bench = llm-gateway-bench 的 metrics 模块；history = 本会话先前调用的最大提示 token。
 * @returns {{ rows: Record<string, {status, value, note}>, overall: string }}
 */
export function evaluateCall({ rec, text }, bench, { priorMaxPrompt = null } = {}) {
  const rows = {}

  // 1. 回包模型
  {
    const echo = rec.responseModel ? bench.evalModelEcho(rec.responseModel, rec.requestedModel) : null
    if (echo == null) rows.model = row(STATUS.NONE, rec.requestedModel ? `请求 ${rec.requestedModel}` : '', '回包未携带 model 字段')
    else if (echo.ok) rows.model = row(STATUS.PASS, rec.responseModel, `与请求的 ${rec.requestedModel} 一致`)
    else rows.model = row(STATUS.WARN, rec.responseModel, `与请求的 ${rec.requestedModel} 不一致`)
  }

  // 2. 流式真实性
  {
    const ttftMs = rec.firstChunkAt == null ? null : rec.firstChunkAt - rec.startedAt
    const streamWindowMs = rec.firstChunkAt == null ? null : rec.lastChunkAt - rec.firstChunkAt
    const totalMs = (rec.endedAt ?? rec.lastChunkAt ?? rec.startedAt) - rec.startedAt
    const burst = bench.isBurstStream({ chunks: rec.chunks, ttftMs, streamWindowMs })
    const value = ttftMs == null ? '' : `首字 ${ttftMs} ms · 共 ${totalMs} ms · ${rec.chunks} 块`
    if (burst == null) rows.stream = row(STATUS.NONE, value, rec.chunks < 5 ? '分块过少，无法判断' : '缺少时序数据')
    else if (burst) rows.stream = row(STATUS.WARN, value, `内容在 ${streamWindowMs} ms 内集中到达，疑似整包后伪流式`)
    else rows.stream = row(STATUS.PASS, value, '逐块到达')
  }

  // 3. Token 计数（输出侧）
  {
    const out = typeof rec.usage?.outputTokens === 'number' ? rec.usage.outputTokens : null
    const cjk = (text.match(CJK_RE) || []).length
    const visible = rec.textChars + rec.reasoningChars + rec.toolArgChars
    // 只有可见文本能区分汉字；推理与工具参数按非汉字计。
    const est = estimateTokens(cjk, Math.max(0, visible - cjk))
    if (out == null) rows.tokens = row(STATUS.NONE, '', '未报告输出 token')
    else if (visible < 40 || est < 10) rows.tokens = row(STATUS.NONE, `${out} tok`, '输出过短，无法判断')
    else {
      const ratio = out / est
      const value = `${out} tok · 约 ${(visible / Math.max(out, 1)).toFixed(2)} 字符/tok`
      if (ratio > 3) rows.tokens = row(STATUS.WARN, value, `报告值约为估算的 ${ratio.toFixed(1)} 倍，疑似虚报`)
      else if (ratio < 0.25) rows.tokens = row(STATUS.WARN, value, `报告值仅为估算的 ${ratio.toFixed(2)} 倍，计数异常`)
      else rows.tokens = row(STATUS.PASS, value, '与输出长度相符')
    }
  }

  // 4. 中文完整性
  {
    const mojibake = (text.match(MOJIBAKE_RE) || []).length
    if (!text.trim()) rows.cjk = row(STATUS.NONE, '', '本次调用无文本输出')
    else {
      const r = bench.evalCjkIntegrity(text)
      const cjk = (text.match(CJK_RE) || []).length
      if (mojibake > 0) rows.cjk = row(STATUS.WARN, `${mojibake} 处`, '出现常见乱码片段')
      else if (r.ok) rows.cjk = row(STATUS.PASS, `${r.cjkChars ?? cjk} 字`, '未见替换符或乱码')
      else if (/replacement/.test(r.reason || '')) rows.cjk = row(STATUS.WARN, '', '含 U+FFFD 替换符，编码已损坏')
      else if (/escape/.test(r.reason || '')) rows.cjk = row(STATUS.WARN, '', '含未解码的 \\u 转义')
      else rows.cjk = row(STATUS.NONE, '', '回复基本不含中文')
    }
  }

  // 5. 缓存（DSH 用量里 inputTokens 为未缓存部分，提示总量 = inputTokens + cacheReadTokens）
  {
    const u = rec.usage || {}
    const cached = bench.extractCachedTokens(typeof u.cacheReadTokens === 'number' ? { cache_read_input_tokens: u.cacheReadTokens } : {})
    const prompt = (typeof u.inputTokens === 'number' ? u.inputTokens : 0) + (cached ?? 0)
    const verdict = bench.evalCache({ cachedSecond: cached, promptTokens: prompt || undefined })
    if (!verdict.reported) rows.cache = row(STATUS.NONE, '', '未报告缓存读取')
    else {
      const pct = verdict.cachedFrac == null ? '' : ` · ${Math.round(verdict.cachedFrac * 100)}%`
      const value = `${verdict.cachedTokens} tok${pct}`
      if (typeof priorMaxPrompt !== 'number') rows.cache = row(STATUS.NONE, value, '本会话此前无请求可比对')
      else if (verdict.cachedTokens > priorMaxPrompt * 1.05 + 64) rows.cache = row(STATUS.WARN, value, `命中量超过此前请求的提示总量（${priorMaxPrompt} tok）`)
      else rows.cache = row(STATUS.PASS, value, '命中量不超过此前已发送的内容')
    }
  }

  return { rows, overall: overallOf(rows) }
}

export function overallOf(rows) {
  const list = ROW_KEYS.map((k) => rows[k]).filter(Boolean)
  if (list.some((r) => r.status === STATUS.WARN)) return STATUS.WARN
  if (list.some((r) => r.status === STATUS.PASS)) return STATUS.PASS
  return STATUS.NONE
}

const RANK = { warn: 2, pass: 1, none: 0 }

/** 一个回合可能有多次调用（工具步）：每行取最严重的一次，值与说明随之。 */
export function mergeTurn(calls) {
  const rows = {}
  for (const key of ROW_KEYS) {
    let best = null
    for (const c of calls) {
      const r = c.rows?.[key]
      if (!r) continue
      if (!best || RANK[r.status] > RANK[best.status]) best = r
    }
    rows[key] = best ?? row(STATUS.NONE, '', '无数据')
  }
  return { rows, overall: overallOf(rows), calls: calls.length }
}
