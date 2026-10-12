/**
 * 群聊预设：Telegram 群 / 超级群的聊天 ID 恒为负数，私聊为正数。
 * 「群聊使用的预设」非空时，群会话改用该预设；会话级覆盖仍然优先。留空则保持原路由（通道覆盖 → 默认预设）。
 * 挂 AgentRouter 原型，不改 vendor 补丁文件。
 */
let groupRoute = null

export function setGroupPreset(preset, channelId = 'telegram') {
  const p = String(preset ?? '').trim()
  groupRoute = p ? { channelId, route: { preset: p } } : null
}

export function isGroupConversationId(id) {
  return /^-\d+$/.test(String(id ?? '').trim())
}

export function installGroupRoute(AgentRouter) {
  const proto = AgentRouter?.prototype
  if (!proto || proto.__dshGroupRoute) return
  const original = proto.resolve
  proto.resolve = function resolve(input) {
    const g = groupRoute
    if (g && input?.channelId === g.channelId && isGroupConversationId(input.conversationId)) {
      const explicit = this.config?.routing?.overrides?.conversation?.[input.conversationId]
      if (!explicit) return g.route
    }
    return original.call(this, input)
  }
  Object.defineProperty(proto, '__dshGroupRoute', { value: true })
}