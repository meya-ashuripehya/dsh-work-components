/**
 * 棋类 ↔ Telegram 通道的进程内桥。主包（lib/index.mjs）与通道运行时（lib/channel-telegram.mjs）是两个独立打包的文件，
 * 模块状态不共享，所以挂在 globalThis 的 Symbol.for 键上。通道关闭时运行时会清掉自己的一半；没有通道时一切照旧。
 *
 * 通道一半（运行时设置）：
 *   lookup(sessionId) → { chatId, threadId?, senderId, conversationType } | null   会话最近一条 Telegram 入站的来源
 *   sendPhoto({ chatId, threadId?, png, caption }) → messageId
 *   deletePhoto({ chatId, messageId }) → void（失败抛错：超过 48 小时、群里没权限）
 *   editPhoto({ chatId, messageId, png, caption }) → void（失败抛错）
 * 棋类一半（主包设置）：
 *   inbound({ chatId, senderId, conversationType, text }) → null | { notice } | { forward }
 */
const TELEGRAM = Symbol.for('dsh-workbench.boards.telegram')
const BOARDS = Symbol.for('dsh-workbench.boards.inbound')

export function setTelegramBridge(bridge) { globalThis[TELEGRAM] = bridge }
export function clearTelegramBridge(bridge) { if (globalThis[TELEGRAM] === bridge) delete globalThis[TELEGRAM] }
export function getTelegramBridge() { return globalThis[TELEGRAM] || null }

export function setBoardsInbound(fn) { globalThis[BOARDS] = fn }
export function clearBoardsInbound(fn) { if (globalThis[BOARDS] === fn) delete globalThis[BOARDS] }
export function getBoardsInbound() { return globalThis[BOARDS] || null }
