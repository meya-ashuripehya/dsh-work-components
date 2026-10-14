/**
 * 棋局自动转发到 Telegram。
 *
 * 识别：board_open 执行时拿到 exec.agent.id（会话 ID），向通道桥查询这个会话最近一条 Telegram 入站的来源
 * （通道运行时在 ReplyContextStore.register 里记下 chat.id / 发送者）。查到即把棋局绑定到该聊天；查不到（桌面会话、
 * 未启用通道）就不绑定，行为与以前完全一样。
 * 投递：开局、每一步（AI 的 board_play、网页 /boards/move、Telegram 文字走子）、终局，都由插件把棋盘 PNG 发到该聊天。
 * 每次都在聊天底部发一张新图，再删掉上一张（删不掉——超过 48 小时、群里没权限——就留着）。最新一张的 messageId 写进存档。
 * 人走子时不等出图就唤醒 AI（出图排在后台队列里，AI 的 board_play 出图排在它后面，顺序不乱）。
 * 走子：该聊天里的文字（e2e4、炮二平五、H8）在有棋局时先交给规则判定；开头一步后跟一句话（「H9，你怎么下？」）
 * 时落子并把这句话一起交给 AI。群里只有发起人或指定对手能走。
 */
import { BoardError } from './errors.mjs'
import { displayMove, looksLikeMove, splitLeadingMove } from './notation.mjs'
import { renderBoard } from './render.mjs'
import { lookSession, onSessionChange, playSession, saveSessionNow, sessionLabel, sessionOrigin } from './session.mjs'
import { clearBoardsInbound, getTelegramBridge, setBoardsInbound } from './telegram-bridge.mjs'
import { sameAccount } from '../channels/telegram/accounts.mjs'

export const ILLEGAL_NOTICE = '这步不在合法着法里'
export const NOT_PLAYER_NOTICE = '只有发起这局的人（或指定的对手）可以走棋'
export const AI_TURN_NOTICE = '现在是 AI 的回合'

/** 由会话 ID 判断这局是否来自 Telegram；是则返回要绑定的来源。opponent 为可选的对手 Telegram 用户 ID。 */
export function telegramOriginFor(sessionId, opponent) {
  const bridge = getTelegramBridge()
  if (!bridge || !sessionId) return null
  let hit
  try { hit = bridge.lookup(String(sessionId)) } catch { hit = null }
  if (!hit || hit.chatId === undefined || hit.chatId === null || hit.chatId === '') return null
  const opp = String(opponent ?? '').trim()
  return {
    channel: 'telegram',
    chatId: String(hit.chatId),
    ...(hit.threadId ? { threadId: String(hit.threadId) } : {}),
    conversationType: hit.conversationType === 'group' ? 'group' : 'dm',
    starterId: hit.senderId ? String(hit.senderId) : '',
    ...(hit.accountId ? { accountId: String(hit.accountId) } : {}),
    ...(/^-?\d{1,20}$/.test(opp) ? { opponentId: opp } : {}),
    messageId: null,
  }
}

