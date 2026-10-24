/**
 * 「视频」输入模态的席位调用：DSH 服务商层（dsh-llm）不转发视频，所以开启了视频输入、且本轮最新消息带视频的 Gemini 席位
 * 改由插件直接请求 Gemini generateContent（密钥解析与转写相同，见 transcribe.resolveGeminiKey；密钥只在请求头）。
 * 输入 / 输出与 providers.callSeat 相同：{ system, messages } → { text, usage, toolCalls, blocks, finish, reasoning? }。
 *   - 消息上的 images（[{ id }]）与 videos（[{ id }]）由 resolveMedia(kind, item) 转成 Gemini part；
 *   - 同一回合内的工具循环：assistant 的 blocks（text / tool-call）→ model parts（functionCall 带回 thoughtSignature），
 *     toolResult → functionResponse；相邻同角色合并。
 * 不流式：拿到完整回复后一次性 onDelta。
 */
import { randomUUID } from 'node:crypto'
import { GEMINI_API_BASE, redact } from './transcribe.mjs'
import { ProviderError } from './providers.mjs'

/** Gemini 3 对回放的 functionCall 要求思考签名；不是本适配器产出的块用官方文档给出的占位值。 */
export const SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator'

/** 原生 Gemini 服务商（可直接收视频）：DSH 的 google 服务商（及 gemini / google-ai 等同类 id），不含 Vision Router「-vision」转接。 */
export function isNativeGeminiSeat(seat) {
  const p = String(seat?.provider || '').toLowerCase()
  if (!p || /-vision$/.test(p)) return false
  return /^(google|gemini|google-ai|google-gemini|google-generative-ai)$/.test(p)
}

/** 本轮提示词里带视频的消息（transcript.buildPrompt 只在最新消息上放 videos）。 */
export const promptVideos = (prompt) => (prompt?.messages || []).flatMap((m) => (Array.isArray(m.videos) ? m.videos : []))

function argsObject(a) {
  if (a && typeof a === 'object') return a
  try { const v = JSON.parse(String(a || '{}')); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

/** buildPrompt 消息 → Gemini contents。resolveMedia(kind, item) → part | null。 */
export async function toGeminiContents(messages, resolveMedia) {
  const out = []
  const callNames = new Map()
  const push = (role, parts) => {
    if (!parts.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const m of messages || []) {
    if (m.toolResult) {
      const r = m.toolResult
      const name = callNames.get(String(r.toolCallId)) || 'tool'
      const parts = [{ functionResponse: { name, response: { [r.isError ? 'error' : 'result']: String(r.text ?? '') } } }]
      for (const img of r.images || []) { const p = await resolveMedia('image', img); if (p) parts.push(p) }
      push('user', parts)
      continue
    }
    if (m.role === 'assistant') {
      const parts = []
      if (Array.isArray(m.blocks) && m.blocks.length) {
        for (const b of m.blocks) {
          if (b?.type === 'text' && b.text) parts.push({ text: b.text })
          else if (b?.type === 'tool-call') {
            callNames.set(String(b.id), b.name)
            parts.push({ functionCall: { name: b.name, args: argsObject(b.arguments) }, thoughtSignature: b.thoughtSignature || SIGNATURE_PLACEHOLDER })
          }
        }
      } else if (m.content) parts.push({ text: String(m.content) })
      push('model', parts)
      continue
    }
    const parts = [{ text: String(m.content ?? '') }]
    for (const img of m.images || []) {
      const p = await resolveMedia('image', img)
      if (p) parts.push({ text: `(image #${img.id})` }, p)
    }
    for (const v of m.videos || []) {
      const p = await resolveMedia('video', v)
      if (p) parts.push({ text: `(video #${v.id})` }, p)
    }
    push('user', parts)
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '(conversation start)' }] })
  return out
}

export function toGeminiTools(tools) {
  const decls = (Array.isArray(tools) ? tools : []).filter((t) => t?.name).map((t) => ({ name: t.name, description: String(t.description || ''), parametersJsonSchema: t.parameters || { type: 'object', properties: {} } }))
  return decls.length ? [{ functionDeclarations: decls }] : undefined
}

