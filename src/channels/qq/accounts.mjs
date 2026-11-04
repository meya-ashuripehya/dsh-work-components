/** QQ v1：单账号 main；多 bot 以后再说。保持 accountId=main 以复用 ~/.dsh/dsh-channels/bindings.json 既有 qq:main:* 绑定。 */
export const MAIN_ACCOUNT = 'main'
export const DEFAULT_SECRET_REF = 'QQBOT_APP_SECRET'
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function secretRefOf(cfg) {
  const ref = String(cfg?.qqAppSecretRef || DEFAULT_SECRET_REF).trim()
  return REF_PATTERN.test(ref) ? ref : DEFAULT_SECRET_REF
}

/** 席位 → harness 路由（preset / provider / model / reasoningEffort）。QQ 只选一个席位，不用聊天室成员名册。 */
export function routeFromSeat(seat) {
  if (!seat || typeof seat !== 'object' || Array.isArray(seat)) return null
  const route = {}
  for (const key of ['preset', 'provider', 'model', 'reasoningEffort']) {
    const text = typeof seat[key] === 'string' ? seat[key].trim() : ''
    if (text) route[key] = text
  }
  return Object.keys(route).length ? route : null
}

/**
 * QQ 账号 main 的默认路由：
 * 1) 若设置了 qqSeatId，从席位池取该席位（单席位，不是多 AI 群聊名册）；
 * 2) 否则回退到旧键 qqPreset（纯预设 id）。
 * @param {object} cfg
 * @param {any[]} [seats] 席位池（通常为 resolveSeats(cfg) / cfg.chatroomSeats）
 */
export function accountRouteOf(cfg, seats) {
  const seatId = String(cfg?.qqSeatId || '').trim()
  if (seatId) {
    const list = Array.isArray(seats) ? seats : []
    const hit = list.find((s) => String(s?.id || '').trim() === seatId)
    if (hit) return routeFromSeat(hit)
    return null
  }
  const preset = String(cfg?.qqPreset || '').trim()
  return preset ? { preset } : null
}
