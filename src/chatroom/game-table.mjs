/**
 * 房间对局：座位轮次、连续 AI 步数、入座与着法。
 * 棋局本身在 boards/session（键 room:<roomId>）。这里不代下、不代出。
 */
import { boardKey, confirmSeat, lookSession, playSession } from '../boards/session.mjs'
import { humanMatches } from '../boards/seats.mjs'
import { looksLikeMove, splitLeadingMove } from '../boards/notation.mjs'
import { confirmCardSeat, lookSession as lookCard, playSession as playCard, roomSnapshot } from '../cards/session.mjs'
import { occupantMatches } from '../cards/seats.mjs'
import { interpret } from '../cards/games/index.mjs'

export const DEFAULT_AI_STREAK = 60

export function createRoomGames() {
  const rooms = new Map()
  const slot = (roomId) => {
    let s = rooms.get(roomId)
    if (!s) { s = { streak: 0, paused: false, reminded: false }; rooms.set(roomId, s) }
    return s
  }
  function viewOf(roomId) {
    try { return lookSession(boardKey({ roomId })) } catch { return null }
  }
  function cardOf(roomId) {
    try { return roomSnapshot(`room:${roomId}`) } catch { return null }
  }
  function snapshot(roomId) {
    const view = viewOf(roomId)
    const st = slot(roomId)
    if (view && !view.over) {
      const waiting = (view.seats || []).some((s) => s.status === 'pending')
      return {
        active: true,
        paused: st.paused,
        reminded: st.reminded,
        streak: st.streak,
        waiting,
        view,
        actor: waiting ? null : (view.turnSeat || null),
        key: view.key,
      }
    }
    const card = cardOf(roomId)
    if (!card || card.over) return { active: false }
    const waiting = card.waiting.length > 0
    return {
      active: true,
      paused: st.paused,
      reminded: st.reminded,
      streak: st.streak,
      waiting,
      view: card,
      actor: waiting ? null : card.actor,
      key: card.key,
    }
  }
  function noteMove(roomId, who, limit) {
    const st = slot(roomId)
    const cap = streakLimit(limit)
    if (who === 'ai') {
      st.streak += 1
      st.reminded = false
      if (cap > 0 && st.streak >= cap) st.paused = true
    } else {
      st.streak = 0
      st.reminded = false
    }
    return { streak: st.streak, paused: st.paused, reminded: st.reminded, cap }
  }
  function pause(roomId) { slot(roomId).paused = true }
  function resume(roomId) {
    const st = slot(roomId)
    st.paused = false
    st.reminded = false
  }
  function markReminded(roomId) { slot(roomId).reminded = true }
  function clear(roomId) { rooms.delete(roomId) }
  function prompt(view, memberId) {
    if (view?.table === 'card') {
      let mine = ''
      try {
        const priv = lookCard(view.key, 'agent', { memberId })
        const pub = {
          yourHand: priv.yourHand,
          legal: priv.legal,
          turn: priv.turn,
          seats: (priv.seats || []).map((s) => ({ seat: s.seat, name: s.name, cards: s.cards })),
        }
        mine = JSON.stringify(pub)
      } catch { mine = '' }
      return `轮到你了（${view.label || '牌局'}）。下面是只有你能看到的局面，不要把 yourHand 写进发言。请调用 card_play，action 必须来自 legal。不要替别人出牌。\n${mine}`
    }
    const seat = view?.turnSeat
    const legal = (view?.legal || []).slice(0, 24).join(', ')
    return `轮到你了（${view?.label || '棋局'}，${seat?.name || '你'} 执 ${view?.turnSide || ''}）。请调用 board_play，着法必须来自 legal。不要替对方走子。\n合法着法：${legal || '（先调用 board_look）'}`
  }
  async function route(roomId, { text, telegramUserId, local } = {}) {
    const card = cardOf(roomId)
    if (card && !card.over) return routeCard(roomId, card, { text, telegramUserId, local })
    const view = viewOf(roomId)
    if (!view || view.over) return null
    const caller = {
      ...(telegramUserId ? { telegramUserId: String(telegramUserId) } : {}),
      ...(local ? { local: true } : {}),
    }
    const raw = String(text || '').trim()
    if (/^入座\s*[。.!！~～]?$/.test(raw)) {
      const joined = await confirmSeat(view.key, caller)
      if (!joined) return { consumed: true, notice: '没有待确认的座位。' }
      return { consumed: true, joined: joined.seat, view: joined.view }
    }
    const whole = looksLikeMove(view.game, raw)
    const split = whole ? null : splitLeadingMove(view.game, raw)
    if (!whole && !split) return null
    const mine = (view.seats || []).find((s) => humanMatches(s, caller))
    if (!mine) return null
    if (mine.status !== 'seated') return { consumed: true, notice: '请先回复「入座」。' }
    if (view.turnSeat?.seatId !== mine.seatId) return { consumed: true, notice: '现在还没轮到你走棋。' }
    const move = whole ? raw : split.move
    try {
      const played = await playSession(move, 'human', { key: view.key, caller })
      return { consumed: true, played, said: whole ? '' : split.rest }
    } catch (error) {
      return { consumed: true, notice: error?.message || '这步不在合法着法里' }
    }
  }
  async function routeCard(roomId, card, { text, telegramUserId, local }) {
    const caller = {
      ...(telegramUserId ? { telegramUserId: String(telegramUserId) } : {}),
      ...(local ? { local: true } : {}),
    }
    const raw = String(text || '').trim()
    if (/^入座\s*[。.!！~～]?$/.test(raw)) {
      const joined = await confirmCardSeat(card.key, caller)
      if (!joined) return { consumed: true, notice: '没有待确认的座位。' }
      return { consumed: true, joined: joined.seat, view: joined.view }
    }
    const spoken = interpret(card.game, raw, null)
    if (!spoken?.action) return null
    const mine = (card.occupants || []).find((s) => occupantMatches(s, caller))
    if (!mine) return null
    if (mine.status !== 'seated') return { consumed: true, notice: '请先回复「入座」。' }
    if (card.actor?.seat !== mine.seat) return { consumed: true, notice: '现在还没轮到你出牌。' }
    try {
      const played = await playCard(card.key, spoken.action, 'human', caller)
      return { consumed: true, played, said: spoken.rest || '' }
    } catch (error) {
      return { consumed: true, notice: error?.message || '这个动作现在不合法' }
    }
  }
  return { snapshot, noteMove, pause, resume, markReminded, clear, prompt, route, viewOf }
}

export function streakLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_AI_STREAK
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AI_STREAK
  return Math.min(10000, Math.round(n))
}
