import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, applyHit, applyStand, card, cardCode, deal, handScore, isNatural, outcome, publicView, replay, startFromSeed } from './rules.mjs'
import { renderTable } from './render.mjs'

const C = (rank, suit) => card(rank, suit)

test('ace scores 11 until the hand would bust, then 1', () => {
  assert.equal(handScore([C('A', 'S'), C('K', 'H')]), 21)
  assert.equal(handScore([C('A', 'S'), C('A', 'D')]), 12)
  assert.equal(handScore([C('A', 'S'), C('A', 'D'), C('9', 'C')]), 21)
  assert.equal(handScore([C('A', 'S'), C('6', 'D'), C('T', 'H')]), 17)
  assert.equal(handScore([C('A', 'S'), C('A', 'D'), C('A', 'C'), C('9', 'H')]), 12)
  assert.equal(isNatural([C('A', 'S'), C('K', 'H')]), true)
  assert.equal(isNatural([C('T', 'S'), C('6', 'D'), C('5', 'C')]), false)
  assert.equal(isNatural([C('A', 'S'), C('9', 'D')]), false)
})

test('natural blackjack beats a later 21 and pushes only against another natural', () => {
  assert.deepEqual(outcome([C('A', 'S'), C('K', 'H')], [C('5', 'H'), C('6', 'D'), C('K', 'S')]), { winner: 'player', reason: '天成' })
  assert.deepEqual(outcome([C('9', 'S'), C('K', 'H')], [C('A', 'H'), C('T', 'D')]), { winner: 'dealer', reason: '庄家天成' })
  assert.deepEqual(outcome([C('A', 'S'), C('K', 'D')], [C('A', 'H'), C('T', 'C')]), { winner: 'push', reason: '天成和局' })
  assert.deepEqual(outcome([C('T', 'S'), C('6', 'D'), C('5', 'C')], [C('K', 'H'), C('5', 'D'), C('6', 'C')]), { winner: 'push', reason: '点数相同' })
})

test('opening naturals settle before anyone draws; the hole stays hidden otherwise', () => {
  const playerNatural = deal([C('A', 'S'), C('5', 'H'), C('K', 'H'), C('6', 'D'), C('K', 'S')])
  assert.equal(playerNatural.over.reason, '天成')
  assert.equal(playerNatural.dealer.length, 2)
  assert.equal(playerNatural.queue.length, 1)
  assert.equal(playerNatural.revealed, true)

  const both = deal([C('A', 'S'), C('A', 'H'), C('K', 'D'), C('T', 'C')])
  assert.equal(both.over.reason, '天成和局')
  assert.equal(both.over.winner, 'push')

  const dealerNatural = deal([C('9', 'S'), C('A', 'H'), C('K', 'H'), C('T', 'D')])
  assert.equal(dealerNatural.over.reason, '庄家天成')
  assert.equal(dealerNatural.dealer.length, 2)

  const hidden = deal([C('9', 'S'), C('K', 'H'), C('8', 'D'), C('7', 'C'), C('5', 'S')])
  assert.equal(hidden.over, null)
  assert.equal(hidden.revealed, false)
  const pub = publicView(hidden)
  assert.equal(pub.dealerScore, 10)
  assert.equal(handScore(hidden.dealer), 17)
  assert.deepEqual(pub.dealer[1], { hidden: true })
  assert.equal(JSON.stringify(pub).includes('7C'), false)
  assert.equal(pub.legal.join(','), 'hit,stand')
})

test('bust ends the hand without a dealer draw; standing draws until 17, including soft 17', () => {
  const hitting = deal([C('9', 'S'), C('K', 'H'), C('8', 'D'), C('7', 'C'), C('5', 'S')])
  const bust = applyHit(hitting)
  assert.equal(bust.over.reason, '爆牌')
  assert.equal(bust.over.winner, 'dealer')
  assert.equal(bust.dealer.length, 2)
  assert.equal(publicView(bust).dealer[1].code, '7C')

  const soft = deal([C('T', 'H'), C('A', 'S'), C('9', 'C'), C('6', 'D'), C('K', 'S')])
  assert.equal(handScore(soft.dealer), 17)
  const stoodSoft = applyStand(soft)
  assert.equal(stoodSoft.dealer.length, 2)
  assert.equal(stoodSoft.queue[0].rank, 'K')
  assert.equal(stoodSoft.over.winner, 'player')

  const push = applyStand(deal([C('T', 'H'), C('9', 'S'), C('7', 'C'), C('6', 'D'), C('2', 'D')]))
  assert.equal(push.dealer.length, 3)
  assert.equal(cardCode(push.dealer[2]), '2D')
  assert.equal(push.over.reason, '点数相同')

  const dealerBust = applyStand(deal([C('T', 'H'), C('9', 'S'), C('7', 'C'), C('6', 'D'), C('K', 'S')]))
  assert.equal(dealerBust.over.reason, '庄家爆牌')
  assert.equal(dealerBust.over.winner, 'player')
  assert.throws(() => applyHit(dealerBust), /结束/)
  assert.throws(() => applyAction(hitting, 'double'), /hit|stand/)
})

test('the same seed replays the same hand, and a hidden hole does not change the picture', () => {
  const first = startFromSeed(42)
  const second = replay(42, [])
  assert.deepEqual(first.player, second.player)
  assert.deepEqual(first.dealer, second.dealer)
  const pub = publicView(deal([C('9', 'S'), C('K', 'H'), C('8', 'D'), C('7', 'C')]))
  assert.equal(pub.revealed, false)
  const withSecret = { ...pub, dealer: [pub.dealer[0], { hidden: true, code: '7C', rank: '7', suit: 'C' }] }
  const otherSecret = { ...pub, dealer: [pub.dealer[0], { hidden: true, code: 'AS', rank: 'A', suit: 'S' }] }
  assert.deepEqual(renderTable(pub).png, renderTable(withSecret).png)
  assert.deepEqual(renderTable(withSecret).png, renderTable(otherSecret).png)
  const shown = { ...pub, revealed: true, dealer: [pub.dealer[0], { code: '7C', rank: '7', suit: 'C' }] }
  assert.notDeepEqual(renderTable(pub).png, renderTable(shown).png)
  const png = renderTable(pub)
  assert.ok(png.png.length > 500)
  assert.equal(png.png.readUInt32BE(16), png.width)
  assert.equal(png.png.readUInt32BE(20), png.height)
})
