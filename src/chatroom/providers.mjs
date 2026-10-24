/**
 * 席位调用：经 DSH 服务商层 ctx.llm.stream()（@deepseek-ai/dsh-llm LlmRuntime）。
 * 本插件不持有 API Key、不拼 HTTP 请求：路由（provider）选适配器，适配器从 DSH 凭据服务取密钥、走 DSH 的代理 / 重试设置。
 * 输入是 transcript.buildPrompt() 的 { system, messages: [{ role, content }] }，这里转成 dsh-llm Message。
 * 返回 { text, usage: { input, output, cacheRead, cacheWrite }, reasoning? }；思考（reasoning-delta / reasoning 块，含摘要）只作为 reasoning 文本返回，
 * 由房间存进单独的 thinking.jsonl（仅本机界面可读），不进房间消息、不进任何 AI 的提示词、不发 Telegram。
 * seat.reasoningEffort 原样作为 GenerateOptions.reasoningEffort；tools 给出时收集 tool-call 块（toolCalls），由房间执行。
 */
import { randomUUID } from 'node:crypto'

export class ProviderError extends Error {
  constructor(message, { aborted, code } = {}) { super(message); this.aborted = !!aborted; this.code = code }
}

/**
 * buildPrompt 的消息 → dsh-llm Message（与 DSH 自身智能体循环相同的形状，见 dsh-llm createAssistantMessage / createToolResultMessage）。
 *   { role, content }                                   纯文本
 *   { role: 'assistant', blocks, replayState? }         工具循环中模型的原样输出块（含 reasoning / tool-call）；
 *                                                       replayState（finish 块带回的原生回放信息，如 DeepSeek thinking 签名）放进 source
 *   { role: 'user', toolResult: { toolCallId, text, isError, images? } }   工具结果 → role 'tool' 消息（toolCallId / isError 在消息上；
 *                                                       view_attachment 取回的真图作为 image 块附在文字后）。
 *   { role: 'user', content, images? }                  images = [{ id, ref }]：视觉成员的真图（见 transcript.buildPrompt）。
 * 两个适配器（dsh-llm-deepseek 与覆盖 Anthropic / OpenAI / Gemini / xAI 的 dsh-llm-pi-ai）都只认 role 'tool'；
 * 放在 user 内容里的 tool-result 块会被 DeepSeek 拒绝（「cannot represent user/tool-result content tool-result」）。
 */
/**
 * 真图 → dsh-llm image 块（{ type: 'image', attachment: ImageAttachmentRef }，与 mm_send_image / read_image 相同）。
 * labelled：每张图前加一行「(image #id)」，让模型把图与历史中的占位行对上。
 */
export function imageBlocks(images, labelled = false) {
  const out = []
  for (const img of Array.isArray(images) ? images : []) {
    const ref = img?.ref
    if (!ref?.attachmentId) continue
    if (labelled && img.id) out.push({ type: 'text', text: `(image #${img.id})` })
    out.push({ type: 'image', attachment: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: Number(ref.bytes) || 0, width: Number(ref.width) || 0, height: Number(ref.height) || 0, ...(ref.name ? { name: ref.name } : {}) } })
  }
  return out
}

export function toLlmMessages(seat, messages) {
  return messages.map((m) => {
    if (m.toolResult) {
      const r = m.toolResult
      const callId = String(r.toolCallId)
      const content = [{ type: 'text', text: String(r.text ?? '') }, ...imageBlocks(r.images)]
      return { id: randomUUID(), role: 'tool', toolCallId: callId, content, isError: !!r.isError, source: { kind: 'tool', callId } }
    }
    const content = Array.isArray(m.blocks) && m.blocks.length
      ? m.blocks
      : [{ type: 'text', text: m.content }, ...(m.role === 'user' ? imageBlocks(m.images, true) : [])]
    const source = m.role === 'assistant'
      ? { kind: 'model', provider: seat.provider, model: seat.model, ...(m.replayState !== undefined && Array.isArray(m.blocks) ? { replayState: m.replayState } : {}) }
      : { kind: 'user' }
    return { id: randomUUID(), role: m.role, content, source }
  })
}

/** 各思考块按位置拼接；全是空白（例如只有签名的空摘要）时返回 ''。 */
export function reasoningText(thoughts) {
  return [...thoughts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => String(t || '').trim()).filter(Boolean).join('\n\n')
}