const FINISH = { STOP: 'stop', MAX_TOKENS: 'max-tokens', SAFETY: 'error', RECITATION: 'error', PROHIBITED_CONTENT: 'error', BLOCKLIST: 'error', MALFORMED_FUNCTION_CALL: 'error' }

/** Gemini 响应 → callSeat 的返回形状。 */
export function fromGeminiResponse(j) {
  const cand = j?.candidates?.[0] || {}
  const parts = cand.content?.parts || []
  const blocks = []
  const toolCalls = []
  let text = ''
  let reasoning = ''
  for (const p of parts) {
    if (typeof p?.text === 'string' && p.thought) { reasoning += p.text; continue }
    if (typeof p?.text === 'string') { text += p.text; const last = blocks[blocks.length - 1]; if (last?.type === 'text') last.text += p.text; else blocks.push({ type: 'text', text: p.text }); continue }
    if (p?.functionCall?.name) {
      const id = String(p.functionCall.id || `gv_${randomUUID().slice(0, 12)}`)
      const args = p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {}
      blocks.push({ type: 'tool-call', id, name: p.functionCall.name, arguments: args, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) })
      toolCalls.push({ id, name: p.functionCall.name, arguments: args })
    }
  }
  const u = j?.usageMetadata || {}
  const cacheRead = Number(u.cachedContentTokenCount) || 0
  const usage = { input: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0), cacheRead, cacheWrite: 0 }
  const finish = toolCalls.length && (!cand.finishReason || cand.finishReason === 'STOP') ? 'tool-calls' : (FINISH[cand.finishReason] || (cand.finishReason ? 'error' : 'stop'))
  return { text, blocks, toolCalls: finish === 'max-tokens' ? [] : toolCalls, usage, finish, reasoning: reasoning.trim(), block: j?.promptFeedback?.blockReason || (FINISH[cand.finishReason] === 'error' ? cand.finishReason : '') }
}

/**
 * @param {{ seat, prompt, tools?, maxTokens?, signal?, onDelta?, onReasoning?, fetchImpl, apiKey, resolveMedia, base? }} o
 */
export async function callGeminiSeat({ seat, prompt, tools, maxTokens, signal, onDelta, onReasoning, fetchImpl, apiKey, resolveMedia, base = GEMINI_API_BASE }) {
  if (!apiKey) throw new ProviderError(`${seat.name} 的视频输入需要 Gemini API 密钥（与语音转写相同的来源）`)
  if (typeof fetchImpl !== 'function') throw new ProviderError('网络请求不可用')
  let res
  let j
  try {
    const body = {
      ...(prompt.system ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
      contents: await toGeminiContents(prompt.messages, resolveMedia),
      ...(toGeminiTools(tools) ? { tools: toGeminiTools(tools) } : {}),
      ...(Number(maxTokens) > 0 ? { generationConfig: { maxOutputTokens: Number(maxTokens) } } : {}),
    }
    res = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(seat.model)}:generateContent`, { method: 'POST', signal, headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try { j = await res.json() } catch { j = null }
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('已停止', { aborted: true })
    throw new ProviderError(`${seat.name} 调用失败：${redact(String(e?.message || e), apiKey).slice(0, 300)}`)
  }
  if (signal?.aborted) throw new ProviderError('已停止', { aborted: true })
  if (!res?.ok) throw new ProviderError(`${seat.name} 请求失败：${redact(String(j?.error?.message || j?.error?.status || `HTTP ${res?.status}`), apiKey).slice(0, 300)}`, { code: j?.error?.status || String(res?.status || '') })
  const out = fromGeminiResponse(j)
  if (out.finish === 'error' && !out.text && !out.toolCalls.length) throw new ProviderError(`${seat.name} 请求失败：Gemini 拒绝处理（${out.block || '未知原因'}）`, { code: out.block })
  if (out.reasoning) { try { onReasoning?.(out.reasoning) } catch {} }
  if (out.text) { try { onDelta?.(out.text) } catch {} }
  const { block, reasoning, ...rest } = out
  return { ...(reasoning ? { reasoning } : {}), ...rest, finish: rest.finish === 'error' ? 'stop' : rest.finish, via: 'gemini-video' }
}