/**
 * Telegram 群聊 ID 互斥：一个群要么由 Telegram 通道接管（telegramGroupIds），要么绑定到聊天室房间，不能两边同时配置。
 * 通道设置保存、房间绑定（设置页保存、「发现新群」一键绑定、群内 /bind）共用这里的比较与提示文案。
 *
 * 比较前统一规范化：数字与字符串一视同仁；超级群的 -100 前缀可省略（-1001234567890、1234567890 视为同一个群）。
 */

/** 规范化为比较键：去空白与正负号；形如 100 + 10 位以上数字的（超级群）去掉 100 前缀。无效输入返回 ''。 */
export function chatIdKey(id) {
  const s = String(id ?? '').trim().replace(/^[-−]/, '')
  if (!/^\d{5,20}$/.test(s)) return ''
  return s.length >= 13 && s.startsWith('100') ? s.slice(3) : s
}

/** 把群 ID 文本（逗号、空格、换行分隔）或数组拆成列表，保留原样写法。 */
export function splitChatIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，;；]+/)
  return list.map((x) => String(x ?? '').trim()).filter(Boolean)
}

/**
 * 通道群 ID 与房间绑定的冲突。
 * @param ids 准备加入通道的群 ID（文本或数组）
 * @param rooms [{ id, title, telegramChatIds }]
 * @returns [{ chatId, roomId, roomTitle }]
 */
export function findRoomConflicts(ids, rooms) {
  const owner = new Map()
  for (const r of rooms || []) for (const c of r?.telegramChatIds || []) {
    const k = chatIdKey(c)
    if (k && !owner.has(k)) owner.set(k, r)
  }
  const out = []
  const seen = new Set()
  for (const id of splitChatIds(ids)) {
    const k = chatIdKey(id)
    if (!k || seen.has(k) || !owner.has(k)) continue
    seen.add(k)
    const r = owner.get(k)
    out.push({ chatId: id, roomId: r.id, roomTitle: r.title || r.id })
  }
  return out
}

/** 准备绑定到房间的群里，哪些已在 Telegram 通道的群 ID 中。返回原样写法的 ID 列表。 */
export function findChannelConflicts(ids, channelGroupIds) {
  const configured = new Set(splitChatIds(channelGroupIds).map(chatIdKey).filter(Boolean))
  const out = []
  const seen = new Set()
  for (const id of splitChatIds(ids)) {
    const k = chatIdKey(id)
    if (!k || seen.has(k) || !configured.has(k)) continue
    seen.add(k)
    out.push(id)
  }
  return out
}

export function roomConflictMessage(conflicts) {
  return conflicts.map((c) => `群聊 ${c.chatId} 已绑定到聊天室「${c.roomTitle}」，不能再加入通道`).join('；') + '。如需改由通道接管，请先在聊天室中解除绑定。'
}

export function channelConflictMessage(ids) {
  return `群聊 ${ids.join('、')} 已在 Telegram 通道中配置，请先从通道移除后再绑定到聊天室。`
}