/** 成员「请求等待」允许的取值（秒）；0 = 不额外等待（连接失败即按临时故障处理）。 */
export const SEAT_WAIT_CHOICES = [0, 15, 20, 30, 45, 60]
export const normalizeSeatWait = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(120, Math.max(5, n)) : 0 }

/**
 * 连接阶段失败（尚未收到任何输出）：DSH 的请求经 undici 发出，建立连接（含代理隧道与 TLS）有固定的 10 秒上限，
 * 超时后 OpenAI SDK 报「Request timed out.」（code TIMEOUT）；连接被拒 / 重置报「Connection error.」等（code TRANSPORT）。
 * 流中途断开（terminated、空闲超时）不算：那时已有输出或已等了很久。
 */
export function isConnectFailure(e) {
  if (!e || e.aborted) return false
  const p = e.partial
  if (p && (p.text || p.toolCalls?.length || p.blocks?.length || p.thoughts?.size)) return false
  const msg = String(e.message || '')
  if (/terminated|idle timeout|STREAM_IDLE/i.test(msg)) return false
  if (e.code === 'TIMEOUT') return true
  // 「DeepSeek Messages transport failed」：DSH 的 DeepSeek 适配器把 fetch / 读流时的任何底层异常（连接被拒、重置、经代理的
  // 「terminated / other side closed」等）统一包成这一句（code TRANSPORT），原因链在 DSH 内被丢弃；没有任何输出时按连接阶段失败处理。
  return /Request timed out|Connection error|transport failed|Connect ?Timeout|UND_ERR_CONNECT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)
}

/** 本次调用是否已经流出过任何内容（正文、思考、工具调用或完整块）。 */
export function hasStreamed(p) {
  return !!(p && (p.text || p.toolCalls?.length || p.blocks?.length || p.thoughts?.size))
}

/**
 * 传输层断开（连接或流被网络中途切断）：DeepSeek 的「Messages transport failed」、undici 的「terminated / other side closed」、
 * 连接错误、重置等。与连接阶段失败不同，这里也包括已经流出部分内容之后的断开——此时这一步还没有执行任何工具、也没有写入记录，
 * 整步重新请求是安全的。不含：用户停止 / 中断、空闲超时（DSH 已等了 5 分钟）、HTTP 状态错误（凭据、限流、5xx 由服务商给出）。
 */
export function isStreamDropFailure(e) {
  if (!e || e.aborted) return false
  const msg = String(e.message || '')
  if (/idle timeout|STREAM_IDLE|已停止/i.test(msg)) return false
  if (e.code && e.code !== 'TRANSPORT' && e.code !== 'TIMEOUT' && e.code !== 'UNKNOWN') return false
  if (e.code === 'TIMEOUT') return !hasStreamed(e.partial) && /Request timed out|Connect ?Timeout/i.test(msg)
  return /transport failed|terminated|other side closed|UND_ERR_SOCKET|socket hang up|ECONNRESET|EPIPE|Connection error|fetch failed/i.test(msg)
}

/**
 * 按成员的「请求等待」（seat.timeoutSec）调用：连接阶段失败且从首次请求起未满该时长时，0.5 秒后重新请求（最多 3 次）。
 * 不给成功的请求加任何新的时限；timeoutSec 为 0 时与直接调用完全相同。
 */
export async function callSeatWithWait(call, o, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  const budget = normalizeSeatWait(o?.seat?.timeoutSec) * 1000
  if (!budget) return call(o)
  const t0 = now()
  for (let attempt = 1; ; attempt++) {
    let output = false
    const mark = (fn) => (fn ? (...a) => { output = true; return fn(...a) } : undefined)
    try {
      return await call({ ...o, onDelta: mark(o.onDelta), onReasoning: mark(o.onReasoning) })
    } catch (e) {
      if (output || o.signal?.aborted || attempt >= 3 || !isConnectFailure(e) || now() - t0 >= budget) throw e
      try { onRetry?.(e, attempt, now() - t0) } catch {}
      await sleep(500)
      if (o.signal?.aborted) throw e
    }
  }
}

