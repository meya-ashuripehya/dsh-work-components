/**
 * 接收机器人的私聊登记：telegram 用户 id → 私聊 chat id。
 * 手牌只发到这里。未 /start 的 Telegram 座位不能发牌。
 */
const byUser = new Map()

export function registerCardDm(userId, chatId) {
  const id = String(userId || '').trim()
  const chat = String(chatId || '').trim()
  if (!id || !chat) return false
  byUser.set(id, chat)
  return true
}

export function cardDmOf(userId) {
  return byUser.get(String(userId || '').trim()) || ''
}

export function resetCardDms() {
  byUser.clear()
}

/** 还没私聊 /start 的 Telegram 人类座位名字。桌面座位不需要登记。 */
export function missingCardDms(seats) {
  const missing = []
  for (const seat of seats || []) {
    if (!seat || typeof seat !== 'object' || seat.kind !== 'human' || seat.local === true) continue
    const tg = String(seat.telegramUserId || '').trim()
    if (!tg || tg === 'local') continue
    if (!cardDmOf(tg)) missing.push(seat.name || tg)
  }
  return missing
}