/** 图片说明，一行。 */
export function captionFor(event) {
  const view = event.view
  const label = view.label
  if (view.over) {
    const reason = view.over.reason ? `（${view.over.reason}）` : ''
    if (view.over.side) return `${label}终局：${sessionLabel(view.over.side)}胜${reason}`
    return `${label}终局：和棋${reason}`
  }
  if (event.type === 'open' && event.resumed) return `${label}续局（已走 ${view.moveCount} 步），AI 执${view.aiLabel}，轮到${sessionLabel(view.turnSide)}`
  if (event.type === 'open' && event.reset) return `${label}重新开局，AI 执${view.aiLabel}，轮到${sessionLabel(view.turnSide)}`
  if (event.type === 'open') return `${label}开局，AI 执${view.aiLabel}，轮到${sessionLabel(view.turnSide)}`
  const move = displayMove(view.game, event.notation, event.side)
  return `${sessionLabel(event.side)}：${move}，轮到${sessionLabel(view.turnSide)}`
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('telegram send timeout')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** 把当前局面作为一张新图发到绑定的聊天底部，再删掉上一张。返回 'sent' | 'skipped'。 */
export async function publishBoard(event, { timeoutMs = 15000 } = {}) {
  const origin = event.origin
  if (!origin || origin.channel !== 'telegram') return 'skipped'
  const bridge = getTelegramBridge()
  if (!bridge) return 'skipped'
  const { png } = renderBoard(event.view, event.last)
  const caption = captionFor(event)
  const previous = origin.messageId ? String(origin.messageId) : ''
  const messageId = await withTimeout(Promise.resolve(bridge.sendPhoto({
    chatId: origin.chatId,
    ...(origin.threadId ? { threadId: origin.threadId } : {}),
    ...(origin.accountId ? { accountId: origin.accountId } : {}),
    png,
    caption,
  })), timeoutMs)
  if (messageId !== undefined && messageId !== null) origin.messageId = String(messageId)
  if (previous && previous !== origin.messageId && typeof bridge.deletePhoto === 'function') {
    // 超过 48 小时、群里没有删除权限、已被手动删掉：都留着不管。
    try { await withTimeout(Promise.resolve(bridge.deletePhoto({ chatId: origin.chatId, messageId: previous, ...(origin.accountId ? { accountId: origin.accountId } : {}) })), timeoutMs) } catch { /* keep */ }
  }
  return 'sent'
}

function sentence(text) {
  return /[。！？!?…~～.]$/.test(text) ? text : `${text}。`
}

/**
 * Telegram 入站文字走子。返回 null（不是给棋局的，照常交给 AI）/ { notice }（回一句，不唤醒 AI）/ { forward }（已落子，把这句交给 AI）。
 * 整句是一步：照旧。开头一步 + 分隔符 + 一句话：合法则落子并连同这句话转给 AI；不合法回「这步不在合法着法里」不转发；
 * 混合消息遇到不是玩家 / 不是人的回合时当普通聊天放过（null），免得把聊天吞掉。
 */
export async function handleBoardInbound({ chatId, senderId, accountId, text }) {
  const origin = sessionOrigin()
  if (!origin || origin.channel !== 'telegram' || String(chatId) !== origin.chatId) return null
  if (!sameAccount(origin.accountId, accountId)) return null
  let view
  try { view = lookSession() } catch { return null }
  if (view.over) return null
  const whole = looksLikeMove(view.game, text)
  const split = whole ? null : splitLeadingMove(view.game, text)
  if (!whole && !split) return null
  const move = whole ? text : split.move
  const said = whole ? '' : split.rest
  const sender = String(senderId ?? '')
  if (origin.conversationType === 'group') {
    const players = new Set([origin.starterId, origin.opponentId].filter(Boolean))
    if (!players.has(sender)) return said ? null : { notice: NOT_PLAYER_NOTICE }
  }
  if (view.turn !== 'human') return said ? null : { notice: AI_TURN_NOTICE }
  try {
    const played = await playSession(move, 'human')
    const name = played.view.playerName
    const saying = said ? `，并说：${sentence(said)}` : '。'
    if (played.view.over) {
      // 人这一步结束了棋局：告诉 AI 结果，而不是「现在是你的回合」。
      const result = captionFor({ type: 'move', view: played.view, side: view.humanSide, notation: played.notation })
      return { forward: `${name}下在了${played.notation}${saying}${result}。可以调用 board_close。` }
    }
    if (!said) return { forward: played.prompt }
    return { forward: `${name}下在了${played.notation}${saying}现在是你的回合` }
  } catch (error) {
    if (error instanceof BoardError && error.status === 409) return { notice: error.message }
    return { notice: ILLEGAL_NOTICE }
  }
}

let chain = Promise.resolve()

/** 等后台出图队列跑完（测试与关闭时用）。 */
export function whenBoardsPublished() {
  return chain
}

/** 启用棋类时挂上：监听棋局变化并投递、接管 Telegram 入站走子。返回 dispose。 */
export function installBoardsTelegram({ logger } = {}) {
  const off = onSessionChange((event) => {
    if (event.type === 'close' || !event.origin) return undefined
    const background = event.who === 'human'
    const job = chain.then(() => publishBoard(event)).then(() => {
      // 后台出图时 playSession 已经写过存档，这里补写新的 messageId。
      if (background && sessionOrigin() === event.origin) saveSessionNow()
    }).catch((error) => {
      logger?.warn?.('dsh-workbench: board image to telegram failed', String(error?.message ?? error).slice(0, 160))
    })
    chain = job
    // 人走子：不等出图，立刻把这步交给 AI（以前要等 sendPhoto / editMessageMedia 往返才唤醒 AI）。
    return background ? undefined : job
  })
  setBoardsInbound(handleBoardInbound)
  return () => {
    off()
    clearBoardsInbound(handleBoardInbound)
  }
}