const usageOf = (u) => ({ input: (u?.inputTokens || 0) + (u?.cacheReadTokens || 0) + (u?.cacheWriteTokens || 0), output: u?.outputTokens || 0, cacheRead: u?.cacheReadTokens || 0, cacheWrite: u?.cacheWriteTokens || 0 })

/**
 * @param {{ seat, prompt, llm, maxTokens?, signal?, onDelta? }} o  llm = 宿主 LlmRuntime
 */
export async function callSeat({ seat, prompt, llm, maxTokens, signal, onDelta, onReasoning, tools }) {
  if (!llm || typeof llm.stream !== 'function') throw new ProviderError('DSH 服务商服务不可用（ctx.llm 未就绪）')
  if (!seat.provider) throw new ProviderError(`${seat.name} 未选择服务商`)
  if (!seat.model) throw new ProviderError(`${seat.name} 未选择模型`)
  let registered = []
  try { registered = llm.listProviders?.() || [] } catch {}
  if (registered.length && !registered.some((p) => p.id === seat.provider)) throw new ProviderError(`${seat.name} 的服务商 ${seat.provider} 未在 DSH 中启用，请在「设置 › 模型」中配置`)
  const state = { text: '', toolCalls: [], blocks: [], replayState: undefined, finish: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thoughts: new Map() }
  const fail = (err) => { err.partial = state; return err }
  try {
    const req = { provider: seat.provider, model: seat.model, system: prompt.system, messages: toLlmMessages(seat, prompt.messages), signal }
    const cap = Number(maxTokens) || 0
    if (cap > 0) req.maxTokens = cap
    if (seat.reasoningEffort) req.reasoningEffort = seat.reasoningEffort
    if (Array.isArray(tools) && tools.length) req.tools = tools
    const stream = llm.stream(req)
    for await (const c of stream) {
      if (c.type === 'text-delta') { if (c.text) { state.text += c.text; onDelta?.(c.text) } }
      else if (c.type === 'reasoning-delta') {
        if (c.text) {
          const k = Number.isInteger(c.index) ? c.index : -1
          state.thoughts.set(k, (state.thoughts.get(k) || '') + c.text)
          try { onReasoning?.(c.text) } catch {}
        }
      }
      else if (c.type === 'usage') state.usage = usageOf(c.usage)
      else if (c.type === 'block-end' && c.block) {
        state.blocks.push({ index: Number.isInteger(c.index) ? c.index : state.blocks.length, block: c.block })
        // 只有完整块、没有流式增量的适配器：用块里的文字
        if (c.block.type === 'reasoning' && typeof c.block.text === 'string' && c.block.text.trim()) {
          const k = Number.isInteger(c.index) ? c.index : -1
          if (!String(state.thoughts.get(k) || '').trim()) state.thoughts.set(k, c.block.text)
        }
        if (c.block.type === 'tool-call') state.toolCalls.push({ id: String(c.block.id), name: c.block.name, arguments: c.block.arguments })
      }
      else if (c.type === 'finish') {
        const r = c.reason || {}
        state.finish = r.kind || ''
        if (c.replayState !== undefined) state.replayState = c.replayState
        if (r.kind === 'aborted' || signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
        if (r.kind === 'error') throw fail(new ProviderError(`${seat.name} 请求失败：${r.failure?.message || r.failure?.code || '未知错误'}`, { code: r.failure?.code }))
        break
      }
    }
  } catch (e) {
    if (e instanceof ProviderError) throw fail(e)
    if (signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
    throw fail(new ProviderError(`${seat.name} 调用失败：${e?.message || e}`, { code: typeof e?.code === 'string' ? e.code : undefined }))
  }
  if (signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
  const blocks = state.blocks.slice().sort((a, b) => a.index - b.index).map((x) => x.block)
  // max-tokens 截断时适配器会丢弃未完成的工具调用，回放信息与块数对不上，不带回放。
  const replayState = state.finish === 'max-tokens' ? undefined : state.replayState
  const truncated = state.finish === 'max-tokens'
  const reasoning = reasoningText(state.thoughts)
  return { ...(reasoning ? { reasoning } : {}), text: state.text, usage: state.usage, toolCalls: truncated ? [] : state.toolCalls, blocks, finish: state.finish, ...(truncated && state.toolCalls.length ? { droppedToolCalls: state.toolCalls.length } : {}), ...(replayState !== undefined ? { replayState } : {}) }
}
