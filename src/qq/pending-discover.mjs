/**
 * QQ 未授权私聊 / 群聊发现：通道收到不在白名单里的 C2C 或未列入的群消息时，
 * 经 globalThis 桥记入待处理名单；设置页弹出通知，由用户授权或忽略。
 * 授权只能在本机设置页完成，没有任何聊天指令可以写白名单。
 *
 * 通道运行时（lib/channel-qq.mjs）与宿主（lib/index.mjs）是两次独立打包，
 * 记录处理函数挂在 globalThis 上（与 Telegram dm-discover 同模式）。
 * 这里只放纯函数和桥，不读写文件。
 */

const DKEY = '__dshWorkbenchQQPendingDiscover'

/** 宿主注册记录函数；传入非函数时注销。返回注销函数（只注销自己注册的那一个）。 */
export function setPendingDiscoverHandler(fn) {
  if (typeof fn !== 'function') { delete globalThis[DKEY]; return () => {} }
  globalThis[DKEY] = fn
  return () => { if (globalThis[DKEY] === fn) delete globalThis[DKEY] }
}

/** 通道运行时调用：宿主未注册时返回 false。从不抛错。 */
export async function notePendingDiscover(info) {
  const fn = globalThis[DKEY]
  if (typeof fn !== 'function') return false
  try { await fn(info); return true } catch { return false }
}

export function parseOpenIds(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

/** QQ OpenID / group_openid：官方 API 给出的不透明字符串（常见为 32 位十六进制）。 */
export function isOpenId(id) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(String(id ?? ''))
}

export const PREVIEW_MAX = 80
/** 授权回放进 harness 时保留的正文上限（远大于预览）。 */
export const REPLAY_TEXT_MAX = 8000

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * 从 harness 规范化入站事件取出消息预览。
 * content 为 parts 数组；缺正文时按类型给中文标签。
 */
export function previewOfEvent(event, max = PREVIEW_MAX) {
  const content = event?.message?.content
  if (!Array.isArray(content) || !content.length) return '[其他消息]'
  const texts = []
  let kind = ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) texts.push(part.text)
    else if (!kind) {
      kind = part.type === 'image' ? '[图片]'
        : part.type === 'video' ? '[视频]'
          : part.type === 'audio' ? '[语音]'
            : part.type === 'file' ? '[文件]'
              : part.type === 'unsupported' ? ''
                : ''
    }
  }
  const text = texts.join(' ').trim()
  if (text) return clip(kind ? kind + ' ' + text : text, max)
  return kind || '[其他消息]'
}

/** 拼接入站 text parts（保留换行），供授权后回放；无正文时回落预览标签。 */
export function textOfEvent(event, max = REPLAY_TEXT_MAX) {
  const content = event?.message?.content
  if (!Array.isArray(content) || !content.length) return ''
  const texts = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text)
    }
  }
  const joined = texts.join('\n').trim()
  if (joined) return joined.length > max ? joined.slice(0, max) : joined
  // 纯媒体：用预览标签占位，至少能进会话
  const preview = previewOfEvent(event, Math.min(max, PREVIEW_MAX))
  return preview === '[其他消息]' ? '' : preview
}

/**
 * 由设置与已存访问策略得出通道实际使用的私聊白名单（与 runtime.buildAccessPolicy 写入的一致）。
 * 填了所有者：[所有者, ...允许的其他用户]；没填：沿用已存策略（仅 allowlist 时）。不按白名单时返回 null。
 */
export function effectiveDmAllow(cfg, stored) {
  const owner = String(cfg?.qqOwnerOpenId ?? '').trim()
  if (owner) return [owner, ...parseOpenIds(cfg?.qqAllowFrom).filter((id) => id !== owner)]
  if (stored?.state === 'ok' && stored.dmPolicy === 'allowlist' && Array.isArray(stored.allowFrom)) {
    return stored.allowFrom.map(String)
  }
  return null
}

/**
 * 群发现策略摘要。
 * - open：不发现（所有群已放行）
 * - allowlist：不在 ids 里的群记 pending
 * - disabled：仍发现（用户可从 pending 择群加入并切到 allowlist）；ids 为空
 * 返回 { policy, ids }；policy 非法时按 disabled。
 */
