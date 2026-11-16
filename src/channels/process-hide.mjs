/**
 * 沉浸前台会话的「过程」不对外显示：不发工具调用提示（「正在调用 xxx」）、不发思考过程。
 *
 * channel-harness 的 ReplyRouter 用 replyOpts() 决定是否显示工具调用 / 思考；QQ 运行时写死 showToolCalls:true，
 * Telegram 由设置控制，且都是全局的。这里不改 vendor，也不改全局设置：在原型上包 onSessionEvent / onAssistantStream，
 * 处理某个会话的事件期间把一个标记挂在实例上，replyOpts() 看到标记就把这两项压成 false。
 * 判断「这个会话是不是沉浸前台」走 immersive/bridge（主产物登记、通道产物读取）。
 *
 * 只影响显示：工具结果里的图片仍会照常收集并出站（collectToolResultImages 不看这两项）。
 * 与 owner-gate / place / calendar 一样挂原型、只挂一次。
 */
import { isHiddenSession } from '../immersive/bridge.mjs'

function sessionIdOf(value) {
  return String(value?.session?.id ?? value?.id ?? '')
}

export function installProcessHide(ReplyRouter) {
  const proto = ReplyRouter?.prototype
  if (!proto || proto.__dshProcessHide) return
  const origOpts = proto.replyOpts
  const origEvent = proto.onSessionEvent
  const origStream = proto.onAssistantStream
  if (typeof origOpts !== 'function' || typeof origEvent !== 'function' || typeof origStream !== 'function') return

  function withHide(self, sessionId, fn) {
    const prev = self.__dshHideProcess
    self.__dshHideProcess = sessionId ? isHiddenSession(sessionId) : false
    try { return fn() } finally { self.__dshHideProcess = prev }
  }

  proto.replyOpts = function replyOpts(...args) {
    const opts = origOpts.apply(this, args)
    return this.__dshHideProcess === true ? { ...opts, showToolCalls: false, sendReasoning: false } : opts
  }
  proto.onSessionEvent = function onSessionEvent(session, event) {
    return withHide(this, String(session?.id ?? ''), () => origEvent.call(this, session, event))
  }
  proto.onAssistantStream = function onAssistantStream(agent, frame) {
    return withHide(this, sessionIdOf(agent), () => origStream.call(this, agent, frame))
  }
  Object.defineProperty(proto, '__dshProcessHide', { value: true })
}
