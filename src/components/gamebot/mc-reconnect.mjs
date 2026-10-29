/** 进世界自动连接固定为开：世界从不可连变为可连时，再对齐一次已启用座位。 */
import net from 'node:net'

export function bridgePort(url) {
  const raw = String(url || '').trim() || 'ws://127.0.0.1:8765'
  try {
    const parsed = new URL(raw)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : 8765
  } catch {
    return 8765
  }
}

/**
 * state 是上一次探测：null 还没探过，true 可连，false 不可连。
 * 只有 false → true 才再 reconcile。启用卡片时的那一次不在这里。
 */
export function shouldReconcile(autoConnect, state, open) {
  if (String(autoConnect) !== '1') return { state, reconcile: false }
  const up = open === true
  if (state === false && up) return { state: true, reconcile: true }
  return { state: up, reconcile: false }
}

export function probePort(port, { timeoutMs = 400, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let socket
    const done = (open) => {
      try { socket?.removeAllListeners?.() } catch { /* already closed */ }
      try { socket?.destroy?.() } catch { /* already closed */ }
      resolve(open)
    }
    try {
      socket = connect({ host: '127.0.0.1', port, timeout: timeoutMs })
    } catch {
      resolve(false)
      return
    }
    socket.once?.('connect', () => done(true))
    socket.once?.('timeout', () => done(false))
    socket.once?.('error', () => done(false))
  })
}