export function effectiveGroupDiscover(cfg) {
  const policyRaw = String(cfg?.qqGroupPolicy ?? 'disabled').trim()
  const policy = (policyRaw === 'open' || policyRaw === 'allowlist' || policyRaw === 'disabled')
    ? policyRaw
    : 'disabled'
  const ids = policy === 'allowlist' ? parseOpenIds(cfg?.qqGroupIds) : []
  return { policy, ids }
}

export function isUnauthorizedDm(senderId, dmAllow) {
  if (!senderId || !Array.isArray(dmAllow)) return false
  return !dmAllow.map(String).includes(String(senderId))
}

/**
 * 是否应记入「未授权群」pending。
 * open 不记；allowlist 时群不在名单；disabled 时一律记（便于冷启动择群开通）。
 */
export function isUnauthorizedGroup(groupId, groupDiscover) {
  if (!groupId || !groupDiscover) return false
  if (!isOpenId(groupId)) return false
  if (groupDiscover.policy === 'open') return false
  if (groupDiscover.policy === 'disabled') return true
  // allowlist
  return !groupDiscover.ids.map(String).includes(String(groupId))
}

/**
 * 从 harness message.received 事件抽出发现信息。
 * 返回 { kind:'dm'|'group', ... } 或 null。
 * 额外字段供授权后回放：messageId / text / mentionedBot / accountId。
 */
export function pendingInfoOfEvent(event, { dmAllow = null, groupDiscover = null } = {}) {
  if (!event || event.type !== 'message.received') return null
  const type = event.conversation?.type
  const senderId = String(event.sender?.id ?? '')
  const conversationId = String(event.conversation?.id ?? '')
  const preview = previewOfEvent(event)
  const text = textOfEvent(event)
  const messageId = typeof event.message?.id === 'string' ? event.message.id
    : (event.message?.id != null ? String(event.message.id) : '')
  const name = typeof event.sender?.name === 'string' ? event.sender.name.slice(0, 120) : ''
  const accountId = String(event.accountId || 'main').slice(0, 40)
  const mentionedBot = event.message?.activation?.mentionedBot === true
  if (type === 'dm') {
    if (!isOpenId(senderId)) return null
    if (!isUnauthorizedDm(senderId, dmAllow)) return null
    return {
      kind: 'dm',
      userId: senderId,
      name,
      preview,
      text,
      messageId,
      accountId,
    }
  }
  if (type === 'group') {
    if (!isOpenId(conversationId)) return null
    if (!isUnauthorizedGroup(conversationId, groupDiscover)) return null
    return {
      kind: 'group',
      groupId: conversationId,
      name: '', // QQ 入站事件通常不带群名
      preview,
      text,
      messageId,
      mentionedBot,
      lastSenderId: isOpenId(senderId) ? senderId : '',
      lastSenderName: name,
      accountId,
    }
  }
  return null
}

/**
 * 由 pending 记录构造可再投递的 message.received（授权后回放）。
 * 群聊默认 mentionedBot=true（进 pending 的群消息多为 AT 事件）；显式 false 时保留。
 */
export function buildReplayEvent(info, { channel = 'qq' } = {}) {
  if (!info || typeof info !== 'object') return null
  const kind = info.kind === 'group' || info.groupId ? 'group' : 'dm'
  const conversationId = kind === 'group' ? String(info.groupId ?? '') : String(info.userId ?? '')
  const senderId = kind === 'group'
    ? String(info.lastSenderId ?? '')
    : String(info.userId ?? '')
  if (!isOpenId(conversationId) || !isOpenId(senderId)) return null
  const text = String(info.lastText || info.text || info.lastPreview || info.preview || '').trim()
  if (!text) return null
  const messageId = String(info.lastMessageId || info.messageId || '').trim()
    || `pending-replay-${conversationId}-${Date.now()}`
  const name = kind === 'group'
    ? String(info.lastSenderName || '').slice(0, 120)
    : String(info.name || '').slice(0, 120)
  const event = {
    type: 'message.received',
    channel,
    accountId: String(info.accountId || 'main').slice(0, 40),
    conversation: { id: conversationId, type: kind === 'group' ? 'group' : 'dm' },
    sender: { id: senderId, ...(name ? { name } : {}) },
    message: {
      id: messageId,
      content: [{ type: 'text', text: text.slice(0, REPLAY_TEXT_MAX) }],
      createdAt: Date.now(),
    },
  }
  if (kind === 'group') {
    const mentioned = info.lastMentionedBot === false || info.mentionedBot === false
      ? false
      : true
    event.message.activation = { mentionedBot: mentioned }
  }
  return event
}
