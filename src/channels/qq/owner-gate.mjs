/**
 * QQ 通道授权闸门：复用 Telegram 通道的同一套 tools.guard / ReplyContextStore 挂钩。
 * 发送者 ID 为 QQ OpenID（字符串），与数字 Telegram 用户 ID 同样按字符串白名单比对。
 * 授权名单的形状校验在本文件：OpenID，不用 Telegram 的数字用户 ID 规则。
 */
import { isOpenId, parseOpenIds } from '../../qq/pending-discover.mjs'

export {
  DENY_MESSAGE,
  OPEN_TOOLS,
  OWNER_ONLY_PREFIXES,
  OPEN_PREFIXES,
  isOwnerOnlyTool,
  isOpenTool,
  createOwnerGate,
  setActiveGate,
  clearActiveGate,
  installOwnerGate,
} from '../telegram/owner-gate.mjs'

/** 解析「授权用户 OpenID」：填写的列表优先，留空时回退到所有者 OpenID。 */
export function resolveAuthorizedIds(authorizedRaw, ownerId) {
  const list = parseOpenIds(authorizedRaw)
  for (const id of list) {
    if (!isOpenId(id)) throw new Error(`授权用户 OpenID「${id}」无效（应为 QQ 开放平台 OpenID）`)
  }
  if (list.length) return list
  const owner = String(ownerId ?? '').trim()
  return owner ? [owner] : []
}
