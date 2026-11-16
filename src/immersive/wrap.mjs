/**
 * 在 llm.prepareCall / llm.stream / llm.streamWithRegistration 上按会话角色改写 options.tools：
 *   所有者前台：find_tools + 本会话钉选 + 点名保留；其他人前台只剩「门」；后台助手去掉门；其余会话去掉门。
 *
 * 与 google-tool-cap/wrap.mjs 同一套路：agent-loop 先 prepareCall（常常不带 tools），再用 prepared.stream 发全量
 * 工具，所以三条入口都要改写；尽量原地改 options.tools，保住 agent-loop 的 WeakSet 标记。
 *
 * 只装一次：本模块的状态放在 llm 对象上的 holder 里，插件热重载 / 开关切换只换 holder.deps，
 * 不叠包装层；deps 为空（功能关闭或已卸载）时原样透传。
 */
import { injectHintIntoMessages, selectToolsForRole } from './policy.mjs'

const WRAP_FLAG = '__dshImmersiveWrap'
const HOLDER = '__dshImmersiveHolder'

/** patch 里的字段（tools / messages）原地写回；options 被冻结（agent-loop 请求就是深冻结的）时改成拷贝并重新打标记。 */
function applyPatch(options, patch, markAgentLoopRequest) {
  if (!Object.isFrozen(options)) {
    try {
      Object.assign(options, patch)
      return options
    } catch { /* 落到拷贝路径 */ }
  }
  const next = { ...options, ...patch }
  if (typeof markAgentLoopRequest === 'function') {
    try { markAgentLoopRequest(next) } catch { /* 标记失败不影响请求 */ }
  }
  return next
}

/**
 * @param {any} options llm 请求选项（含 sessionId / tools / messages）
 * @param {{ roleOf: (sessionId: string) => string, keep?: () => Iterable<string>, directOf?: (sessionId: string) => boolean, pinsOf?: (sessionId: string) => Iterable<string>, hint?: (sessionId: string, info: { direct: boolean }) => string, onRewrite?: Function, markAgentLoopRequest?: Function }} deps
 *   directOf：这一轮是不是所有者。是的话前台走 find_tools，不走门。
 *   pinsOf：find_tools 已经钉在这个会话上的功能名。
 *   hint：前台角色的请求里，把这段说明追加进系统提示消息（返回空串 = 不追加）。
 */
export function rewriteOptions(options, deps) {
  if (!options || !deps || !Array.isArray(options.tools)) return options
  const sessionId = String(options.sessionId ?? '').trim()
  let role = 'other'
  try { role = sessionId ? deps.roleOf(sessionId) : 'other' } catch { role = 'other' }
  let direct = false
  if (role === 'persona') {
    try { direct = deps.directOf?.(sessionId) === true } catch { direct = false }
  }
  let pins = []
  if (direct) {
    try { pins = [...(deps.pinsOf?.(sessionId) || [])] } catch { pins = [] }
  }
  const before = options.tools.length
  const { tools, changed } = selectToolsForRole(role, options.tools, { keep: deps.keep?.(), direct, pins })
  const patch = {}
  if (changed) patch.tools = tools
  let hinted = false
  if (role === 'persona' && typeof deps.hint === 'function') {
    let text = ''
    try { text = deps.hint(sessionId, { direct }) } catch { text = '' }
    const injected = injectHintIntoMessages(options.messages, text)
    if (injected.changed) { patch.messages = injected.messages; hinted = true }
  }
  try { deps.onRewrite?.({ sessionId, role, before, after: tools.length, changed, hinted }) } catch { /* 诊断回调不能打断请求 */ }
  if (!changed && !hinted) return options
  return applyPatch(options, patch, deps.markAgentLoopRequest)
}

/**
 * @param {any} llm
 * @param {{ roleOf: Function, keep?: Function, onRewrite?: Function, markAgentLoopRequest?: Function }} deps
 * @returns {boolean} 是否已装好（llm 没有 stream 时为 false）
 */
export function wrapLlmForImmersive(llm, deps) {
  if (!llm || typeof llm.stream !== 'function') return false
  let holder = llm[HOLDER]
  if (!holder) {
    holder = { deps: null }
    try { Object.defineProperty(llm, HOLDER, { value: holder, enumerable: false, configurable: true }) } catch { llm[HOLDER] = holder }
  }
  holder.deps = deps
  if (typeof llm[WRAP_FLAG] === 'function') return true

  const rewrite = (options) => rewriteOptions(options, holder.deps)
  const boundStream = llm.stream.bind(llm)
  const boundPrepare = typeof llm.prepareCall === 'function' ? llm.prepareCall.bind(llm) : null
  const boundReg = typeof llm.streamWithRegistration === 'function' ? llm.streamWithRegistration.bind(llm) : null

  function immersiveStream(options) {
    return boundStream(rewrite(options))
  }

  async function immersivePrepareCall(config, signal, configure) {
    const prepared = await boundPrepare(rewrite(config), signal, configure)
    if (!prepared || typeof prepared.stream !== 'function') return prepared
    const innerStream = prepared.stream.bind(prepared)
    return Object.freeze({
      ...prepared,
      stream: (options) => innerStream(rewrite(options)),
      ...(typeof prepared.configure === 'function' ? { configure: prepared.configure.bind(prepared) } : {}),
    })
  }

  llm.stream = immersiveStream
  try { Object.defineProperty(llm, WRAP_FLAG, { value: immersiveStream, enumerable: false, configurable: true }) } catch { llm[WRAP_FLAG] = immersiveStream }
  if (boundPrepare) llm.prepareCall = immersivePrepareCall
  if (boundReg) {
    llm.streamWithRegistration = function streamWithRegistration(options, prepared) {
      return boundReg(rewrite(options), prepared)
    }
  }
  return true
}

/** 功能关闭 / 卸载：让已装好的包装层变成透传。 */
export function detachImmersiveWrap(llm) {
  const holder = llm?.[HOLDER]
  if (holder) holder.deps = null
}

export function isImmersiveWrapped(llm) {
  return typeof llm?.[WRAP_FLAG] === 'function'
}
