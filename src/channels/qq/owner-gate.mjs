/**
 * QQ 通道授权闸门：复用 Telegram 通道的同一套 tools.guard / ReplyContextStore 挂钩。
 * 发送者 ID 为 QQ OpenID（字符串），与数字 Telegram 用户 ID 同样按字符串白名单比对。
 */
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
  resolveAuthorizedIds,
  installOwnerGate,
} from '../telegram/owner-gate.mjs'
