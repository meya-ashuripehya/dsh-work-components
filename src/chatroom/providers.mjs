/**
 * 席位调用：经 DSH 服务商层 ctx.llm.stream()（@deepseek-ai/dsh-llm LlmRuntime）。
 * 本插件不持有 API Key、不拼 HTTP 请求：路由（provider）选适配器，适配器从 DSH 凭据服务取密钥、走 DSH 的代理 / 重试设置。
 * 输入是 transcript.buildPrompt() 的 { system, messages: [{ role, content }] }，这里转成 dsh-llm Message。
 * 返回 { text, usage: { input, output, cacheRead, cacheWrite } }；思考（reasoning-delta）不进房间。
 * seat.reasoningEffort 原样作为 GenerateOptions.reasoningEffort；tools 给出时收集 tool-call 块（toolCalls），由房间执行。
 */
import { randomUUID } from 'node:crypto'

export class ProviderError extends Error {
  constructor(message, { aborted, code } = {}) { super(message); this.aborted = !!aborted; this.code = code }
}

/** buildPrompt 的消息 → dsh-llm Message（user / assistant 纯文本块）。 */
export function toLlmMessages(seat, messages) {
  return messages.map((m) => ({
    id: randomUUID(),
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    source: m.role === 'assistant' ? { kind: 'model', provider: seat.provider, model: seat.model } : { kind: 'user' },
  }))
}

const usageOf = (u) => ({ input: (u?.inputTokens || 0) + (u?.cacheReadTokens || 0) + (u?.cacheWriteTokens || 0), output: u?.outputTokens || 0, cacheRead: u?.cacheReadTokens || 0, cacheWrite: u?.cacheWriteTokens || 0 })

/**
 * @param {{ seat, prompt, llm, maxTokens?, signal?, onDelta? }} o  llm = 宿主 LlmRuntime
 */
export async function callSeat({ seat, prompt, llm, maxTokens = 1024, signal, onDelta, tools }) {
  if (!llm || typeof llm.stream !== 'function') throw new ProviderError('DSH 服务商服务不可用（ctx.llm 未就绪）')
  if (!seat.provider) throw new ProviderError(`${seat.name} 未选择服务商`)
  if (!seat.model) throw new ProviderError(`${seat.name} 未选择模型`)
  let registered = []
  try { registered = llm.listProviders?.() || [] } catch {}
  if (registered.length && !registered.some((p) => p.id === seat.provider)) throw new ProviderError(`${seat.name} 的服务商 ${seat.provider} 未在 DSH 中启用，请在「设置 › 模型」中配置`)
  const state = { text: '', toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const fail = (err) => { err.partial = state; return err }
  try {
    const req = { provider: seat.provider, model: seat.model, system: prompt.system, messages: toLlmMessages(seat, prompt.messages), maxTokens, signal }
    if (seat.reasoningEffort) req.reasoningEffort = seat.reasoningEffort
    if (Array.isArray(tools) && tools.length) req.tools = tools
    const stream = llm.stream(req)
    for await (const c of stream) {
      if (c.type === 'text-delta') { if (c.text) { state.text += c.text; onDelta?.(c.text) } }
      else if (c.type === 'usage') state.usage = usageOf(c.usage)
      else if (c.type === 'block-end' && c.block?.type === 'tool-call') state.toolCalls.push({ id: String(c.block.id), name: c.block.name, arguments: c.block.arguments })
      else if (c.type === 'finish') {
        const r = c.reason || {}
        if (r.kind === 'aborted' || signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
        if (r.kind === 'error') throw fail(new ProviderError(`${seat.name} 请求失败：${r.failure?.message || r.failure?.code || '未知错误'}`, { code: r.failure?.code }))
        break
      }
    }
  } catch (e) {
    if (e instanceof ProviderError) throw fail(e)
    if (signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
    throw fail(new ProviderError(`${seat.name} 调用失败：${e?.message || e}`))
  }
  if (signal?.aborted) throw fail(new ProviderError('已停止', { aborted: true }))
  return { text: state.text, usage: state.usage, toolCalls: state.toolCalls }
}
