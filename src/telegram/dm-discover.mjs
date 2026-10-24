/**
 * 未授权私聊发现：通道机器人收到「不在私聊白名单里的账号」发来的私聊时，记一条待处理记录，
 * 设置页弹出通知，由用户在设置页决定授权或忽略。授权只能在本机设置页完成，没有任何聊天指令可以授权。
 *
 * 通道运行时（lib/channel-telegram.mjs）与宿主（lib/index.mjs）是两次独立打包，
 * 记录处理函数挂在 globalThis 上，与 raw-hub 的发现新群旁路相同。
 * 这里只放纯函数和桥，不读写文件。
 */

const DKEY = '__dshWorkbenchTelegramDmDiscover'

/** 宿主注册记录函数；传入非函数时注销。返回注销函数（只注销自己注册的那一个）。 */
export function setDmDiscoverHandler(fn) {
  if (typeof fn !== 'function') { delete globalThis[DKEY]; return () => {} }
  globalThis[DKEY] = fn
  return () => { if (globalThis[DKEY] === fn) delete globalThis[DKEY] }
}

/** 通道运行时调用：宿主未注册时返回 false。从不抛错。 */
export async function noteDmDiscover(info) {
  const fn = globalThis[DKEY]
  if (typeof fn !== 'function') return false
  try { await fn(info); return true } catch { return false }
}

export function parseUserIds(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))]
}

const USER_ID = /^\d{1,20}$/
export function isUserId(id) { return USER_ID.test(String(id ?? '')) }

export const PREVIEW_MAX = 80

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** 消息预览：正文或说明文字截断；没有文字时给类型标签。 */
export function previewOf(message, max = PREVIEW_MAX) {
  if (!message || typeof message !== 'object') return ''
  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
  const kind = message.photo ? '[图片]'
    : message.video ? '[视频]'
      : message.voice ? '[语音]'
        : message.audio ? '[音频]'
          : message.sticker ? '[贴纸]'
            : message.animation ? '[动图]'
              : message.document ? '[文件]'
                : message.location || message.venue ? '[位置]'
                  : message.contact ? '[联系人]'
                    : ''
  if (text) return clip(kind ? kind + ' ' + text : text, max)
  return kind || '[其他消息]'
}

/**
 * 从原始 update 取出私聊发送者；不是私聊、来自机器人或缺少发送者时返回 null。
 * 只看新消息和编辑消息（不看按钮回调等）。
 */
export function dmSenderOf(raw) {
  const m = raw?.message || raw?.edited_message
  if (!m || m.chat?.type !== 'private') return null
  const from = m.from
  if (!from || from.is_bot) return null
  const userId = String(from.id ?? '')
  if (!isUserId(userId)) return null
  // 私聊的 chat.id 就是对方的用户 ID；不一致的更新不记录。
  if (m.chat.id != null && String(m.chat.id) !== userId) return null
  const name = [from.first_name, from.last_name].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim()
  const at = Number(m.date) > 0 ? new Date(Number(m.date) * 1000).toISOString() : new Date().toISOString()
  return {
    userId,
    username: typeof from.username === 'string' ? from.username.slice(0, 64) : '',
    name: name.slice(0, 120),
    preview: previewOf(m),
    at,
  }
}

/**
 * 通道运行时判定：dmAllow 为 null 表示私聊不按白名单（open / disabled / 无策略），不记录；
 * 否则发送者不在白名单里就是未授权。
 */
export function isUnauthorizedDm(sender, dmAllow) {
  if (!sender?.userId || !Array.isArray(dmAllow)) return false
  return !dmAllow.map(String).includes(String(sender.userId))
}

/**
 * 由设置与已存访问策略得出通道实际使用的私聊白名单（与 runtime.buildAccessPolicy 写入的一致）。
 * 填了所有者：[所有者, ...允许的其他用户]；没填：沿用已存策略（仅 allowlist 时）。不按白名单时返回 null。
 */
export function effectiveDmAllow(cfg, stored) {
  const owner = String(cfg?.telegramOwnerId ?? '').trim()
  if (owner) return [owner, ...parseUserIds(cfg?.telegramAllowFrom).filter((id) => id !== owner)]
  if (stored?.state === 'ok' && stored.dmPolicy === 'allowlist' && Array.isArray(stored.allowFrom)) return stored.allowFrom.map(String)
  return null
}
