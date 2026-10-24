/**
 * 进程内原始 Telegram update 总线：同一令牌只由一处 getUpdates，
 * 其它订阅方（聊天室）从这里收。键是令牌 SHA-256 前 16 位，不存明文。
 *
 * lib/index.mjs 与 lib/channel-telegram.mjs 是两次独立打包，模块级单例各有一份；
 * 必须挂到 globalThis，通道 publish 才能被聊天室 subscribe 收到。
 */
import { createHash } from 'node:crypto'

export function tokenHash(token) {
  const t = String(token || '')
  if (!t) return ''
  return createHash('sha256').update(t).digest('hex').slice(0, 16)
}

/** @typedef {{ id: string, onUpdate: (raw: any, meta: { accountId?: string, tokenHash: string }) => void | Promise<void> }} RawSubscriber */

export function createRawHub() {
  /** @type {Map<string, RawSubscriber[]>} */
  const byHash = new Map()

  function subscribe(token, subscriber) {
    const h = tokenHash(token)
    if (!h || !subscriber?.id || typeof subscriber.onUpdate !== 'function') return () => {}
    const list = byHash.get(h) || []
    const next = list.filter((s) => s.id !== subscriber.id).concat([{ id: subscriber.id, onUpdate: subscriber.onUpdate }])
    byHash.set(h, next)
    return () => {
      const cur = byHash.get(h) || []
      const left = cur.filter((s) => s.id !== subscriber.id)
      if (left.length) byHash.set(h, left)
      else byHash.delete(h)
    }
  }

  async function publish(token, raw, meta = {}) {
    const h = tokenHash(token)
    if (!h) return false
    const list = byHash.get(h) || []
    if (!list.length) return false
    for (const s of list) {
      try { await s.onUpdate(raw, { ...meta, tokenHash: h }) } catch { /* 订阅方自己记日志 */ }
    }
    return true
  }

  function hasSubscribers(token) {
    const h = tokenHash(token)
    return !!(h && (byHash.get(h) || []).length)
  }

  function reset() { byHash.clear() }

  return { subscribe, publish, hasSubscribers, tokenHash, reset }
}

const GKEY = '__dshWorkbenchTelegramRawHub'
export const rawHub = globalThis[GKEY] || (globalThis[GKEY] = createRawHub())

/** 发现新群旁路：聊天室在创建时注册，通道在 hub 尚无订阅时也能写入 discovered。 */
const DKEY = '__dshWorkbenchChatroomDiscover'
export function setDiscoverHandler(fn) {
  if (typeof fn === 'function') globalThis[DKEY] = fn
  else delete globalThis[DKEY]
}
export async function noteDiscover(info) {
  const fn = globalThis[DKEY]
  if (typeof fn !== 'function') return false
  try { await fn(info); return true } catch { return false }
}
