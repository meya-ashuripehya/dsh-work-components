/**
 * 跨产物共享的小桥。
 *
 * lib/index.mjs、lib/channel-qq.mjs、lib/channel-telegram.mjs 是三份各自打包的产物，
 * 每份里的模块级变量互不相通（owner-gate 的 activeGate 就是这样：通道产物里设置，
 * 主产物里读不到）。沉浸模式需要两处跨产物信息，所以用 globalThis 上的 Symbol.for 共享，
 * 与 boards / cards 的桥同一做法：
 *   - 通道产物 → 主产物：各通道把自己的所有者闸门登记进来，主产物判断「当前这一轮是不是所有者」；
 *   - 主产物 → 通道产物：主产物登记「这个会话是不是沉浸前台」，通道产物里的回复管线据此隐藏工具/思考过程。
 */
const KEY = Symbol.for('dsh-workbench.immersive.bridge')

function state() {
  let s = globalThis[KEY]
  if (!s) {
    s = { gates: new Set(), hidden: null }
    globalThis[KEY] = s
  }
  return s
}

/** 通道运行时调用：登记本通道的所有者闸门，返回注销函数。 */
export function registerOwnerGate(gate) {
  if (!gate || typeof gate.isAuthorizedTurn !== 'function') return () => {}
  state().gates.add(gate)
  return () => { state().gates.delete(gate) }
}

/**
 * 这个会话当前这一轮是不是「所有者」触发的。
 * 没有任何通道登记 / 会话不是通道回合 → 视为所有者（桌面里自己在用）；
 * 任一通道判定为非授权，或判定时出错 → 不是所有者（失败即关闭）。
 */
export function isOwnerTurn(sessionId) {
  for (const gate of state().gates) {
    try {
      if (gate.isAuthorizedTurn(sessionId) === false) return false
    } catch {
      return false
    }
  }
  return true
}

/** 主产物调用：登记「会话是否为沉浸前台」的判断函数，返回注销函数。 */
export function setHiddenPredicate(fn) {
  const s = state()
  s.hidden = typeof fn === 'function' ? fn : null
  return () => { if (s.hidden === fn) s.hidden = null }
}

/** 通道产物调用：这个会话的工具调用 / 思考过程要不要对外隐藏。 */
export function isHiddenSession(sessionId) {
  try { return state().hidden?.(String(sessionId ?? '')) === true } catch { return false }
}

/** 仅测试用：清空共享状态。 */
export function resetBridgeForTest() {
  const s = state()
  s.gates.clear()
  s.hidden = null
}
