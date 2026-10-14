import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextKey, saveId } from './context.mjs'
import { cardsRoot, ensureGame } from './download.mjs'
import { CardError } from './errors.mjs'
import { engineFor, verbOf } from './games/index.mjs'
import { GAMES } from './sources.mjs'
import { agentSeatOf, agentView, annotateUserView, normalizeMode, roleOf, seatLabel, seatsProblem, turnSeat, userSeatOf, viewerSeatOf } from './seats.mjs'

const SAVE_VERSION = 1

let current = null
const listeners = new Set()

export function onSessionChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function emit(event) {
  for (const fn of [...listeners]) {
    try { await fn(event) } catch { /* 投递失败不影响牌局 */ }
  }
}

export function resetSession() {
  current = null
}

export function savesDir() {
  return join(cardsRoot(), 'saves')
}

export function saveFileFor(key, game = 'blackjack') {
  const id = !game || game === 'blackjack' ? saveId(key) : saveId(`${key}\n${game}`)
  return join(savesDir(), `${id}.json`)
}

function writeAtomic(file, text) {
  mkdirSync(savesDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function playerName(value) {
  const name = String(value ?? '').trim()
  return name || 'user'
}

function copyOrigin(origin) {
  if (!origin || origin.channel !== 'telegram') return null
  const chatId = String(origin.chatId ?? '').trim()
  if (!chatId) return null
  return {
    channel: 'telegram',
    chatId,
    threadId: origin.threadId ? String(origin.threadId) : '',
    conversationType: origin.conversationType === 'group' ? 'group' : 'dm',
    starterId: origin.starterId ? String(origin.starterId) : '',
    messageId: origin.messageId ? String(origin.messageId) : null,
  }
}

function validSave(data, key, game) {
  const engine = engineFor(game)
  return data && data.version === SAVE_VERSION && data.game === game && data.contextKey === key
    && (!engine.validOptions || engine.validOptions(data.options))
    && Number.isInteger(data.seed) && data.seed > 0
    && Array.isArray(data.actions) && data.actions.every((action) => engine.accepts(action))
    && (data.mode === undefined || data.mode === 'versus' || data.mode === 'solo')
    && (data.over == null || (data.over && typeof data.over.winner === 'string'))
}

function backupCorrupt(key, game) {
  const file = saveFileFor(key, game)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(savesDir(), `${saveId(game === 'blackjack' ? key : `${key}\n${game}`)}.corrupt-${stamp}-${randomBytes(2).toString('hex')}.json`)
  try { renameSync(file, backup) } catch { rmSync(file, { force: true }) }
  return backup
}

function readSave(key, game) {
  const file = saveFileFor(key, game)
  if (!existsSync(file)) return null
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { data = null }
  if (validSave(data, key, game)) return { data }
  return { corrupt: backupCorrupt(key, game) }
}

function clearSave(key, game) {
  const file = saveFileFor(key, game)
  const had = existsSync(file)
  rmSync(file, { force: true })
  return had
}

function persist() {
  if (!current || current.persist === false) return
  const origin = current.origin
  const data = {
    version: SAVE_VERSION,
    game: current.game,
    contextKey: current.contextKey,
    id: current.id,
    seed: current.seed,
    actions: current.actions.slice(),
    ...(current.options ? { options: { ...current.options } } : {}),
    mode: current.mode,
    over: current.state.over ? { winner: current.state.over.winner, reason: current.state.over.reason || '' } : null,
    playerName: current.playerName,
    telegram: origin ? {
      chatId: origin.chatId,
      threadId: origin.threadId || '',
      messageId: origin.messageId || '',
      conversationType: origin.conversationType,
      starterId: origin.starterId || '',
    } : null,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  }
  try { writeAtomic(saveFileFor(current.contextKey, current.game), JSON.stringify(data) + '\n') } catch { /* 存档失败不影响这一手 */ }
}

export function saveSessionNow() {
  persist()
}

export function sessionOrigin() {
  return current?.origin || null
}

export function hasSession() {
  return current != null
}

function listed(actions) {
  const shown = actions.slice(0, 24)
  return shown.join('、') + (actions.length > shown.length ? ` 等 ${actions.length} 个` : '')
}

function instruction(game, view) {
  if (game === 'blackjack') {
    if (view.over) return `这手已经结束（${view.over.reason}）。可以调用 card_close。`
    return '现在是玩家回合。请调用 card_play，action 只能是 hit 或 stand。不要使用 RLCard 或其他上游对手。庄家暗牌在开牌前不会出现。'
  }
  if (view.over) return `这手已经结束（${view.over.reason}）。可以调用 card_close。`
  return `现在是玩家回合。请调用 card_play，action 只能是 ${listed(view.legal)}。不要使用 RLCard 或其他上游对手。对手的暗牌不会出现。`
}

function present(perspective = 'user', extra = {}) {
  const engine = engineFor(current.game)
  const pub = engine.publicView(current.state, viewerSeatOf(current))
  if (perspective === 'agent') return agentView(current, engine, pub, { label: GAMES[current.game].label, ...extra })
  const view = {
    id: current.id,
    game: current.game,
    label: GAMES[current.game].label,
    playerName: current.playerName,
    legal: pub.legal,
    over: pub.over,
    turn: current.game === 'blackjack' ? (pub.over ? 'over' : 'player') : pub.turn,
    moveCount: current.actions.length,
    instruction: instruction(current.game, pub),
    ...(current.game === 'blackjack' ? {
      player: pub.player,
      dealer: pub.dealer,
      playerScore: pub.playerScore,
      dealerScore: pub.dealerScore,
      revealed: pub.revealed,
      rows: [
        { title: '庄家', label: 'D', cards: pub.dealer },
        { title: '玩家', label: 'P', cards: pub.player },
      ],
    } : {
      rows: pub.rows,
      mark: pub.mark,
      caption: pub.caption,
      summary: pub.summary,
      ...(pub.board === undefined ? {} : { board: pub.board }),
    }),
    ...(current.lastAi?.length ? { aiActions: current.lastAi.slice() } : {}),
    ...(current.notice ? { notice: current.notice } : {}),
    ...(current.origin ? { delivery: 'telegram', deliveryNote: '每一步后插件会自动把牌桌图片发到这个 Telegram 对话，不需要再调用 mm_send_image 或描述暗牌。' } : {}),
  }
  if (current.lastAi?.length) view.instruction = `对手已行动：${current.lastAi.join('、')}。` + view.instruction
  if (current.recent?.length) view.recent = current.recent.map((m) => ({ seat: m.seat, name: seatLabel(current, m.seat), action: m.action }))
  Object.assign(view, extra)
  return annotateUserView(current, engine, view)
}

function resultOf(over, moveCount, endedAt) {
  if (!over) return null
  return { winner: over.winner, reason: over.reason || '', moveCount, endedAt: endedAt || '' }
}

function requireKey(options) {
  const key = options.contextKey || contextKey({ sessionId: options.sessionId, origin: options.origin })
  if (!key) throw new CardError('无法确定会话，已拒绝', 400)
  return key
}

function requireOwn(key) {
  if (!current || current.contextKey !== key) throw new CardError('这个会话没有进行中的牌局', 404)
  return current
}

function settle(session) {
  const engine = engineFor(session.game)
  if (!engine.opponent) return []
  const played = []
  for (let guard = 0; guard < 1000; guard++) {
    if (session.state.over || roleOf(session, turnSeat(session.game, session.state)) !== 'bot') break
    const seat = turnSeat(session.game, session.state)
    const action = engine.ai(session.state)
    if (!action || !engine.legal(session.state).includes(action)) throw new CardError('对手没有走出合法动作')
    session.state = engine.apply(session.state, action)
    session.actions.push(action)
    played.push(action)
    session.recent?.push({ seat, action })
  }
  if (!session.state.over && roleOf(session, turnSeat(session.game, session.state)) === 'bot') throw new CardError('对手走子没有结束')
  return played
}

export async function openSession(options = {}) {
  const game = String(options.game || 'blackjack').trim()
  if (!GAMES[game]) throw new CardError(`game 只能是 ${Object.keys(GAMES).join('、')}`)
  const key = requireKey(options)
  if (current?.contextKey === key) throw new CardError('这个会话已经有一局进行中，请先 card_close', 409)
  if (current) throw new CardError('另一会话正在使用牌桌，请先在那个会话 card_close', 409)
  const persistOn = options.persist !== false
  const requestedMode = normalizeMode(options.mode, 'solo')
  if (options.skipSource !== true) await ensureGame(game)
  const engine = engineFor(game)
  const saved = persistOn ? readSave(key, game) : null
  let resume = saved?.data && !saved.data.over ? saved.data : null
  const lastResult = saved?.data?.over ? resultOf(saved.data.over, saved.data.actions.length, saved.data.updatedAt) : null
  let corrupt = saved?.corrupt || ''
  const notices = []
  let seed = Number.isInteger(options.seed) && options.seed > 0 ? options.seed : randomInt(1, 0x7fffffff)
  let actions = []
  let state = null
  // 新开局的参数（如 UNO 人数）；续局沿用存档里的，旧存档没有就按旧版走法
  const custom = options.gameOptions || {}
  const asked = ['players', 'teams', 'seats'].filter((k) => custom[k] !== undefined && custom[k] !== null && custom[k] !== '')
  if (asked.length && game !== 'uno') throw new CardError(`${asked.join(', ')} only apply to uno`)
  let gameOptions = engine.defaultOptions ? engine.defaultOptions(custom) : null
  if (gameOptions?.seats) {
    const problem = seatsProblem(gameOptions.seats, requestedMode, gameOptions.players)
    if (problem) throw new CardError(problem)
  }
  if (resume) {
    try {
      state = engine.replay(resume.seed, resume.actions, resume.options)
      gameOptions = resume.options ? { ...resume.options } : null
      seed = resume.seed
      actions = resume.actions.slice()
    } catch {
      corrupt = backupCorrupt(key, game)
      resume = null
      state = null
    }
  }
  if (!state) state = gameOptions ? engine.start(seed, gameOptions) : engine.start(seed)
  if (resume && asked.length) notices.push(`已从存档续局，本次的 ${asked.join('、')} 参数未生效；要按新参数开局请先 card_reset。`)
  if (corrupt) notices.push(`存档损坏，已备份为 ${corrupt}，重新开局。`)
  if (lastResult) notices.push('上一手已经结束，这是新的一手。')
  let origin = copyOrigin(options.origin)
  if (resume?.telegram && origin && origin.chatId === String(resume.telegram.chatId) && (origin.threadId || '') === String(resume.telegram.threadId || '')) {
    origin = {
      ...origin,
      starterId: resume.telegram.starterId || origin.starterId,
      messageId: resume.telegram.messageId ? String(resume.telegram.messageId) : null,
      conversationType: resume.telegram.conversationType === 'group' ? 'group' : origin.conversationType,
    }
  }
  current = {
    id: resume?.id || randomBytes(4).toString('hex'),
    game,
    contextKey: key,
    seed,
    actions,
    state,
    options: gameOptions,
    playerName: resume?.playerName || playerName(options.playerName),
    mode: resume?.mode ? normalizeMode(resume.mode, requestedMode) : requestedMode,
    persist: persistOn,
    createdAt: resume?.createdAt || new Date().toISOString(),
    origin,
    notice: notices.join(''),
    lastAi: [],
    recent: [],
  }
  current.lastAi = settle(current)
  persist()
  const extra = {}
  if (resume) extra.resumed = { moveCount: resume.actions.length, savedAt: resume.updatedAt || '' }
  if (lastResult) extra.lastResult = lastResult
  if (current.notice) extra.notice = current.notice
  const view = present()
  if (resume) {
    view.resumed = { moveCount: resume.actions.length, savedAt: resume.updatedAt || '' }
    const lead = game === 'blackjack'
      ? `已从本会话存档续局：玩家已行动 ${resume.actions.length} 次。`
      : `已从本会话存档续局：已记录 ${resume.actions.length} 步。`
    view.instruction = lead + view.instruction
  }
  if (lastResult) view.lastResult = lastResult
  const forAgent = options.perspective === 'agent' ? present('agent', extra) : null
  current.notice = ''
  await emit({ type: 'open', view, origin: current.origin, resumed: Boolean(resume) })
  persist()
  return forAgent || view
}

export async function resetGame(key, game, settings = {}) {
  if (!key) throw new CardError('无法确定会话，已拒绝', 400)
  const which = String(game || (current?.contextKey === key ? current.game : 'blackjack')).trim()
  if (!GAMES[which]) throw new CardError(`game 只能是 ${Object.keys(GAMES).join('、')}`)
  const asked = ['players', 'teams', 'seats'].filter((k) => settings?.[k] !== undefined && settings?.[k] !== null && settings?.[k] !== '')
  if (asked.length && which !== 'uno') throw new CardError(`${asked.join(', ')} only apply to uno`)
  // 原地重开：先算出新参数并校验，失败时存档和牌桌都不动
  let nextOptions = null
  let nextMode = null
  const inPlace = current && current.contextKey === key && current.game === which
  if (inPlace) {
    const engine = engineFor(which)
    nextMode = settings.mode ? normalizeMode(settings.mode, current.mode) : current.mode
    nextOptions = engine.defaultOptions ? engine.defaultOptions(settings || {}) : null
    const prev = current.options || {}
    if (nextOptions && which === 'uno') {
      // 没给 teams / seats 时沿用当前牌桌的（对新人数和模式仍然成立才沿用）
      if ((settings.teams === undefined || settings.teams === null || settings.teams === '') && prev.teams && nextOptions.players % prev.teams === 0 && nextOptions.players >= 2 * prev.teams) nextOptions.teams = prev.teams
      if (settings.seats == null && Array.isArray(prev.seats) && !seatsProblem(prev.seats, nextMode, nextOptions.players)) nextOptions.seats = prev.seats.slice()
      if (nextOptions.seats) {
        const problem = seatsProblem(nextOptions.seats, nextMode, nextOptions.players)
        if (problem) throw new CardError(problem)
      }
    }
  }
  const hadSave = clearSave(key, which)
  if (!inPlace) {
    return { reset: true, game: which, active: false, clearedSave: hadSave }
  }
  const engine = engineFor(which)
  current.seed = randomInt(1, 0x7fffffff)
  current.actions = []
  current.options = nextOptions
  current.state = current.options ? engine.start(current.seed, current.options) : engine.start(current.seed)
  current.lastAi = []
  current.recent = []
  current.mode = nextMode
  current.lastAi = settle(current)
  current.createdAt = new Date().toISOString()
  current.id = randomBytes(4).toString('hex')
  if (current.origin) current.origin.messageId = null
  persist()
  const view = present()
  view.reset = true
  view.instruction = '已重新开局。' + view.instruction
  await emit({ type: 'open', view, origin: current.origin, reset: true })
  persist()
  if (settings.perspective === 'agent') {
    const mine = present('agent', { reset: true })
    mine.instruction = '已重新开局。' + mine.instruction
    return mine
  }
  return view
}

/** perspective：'user'（页面 / Telegram，用户座位）或 'agent'（card_* 工具，AI 自己的座位）。 */
export function lookSession(key, perspective = 'user') {
  requireOwn(key)
  return present(perspective)
}

function turnTail(view) {
  if (view.mode !== 'versus' || view.over) return ''
  if (view.turnRole === 'agent') return `现在轮到你（AI，座位 ${view.turnSeat}）：请先 card_look 看你自己的手牌，再 card_play。`
  if (view.turnRole === 'user') return '现在轮到用户，请等待用户出牌，不要替用户 card_play。'
  return ''
}

function othersText(view) {
  // 用户出牌之后其余座位（AI 不在此列，因为 AI 要等通知后自己走；这里只有机器人）
  const moves = (view.recent || []).filter((m) => m.seat !== view.viewerSeat)
  return moves.map((m) => `${m.name}${verbOf(view.game, m.action)}`).join('、')
}

export function humanActionPrompt(name, action, view) {
  const who = playerName(name)
  if (!view.game || view.game === 'blackjack') {
    const verb = action === 'hit' ? '要牌' : '停牌'
    if (view.over) {
      const winner = view.over.winner === 'player' ? '玩家胜' : view.over.winner === 'dealer' ? '庄家胜' : '和局'
      return `${who}${verb}了。${winner}（${view.over.reason}）。可以调用 card_close。`
    }
    return `${who}${verb}了,现在仍是玩家回合`
  }
  const verb = verbOf(view.game, action)
  if (view.mode === 'versus') {
    const others = othersText(view)
    const tail = others ? `随后${others}。` : ''
    if (view.over) return `${who}（用户）${verb}了。${tail}这手已经结束（${view.over.reason}）。可以调用 card_close。`
    return `${who}（用户）${verb}了。${tail}${turnTail(view)}`
  }
  const opp = (view.aiActions || []).map((item) => verbOf(view.game, item)).join('、')
  const tail = opp ? `对手${opp}。` : ''
  if (view.over) {
    const winner = view.over.winner === 'player' ? '玩家胜' : view.over.winner === 'ai' ? '对手胜' : '平局'
    return `${who}${verb}了。${tail}${winner}（${view.over.reason}）。可以调用 card_close。`
  }
  return `${who}${verb}了,${tail}现在仍是玩家回合`
}

/**
 * who：'human'（页面点牌 / Telegram，代表用户座位 0）或 'ai'（card_play，代表 AI 自己的座位）。
 * versus：AI 只能在轮到 AI 座位时出牌，用户只能在轮到座位 0 时出牌；机器人座位自动走。
 * solo（代打）：两者都只能走座位 0，与旧版一致。
 */
export async function playSession(key, text, who) {
  const session = requireOwn(key)
  if (session.state.over) throw new CardError('这手已经结束')
  const engine = engineFor(session.game)
  const seat = turnSeat(session.game, session.state)
  const versus = session.mode === 'versus'
  if (who === 'ai' && versus) {
    if (session.game === 'blackjack') throw new CardError('Versus mode: this blackjack hand belongs to the user, who plays it on the page or in Telegram. You cannot hit or stand for them; use card_look to watch, or card_reset and reopen with mode "solo" to play your own hand.', 409)
    const mine = agentSeatOf(session)
    if (mine == null) throw new CardError('You have no seat at this table (seat assignment has no "ai" seat); you can only watch with card_look.', 409)
    if (seat !== mine) {
      const role = roleOf(session, seat)
      const userSeat = userSeatOf(session)
      throw new CardError(role === 'user'
        ? `Not your turn: it is the user's turn (seat ${userSeat}, ${seatLabel(session, userSeat)}). Wait for the user to play on the page or in Telegram; do not play for them. You are seat ${mine}.`
        : `Not your turn: seat ${seat} (${seatLabel(session, seat)}) is to act. You are seat ${mine}.`, 409)
    }
  } else if (engine.opponent && seat !== viewerSeatOf(session)) {
    throw new CardError(versus && who === 'human' ? `现在不是你的回合（轮到${seatLabel(session, seat)}）` : '现在不是玩家回合', 409)
  }
  const action = engine.canonical(text)
  if (!action) throw new CardError(engine.badAction)
  if (!engine.legal(session.state).includes(action)) throw new CardError(session.game === 'blackjack' ? engine.badAction : '这个动作现在不合法')
  session.state = engine.apply(session.state, action)
  session.actions.push(action)
  session.recent = [{ seat, action }]
  session.lastAi = settle(session)
  persist()
  const view = present()
  await emit({ type: 'play', view, origin: session.origin, action, who })
  persist()
  return {
    view,
    agentView: present('agent'),
    action,
    aiActions: session.lastAi.slice(),
    prompt: who === 'human' ? humanActionPrompt(session.playerName, action, view) : '',
  }
}

export function closeSession(key) {
  if (!current) return { closed: false }
  if (key && current.contextKey !== key) return { closed: false }
  persist()
  const unfinished = current.persist !== false && !current.state.over
  const game = current.game
  const origin = current.origin
  current = null
  emit({ type: 'close', origin })
  return {
    closed: true,
    ...(unfinished ? { saved: true, game, note: '本会话的存档已保留，下次 card_open 同一游戏会续这手；不想续请 card_reset。' } : {}),
  }
}

export function activeContextKey() {
  return current?.contextKey || ''
}
