/**
 * 二十一点沿用 rules.mjs。其它牌类各自一个引擎，会话只认这里的接口。
 */
import { CardError } from '../errors.mjs'
import { parseSpokenAction } from '../rules.mjs'
import { applyAction, normalizeAction, publicView, replay, startFromSeed } from '../rules.mjs'
import { doudizhu } from './doudizhu.mjs'
import { leduc } from './leduc.mjs'
import { limitHoldem } from './limit-holdem.mjs'
import { uno } from './uno.mjs'

export const blackjack = {
  id: 'blackjack',
  opponent: false,
  badAction: 'action 只能是 hit 或 stand',
  start: startFromSeed,
  apply: applyAction,
  replay,
  legal(state) { return state.over ? [] : ['hit', 'stand'] },
  publicView,
  actor(state) { return state.over ? 'over' : 'human' },
  accepts(action) { return action === 'hit' || action === 'stand' },
  canonical: normalizeAction,
  normalize(text, legal) {
    const action = normalizeAction(text)
    return action && (!legal || legal.includes(action)) ? action : ''
  },
  ai() { return '' },
}

export const ENGINES = {
  blackjack,
  leduc,
  'limit-holdem': limitHoldem,
  uno,
  doudizhu,
}

export function engineFor(id) {
  const engine = ENGINES[id]
  if (!engine) throw new CardError('未知的牌类')
  return engine
}

const VERBS = {
  hit: '要牌', stand: '停牌', call: '跟注', raise: '加注', fold: '弃牌', check: '过牌', draw: '摸牌', pass: '过',
}

export function verbOf(game, action) {
  return VERBS[action] || action
}

export function interpret(game, text, legal) {
  if (!game || game === 'blackjack') return parseSpokenAction(text)
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const engine = ENGINES[game]
  if (!engine) return null
  const split = raw.match(/^(.+?)\s*[,，:：]\s*(\S[\s\S]*)$/)
  const head = (split ? split[1] : raw).trim()
  const rest = split ? split[2].trim() : ''
  const action = engine.canonical(head)
  if (!action) return null
  if (legal && !legal.includes(action) && !rest) return { action, rest: '' }
  return { action, rest }
}
