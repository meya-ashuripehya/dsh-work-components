import { CardError } from './errors.mjs'
import { contextKey } from './context.mjs'
import { interpret, verbOf } from './games/index.mjs'
import { renderTable } from './render.mjs'
import { listSessions, lookSession, onSessionChange, playSession, saveSessionNow, stripPrivate } from './session.mjs'
import { clearCardsInbound, setCardsInbound } from './telegram-bridge.mjs'
import { getTelegramBridge } from '../boards/telegram-bridge.mjs'
import { sameAccount } from '../channels/telegram/accounts.mjs'

export const ILLEGAL_NOTICE = '只能说 hit、stand、要牌或停牌'
export const NOT_PLAYER_NOTICE = '只有发起这手的人可以要牌或停牌'

export function telegramOriginFor(sessionId) {
  const bridge = getTelegramBridge()
  if (!bridge || !sessionId) return null
  let hit
  try { hit = bridge.lookup(String(sessionId)) } catch { hit = null }
  if (!hit || hit.chatId === undefined || hit.chatId === null || hit.chatId === '') return null
  return {
    channel: 'telegram',
    chatId: String(hit.chatId),
    ...(hit.threadId ? { threadId: String(hit.threadId) } : {}),
    conversationType: hit.conversationType === 'group' ? 'group' : 'dm',
    starterId: hit.senderId ? String(hit.senderId) : '',
    ...(hit.accountId ? { accountId: String(hit.accountId) } : {}),
    messageId: null,
  }
}

function visibleCards(cards) {
  return (cards || []).map((card) => (card?.hidden ? '暗牌' : card.code)).join(' ')
}

export function captionFor(event) {
  const view = event.view?.mode === 'room' ? stripPrivate(event.view) : event.view
  if (view.game && view.game !== 'blackjack') {
    const head = view.over ? '终局' : event.type === 'open' && event.resumed ? '续局' : event.type === 'open' && event.reset ? '重开' : event.type === 'open' ? '开局' : (verbOf(view.game, event.action) || '出牌')
    return `${view.label} ${head}：${view.caption}`
  }
  const player = visibleCards(view.player)
  const dealer = visibleCards(view.dealer)
  if (view.over) {
    const winner = view.over.winner === 'player' ? '玩家胜' : view.over.winner === 'dealer' ? '庄家胜' : '和局'
    return `二十一点终局：${winner}（${view.over.reason}）玩家 ${player}，庄家 ${dealer}`
  }
  if (event.type === 'open' && event.resumed) return `二十一点续局，玩家 ${player}（${view.playerScore}），庄家 ${dealer}`
  if (event.type === 'open' && event.reset) return `二十一点重新开局，玩家 ${player}（${view.playerScore}），庄家 ${dealer}`
  if (event.type === 'open') return `二十一点开局，玩家 ${player}（${view.playerScore}），庄家 ${dealer}`
  const verb = event.action === 'stand' ? '停牌' : '要牌'
  return `${verb}，玩家 ${player}（${view.playerScore}），庄家 ${dealer}`
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('telegram send timeout')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export async function publishTable(event, { timeoutMs = 15000 } = {}) {
  const origin = event.origin
  if (!origin || origin.channel !== 'telegram') return 'skipped'
  const bridge = getTelegramBridge()
  if (!bridge) return 'skipped'
  const shown = event.view?.mode === 'room' ? stripPrivate(event.view) : event.view
  const { png } = renderTable(shown)
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
    try { await withTimeout(Promise.resolve(bridge.deletePhoto({ chatId: origin.chatId, messageId: previous, ...(origin.accountId ? { accountId: origin.accountId } : {}) })), timeoutMs) } catch { /* keep */ }
  }
  return 'sent'
}

function sentence(text) {
  return /[。！？!?…~～.]$/.test(text) ? text : `${text}。`
}

export async function handleCardInbound({ chatId, senderId, accountId, text }) {
  const session = listSessions().find((s) => {
    const origin = s.origin
    return origin?.channel === 'telegram' && String(origin.chatId) === String(chatId) && sameAccount(origin.accountId, accountId) && !String(s.contextKey).startsWith('room:')
  })
  if (!session) return null
  const origin = session.origin
  const key = session.contextKey
  if (contextKey({ origin }) !== key) return null
  let view
  try { view = lookSession(key) } catch { return null }
  if (view.over) return null
  const spoken = interpret(view.game, text, view.legal)
  if (!spoken) return null
  const sender = String(senderId ?? '')
  const notPlayer = view.game === 'blackjack' ? NOT_PLAYER_NOTICE : '只有发起这手的人可以出牌'
  const illegal = view.game === 'blackjack' ? ILLEGAL_NOTICE : '这个动作现在不合法'
  if (origin.conversationType === 'group') {
    if (!origin.starterId || sender !== origin.starterId) return spoken.rest ? null : { notice: notPlayer }
  }
  try {
    const played = await playSession(key, spoken.action, 'human')
    const verb = view.game === 'blackjack' ? (spoken.action === 'hit' ? '要牌' : '停牌') : verbOf(view.game, spoken.action)
    const saying = spoken.rest ? `，并说：${sentence(spoken.rest)}` : ''
    if (view.game === 'blackjack') {
      if (played.view.over) {
        if (!saying) return { forward: played.prompt }
        const winner = played.view.over.winner === 'player' ? '玩家胜' : played.view.over.winner === 'dealer' ? '庄家胜' : '和局'
        return { forward: `${played.view.playerName}${verb}了${saying}${winner}（${played.view.over.reason}）。可以调用 card_close。` }
      }
      if (!saying) return { forward: played.prompt }
      return { forward: `${played.view.playerName}${verb}了${saying}现在仍是玩家回合` }
    }
    if (!saying) return { forward: played.prompt }
    if (played.view.over) {
      const winner = played.view.over.winner === 'player' ? '玩家胜' : played.view.over.winner === 'ai' ? '对手胜' : '平局'
      return { forward: `${played.view.playerName}${verb}了${saying}${winner}（${played.view.over.reason}）。可以调用 card_close。` }
    }
    return { forward: `${played.view.playerName}${verb}了${saying}现在仍是玩家回合` }
  } catch (error) {
    if (error instanceof CardError && error.status === 409) return { notice: error.message }
    return { notice: illegal }
  }
}

let chain = Promise.resolve()

export function whenCardsPublished() {
  return chain
}

export function installCardsTelegram({ logger } = {}) {
  const off = onSessionChange((event) => {
    if (event.type === 'close' || !event.origin) return undefined
    const background = event.who === 'human'
    const job = chain.then(() => publishTable(event)).then(() => {
      if (background && event.key) saveSessionNow(event.key)
    }).catch((error) => {
      logger?.warn?.('dsh-workbench: card table image to telegram failed', String(error?.message ?? error).slice(0, 160))
    })
    chain = job
    return background ? undefined : job
  })
  setCardsInbound(handleCardInbound)
  return () => {
    off()
    clearCardsInbound(handleCardInbound)
  }
}
