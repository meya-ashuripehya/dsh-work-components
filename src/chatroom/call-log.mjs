/**
 * 聊天室每次模型调用的调试日志（JSON Lines）：<数据目录>/chatroom/calls.log。
 * 只记元数据：时间、房间、成员、服务商 / 模型、步骤、提供的工具数、停止原因、工具调用名与数量、输出 token、耗时、
 * 失败时的错误码与简短原因。不记提示词、回复正文、工具参数或任何密钥（错误文本里疑似密钥的片段会被抹掉）。
 * 超过 maxBytes 时轮转为 calls.log.1（只保留一份旧文件）。写入失败不影响聊天。
 */
import { appendFile, stat, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CALL_LOG_MAX_BYTES = 1024 * 1024

/** 抹掉疑似密钥 / 令牌的片段。 */
export function scrubSecrets(s) {
  return String(s ?? '')
    .replace(/\b(?:sk|pk|rk|xai|gsk|ghp|gho|ghs|github_pat|AIza|ya29|eyJ)[A-Za-z0-9_\-.]{8,}/g, '[redacted]')
    .replace(/\b(bearer|token|key|secret|password|authorization)(["'\s:=]+)[^\s"',;]{6,}/gi, '$1$2[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
}

const short = (s, n) => scrubSecrets(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n)

/** 把一次调用整理成日志条目（纯函数，便于测试）。 */
export function callEntry({ roomId, seat, step, kind = 'turn', toolsOffered = 0, maxTokens, out, error, ms, at = Date.now(), images = 0, fallback = '', attempt = 1, retrying = false }) {
  const e = {
    ts: new Date(at).toISOString(),
    room: String(roomId || ''),
    seat: String(seat?.name || seat?.id || ''),
    provider: String(seat?.provider || ''),
    model: String(seat?.model || ''),
    kind,
    step: Number.isInteger(step) ? step : 0,
    toolsOffered: Number(toolsOffered) || 0,
    maxTokens: Number(maxTokens) || 0,
    ms: Math.max(0, Math.round(Number(ms) || 0)),
  }
  if (Number(images) > 0) e.images = Number(images)
  if (Number(attempt) > 1) e.attempt = Number(attempt)
  if (fallback) {
    e.ok = false
    e.stop = 'fallback'
    e.note = short(fallback, 160)
    if (error) { if (error.code) e.code = short(error.code, 60); e.error = short(error.message || error, 200) }
    return e
  }
  if (error) {
    e.ok = false
    e.stop = error.aborted ? 'aborted' : 'error'
    if (error.code) e.code = short(error.code, 60)
    if (error.status) e.status = Number(error.status) || short(error.status, 20)
    e.error = short(error.message || error, 200)
    const p = error.partial
    if (p?.usage?.output) e.outTokens = Number(p.usage.output) || 0
    // 失败前已流出多少（区分「连接 / 首字前」与「流中途」断开）：只记长度，不记内容
    const think = p?.thoughts instanceof Map ? [...p.thoughts.values()].reduce((n, t) => n + String(t || '').length, 0) : 0
    if (p?.text) e.partialChars = String(p.text).length
    if (think) e.partialThinkChars = think
    if (p?.toolCalls?.length) e.partialToolCalls = p.toolCalls.length
    if (retrying) e.retrying = true
    return e
  }
  const calls = Array.isArray(out?.toolCalls) ? out.toolCalls : []
  e.ok = true
  e.stop = String(out?.finish || '') || (calls.length ? 'tool-use' : 'stop')
  e.toolCalls = calls.length
  if (calls.length) e.tools = calls.map((c) => short(c?.name, 64)).slice(0, 20)
  if (out?.droppedToolCalls) e.droppedToolCalls = out.droppedToolCalls
  e.textChars = String(out?.text || '').length
  if (out?.usage) { e.inTokens = Number(out.usage.input) || 0; e.outTokens = Number(out.usage.output) || 0 }
  return e
}

export function createCallLog(file, { maxBytes = CALL_LOG_MAX_BYTES } = {}) {
  let chain = Promise.resolve()
  let ready = false
  async function write(line) {
    if (!ready) { await mkdir(dirname(file), { recursive: true }); ready = true }
    try { const st = await stat(file); if (st.size + line.length > maxBytes) await rename(file, file + '.1') } catch {}
    await appendFile(file, line, 'utf8')
  }
  /** 记录一次调用；返回的 Promise 不会 reject。 */
  function log(input) {
    let line
    try { line = JSON.stringify(callEntry(input)) + '\n' } catch { return chain }
    chain = chain.then(() => write(line)).catch(() => {})
    return chain
  }
  return { log, file }
}
