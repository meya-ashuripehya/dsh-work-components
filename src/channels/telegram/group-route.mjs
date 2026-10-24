/**
 * 群聊预设：Telegram 群 / 超级群的聊天 ID 恒为负数，私聊为正数。
 * 某个账号的群预设非空时，该账号的群会话改用它，并保留该账号路由上的模型与推理强度。
 * 会话级覆盖仍然优先。留空则保持原路由（该账号的预设覆盖 → 通道覆盖 → 默认预设）。
 * 「*」表示所有账号（旧的整通道群预设）。
 * 聊天室已绑定的群记在排除表里：访问策略不再收录这些群，入站分发也不把它们送进通道会话。
 * 挂 AgentRouter 原型，不改 vendor 补丁文件。
 */
let groupRoutes = new Map()
let excludedChats = new Set()

export function setExcludedGroupChats(ids) {
  excludedChats = new Set((ids || []).map((id) => String(id ?? '').trim()).filter(Boolean))
}

export function isExcludedGroupChat(id) {
  const key = String(id ?? '').trim()
  return key !== '' && excludedChats.has(key)
}

/** 从群 ID 文本里去掉聊天室已绑定的群。 */
export function excludeBoundChatIds(raw, bound) {
  const banned = new Set((bound || []).map((id) => String(id ?? '').trim()).filter(Boolean))
  return String(raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter((id) => id && !banned.has(id)).join('\n')
}

export function setGroupPreset(preset, channelId = 'telegram') {
  const p = String(preset ?? '').trim()
  groupRoutes = new Map(p ? [['*', { channelId, route: { preset: p } }]] : [])
}

/** 按账号写入群预设。传入的表会整表替换，账号不在表里就沿用该账号自己的私聊预设。 */
export function setGroupPresets(entries, channelId = 'telegram') {
  const next = new Map()
  for (const [accountId, preset] of Object.entries(entries || {})) {
    const id = String(accountId ?? '').trim()
    const p = String(preset ?? '').trim()
    if (id && p) next.set(id, { channelId, route: { preset: p } })
  }
  groupRoutes = next
}

export function isGroupConversationId(id) {
  return /^-\d+$/.test(String(id ?? '').trim())
}

export function installGroupRoute(AgentRouter) {
  const proto = AgentRouter?.prototype
  if (!proto || proto.__dshGroupRoute) return
  const original = proto.resolve
  proto.resolve = function resolve(input) {
    const g = groupRoutes.get(input?.accountId) || groupRoutes.get('*')
    if (g && input?.channelId === g.channelId && isGroupConversationId(input.conversationId)) {
      const explicit = this.config?.routing?.overrides?.conversation?.[input.conversationId]
      if (!explicit) {
        const account = this.config?.routing?.overrides?.account?.[input.accountId] || {}
        const fallback = this.config?.agent?.default || {}
        return { ...fallback, ...account, ...g.route }
      }
    }
    return original.call(this, input)
  }
  Object.defineProperty(proto, '__dshGroupRoute', { value: true })
}