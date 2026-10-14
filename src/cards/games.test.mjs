import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextKey } from './context.mjs'
import { beats, doudizhu, playableFromHand, typesOf } from './games/doudizhu.mjs'
import { leduc } from './games/leduc.mjs'
import { limitHoldem } from './games/limit-holdem.mjs'
import { bestScore, compareScores } from './games/poker.mjs'
import { uno } from './games/uno.mjs'
import { renderTable } from './render.mjs'
import { cardCode } from './rules.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame, resetSession, saveFileFor } from './session.mjs'
import { captionFor } from './telegram.mjs'

const DUMPS = {
  '34567': '3|34567|4|5|6|7',
  '334455': '3|33|334455|4|44|5|55',
  '333444': '3|33|333|3334|33344|333444|33444|3444|4|44|444',
  '33334455': '3|33|333|3333|333344|33334455|333345|333355|3334|33344|3335|33355|334455|4|44|5|55',
  BR: 'B|BR|R',
  '2222': '2|22|222|2222',
  '333345': '3|33|333|3333|333345|3334|3335|4|5',
  '8888TJ': '8|88|888|8888|8888TJ|888J|888T|J|T',
  JJQQKKAA: 'A|AA|J|JJ|JJQQKK|JJQQKKAA|K|KK|Q|QQ|QQKKAA',
  '3333BR': '3|33|333|3333|333B|333R|B|BR|R',
  '45678TJQKA2': '2|4|45678|5|6|7|8|A|J|K|Q|T|TJQKA',
  '3444': '3|3444|4|44|444',
  '555566': '5|55|555|5555|555566|5556|55566|6|66',
}

function sortedPlays(hand) {
  return [...playableFromHand(hand)].sort()
}

function card(rank, suit) {
  return { rank, suit }
}

function unoCard(color, trait) {
  const type = trait === 'wild' || trait === 'wild_draw_4' ? 'wild' : (trait === 'skip' || trait === 'reverse' || trait === 'draw_2' ? 'action' : 'number')
  return { type, color, trait }
}

function opponentCodes(state) {
  return state.hands[1].map(cardCode)
}

function hides(view, codes, own) {
  const text = JSON.stringify(view)
  for (const code of codes) {
    if (!own.has(code)) assert.equal(text.includes(code), false, code)
  }
}

test('leduc and limit holdem follow the pinned betting and hidden-card rules', () => {
  const first = leduc.start(11)
  const second = leduc.start(11)
  assert.deepEqual(first.hands, second.hands)
  assert.equal(first.sb, second.sb)

  let paired = leduc.fromSpec({
    hands: [[card('J', 'S')], [card('J', 'H')]],
    board: [card('J', 'D')],
    streetIndex: 1,
    turn: 0,
    street: [2, 2],
    chips: [2, 2],
    sb: 0,
    raiseAmount: 4,
  })
  paired = leduc.apply(paired, 'check')
  paired = leduc.apply(paired, 'check')
  assert.equal(paired.over.reason, '双方对子平分')
  assert.equal(paired.over.winner, 'push')
  assert.equal(paired.over.payoffs[0] + paired.over.payoffs[1], 0)

  let tied = leduc.fromSpec({
    hands: [[card('K', 'S')], [card('K', 'H')]],
    board: [card('Q', 'S')],
    streetIndex: 1,
    turn: 0,
    street: [2, 2],
    chips: [2, 2],
    sb: 0,
    raiseAmount: 4,
  })
  tied = leduc.apply(tied, 'check')
  tied = leduc.apply(tied, 'check')
  assert.equal(tied.over.reason, '同点平分')

  let folded = leduc.fromSpec({
    hands: [[card('J', 'S')], [card('K', 'H')]],
    turn: 0,
    sb: 0,
    street: [1, 2],
    chips: [1, 2],
  })
  const hole = cardCode(folded.hands[1][0])
  folded = leduc.apply(folded, 'fold')
  const foldedView = leduc.publicView(folded)
  assert.equal(JSON.stringify(foldedView).includes(hole), false)
  assert.match(foldedView.caption, /暗牌/)

  const capped = leduc.fromSpec({
    hands: [[card('Q', 'S')], [card('J', 'H')]],
    raises: 2,
    turn: 0,
    street: [6, 6],
    chips: [6, 6],
    sb: 0,
  })
  const before = structuredClone(capped)
  assert.throws(() => leduc.apply(capped, 'raise'), /不合法/)
  assert.deepEqual(capped.chips, before.chips)
  assert.deepEqual(capped.hands, before.hands)

  let street = leduc.start(8)
  while (!street.over) {
    const legal = leduc.legal(street)
    street = leduc.apply(street, legal.includes('check') ? 'check' : 'call')
  }
  assert.equal(street.board.length, 1)

  let limit = limitHoldem.start(5)
  let sawTurn = false
  while (!limit.over) {
    const view = limitHoldem.publicView(limit)
    hides(view, opponentCodes(limit), new Set(limit.hands[0].map(cardCode)))
    assert.match(view.caption, /暗牌/)
    if (limit.streetIndex >= 2) {
      sawTurn = true
      assert.equal(limit.raiseAmount, 4)
    }
    const legal = limitHoldem.legal(limit)
    limit = limitHoldem.apply(limit, legal.includes('check') ? 'check' : 'call')
  }
  assert.equal(sawTurn, true)
  assert.equal(limit.board.length, 5)
  assert.equal(limit.raiseAmount, 4)
  const shown = limitHoldem.publicView(limit)
  for (const code of opponentCodes(limit)) assert.equal(JSON.stringify(shown).includes(code), true)

  let muck = limitHoldem.start(2)
  while (limitHoldem.actor(muck) !== 'human') muck = limitHoldem.apply(muck, limitHoldem.ai(muck))
  const hidden = opponentCodes(muck)
  muck = limitHoldem.apply(muck, 'fold')
  const muckView = limitHoldem.publicView(muck)
  hides(muckView, hidden, new Set(muck.hands[0].map(cardCode)))
  assert.match(muckView.caption, /暗牌/)

  const five = (...items) => items.map(([rank, suit]) => card(rank, suit))
  assert.ok(compareScores(
    bestScore(five(['A', 'S'], ['2', 'H'], ['3', 'D'], ['4', 'C'], ['5', 'S'])),
    bestScore(five(['2', 'S'], ['3', 'H'], ['4', 'D'], ['5', 'C'], ['6', 'S'])),
  ) < 0)
  assert.ok(compareScores(
    bestScore(five(['2', 'H'], ['5', 'H'], ['7', 'H'], ['9', 'H'], ['J', 'H'])),
    bestScore(five(['9', 'S'], ['T', 'H'], ['J', 'D'], ['Q', 'C'], ['K', 'S'])),
  ) > 0)
  assert.equal(bestScore(five(['K', 'S'], ['K', 'H'], ['K', 'D'], ['9', 'C'], ['9', 'S']))[0], 7)
  assert.ok(compareScores(
    bestScore(five(['A', 'S'], ['A', 'H'], ['K', 'D'], ['K', 'C'], ['5', 'S'])),
    bestScore(five(['A', 'D'], ['A', 'C'], ['Q', 'S'], ['Q', 'H'], ['9', 'D'])),
  ) > 0)
  assert.equal(bestScore(five(['9', 'S'], ['9', 'H'], ['9', 'D'], ['9', 'C'], ['3', 'S']))[0], 8)
})

test('uno keeps two-player actions, auto-play draws, and hidden opponent cards', () => {
  let win = uno.fromSpec({
    hands: [[unoCard('r', '5')], [unoCard('g', '9')]],
    target: unoCard('r', '3'),
    turn: 0,
  })
  win = uno.apply(win, 'r-5')
  assert.equal(win.over.winner, 'player')
  assert.equal(JSON.stringify(uno.publicView(win)).includes('g-9'), false)

  const blocked = uno.fromSpec({
    hands: [[unoCard('r', '5'), unoCard('g', 'wild_draw_4')], [unoCard('b', '1')]],
    target: unoCard('r', '3'),
    turn: 0,
  })
  const blockedLegal = uno.legal(blocked)
  assert.equal(blockedLegal.includes('r-5'), true)
  assert.equal(blockedLegal.some((action) => action.endsWith('wild_draw_4')), false)

  let played = uno.fromSpec({
    hands: [[unoCard('g', '1')], [unoCard('b', '2')]],
    target: unoCard('r', '3'),
    deck: [unoCard('r', '7')],
    turn: 0,
  })
  assert.deepEqual(uno.legal(played), ['draw'])
  played = uno.apply(played, 'draw')
  assert.equal(played.hands[0].some((item) => item.trait === '7'), false)
  assert.equal(played.target.color, 'r')
  assert.equal(played.target.trait, '7')

  let kept = uno.fromSpec({
    hands: [[unoCard('g', '1')], [unoCard('b', '2')]],
    target: unoCard('r', '3'),
    deck: [unoCard('y', '2')],
    turn: 0,
  })
  kept = uno.apply(kept, 'draw')
  assert.equal(kept.hands[0].some((item) => item.color === 'y' && item.trait === '2'), true)

  let wild = uno.fromSpec({
    hands: [[unoCard('g', '1')], [unoCard('b', '2')]],
    target: unoCard('r', '3'),
    deck: [unoCard('r', 'wild')],
    turn: 0,
    rng: 1,
  })
  wild = uno.apply(wild, 'draw')
  assert.equal(wild.hands[0].some((item) => item.trait === 'wild'), false)
  assert.equal(wild.target.trait, 'wild')
  assert.ok(['r', 'g', 'b', 'y'].includes(wild.target.color))

  let skip = uno.fromSpec({
    hands: [[unoCard('r', 'skip'), unoCard('g', '1')], [unoCard('b', '2')]],
    target: unoCard('r', '3'),
    turn: 0,
    direction: 1,
  })
  skip = uno.apply(skip, 'r-skip')
  assert.equal(skip.over, null)
  assert.equal(skip.turn, 0)

  let reverse = uno.fromSpec({
    hands: [[unoCard('r', 'reverse'), unoCard('g', '1')], [unoCard('b', '2')]],
    target: unoCard('r', '3'),
    turn: 0,
    direction: 1,
  })
  reverse = uno.apply(reverse, 'r-reverse')
  assert.equal(reverse.direction, -1)
  assert.equal(reverse.turn, 1)

  let sawSkip = false
  let sawReverse = false
  let sawDraw = false
  for (let seed = 1; seed <= 400 && !(sawSkip && sawReverse && sawDraw); seed++) {
    const state = uno.start(seed)
    assert.notEqual(state.target.trait, 'wild_draw_4')
    if (state.target.trait === 'skip') {
      sawSkip = true
      assert.equal(state.turn, 1)
    }
    if (state.target.trait === 'reverse') {
      sawReverse = true
      assert.equal(state.direction, -1)
      assert.equal(state.turn, 1)
    }
    if (state.target.trait === 'draw_2') {
      sawDraw = true
      assert.equal(state.turn, 0)
      assert.equal(state.hands[0].length, 9)
    }
  }
  assert.equal(sawSkip && sawReverse && sawDraw, true)
})

test('doudizhu plays match the pinned generator and hide the other hands', () => {
  for (const [hand, dump] of Object.entries(DUMPS)) {
    assert.deepEqual(sortedPlays(hand), dump.split('|').sort(), hand)
    for (const play of playableFromHand(hand)) assert.ok(typesOf(play).length > 0, play)
  }
  assert.equal(playableFromHand('3333BR').has('3333BR'), false)
  assert.equal(playableFromHand('333444BR').has('333444BR'), false)
  assert.equal(playableFromHand('33344456').has('33344456'), true)
  assert.equal(playableFromHand('3334445566').has('3334445566'), true)
  assert.equal(playableFromHand('3456789TJQKA').size, 48)
  assert.equal(playableFromHand('333444555666').size, 57)
  assert.equal(playableFromHand('334455667788').size, 25)
  assert.equal(playableFromHand('33344455').has('33344455'), true)
  assert.deepEqual(typesOf('34555'), [])
  assert.deepEqual(typesOf('JQKA2'), [])
  assert.deepEqual(typesOf('3666'), [{ type: 'trio_solo', weight: 3 }])

  assert.equal(beats('45678', '34567'), true)
  assert.equal(beats('4444', '3333'), true)
  assert.equal(beats('4444', '34567'), true)
  assert.equal(beats('BR', '2222'), true)
  assert.equal(beats('3444', '3334'), true)
  assert.equal(beats('555566', '333344'), true)
  assert.equal(beats('333344', '4444'), false)
  assert.equal(beats('4444', '555566'), true)
  assert.equal(beats('345678', '34567'), false)

  const landlord = doudizhu.apply(doudizhu.fromSpec({ hands: ['3', '4', '5'], turn: 0 }), '3')
  assert.equal(landlord.over.winner, 'player')
  assert.equal(landlord.over.reason, '地主胜')
  const peasant = doudizhu.apply(doudizhu.fromSpec({ hands: ['4', '3', '5'], turn: 1 }), '3')
  assert.equal(peasant.over.winner, 'ai')
  assert.equal(peasant.over.reason, '农民胜')

  const secret = doudizhu.publicView(doudizhu.fromSpec({ hands: ['3', '89TJQKA', '22BR'], bottom: '4', turn: 0 }))
  const secretText = JSON.stringify(secret)
  assert.equal(secretText.includes('89TJQKA'), false)
  assert.equal(secretText.includes('22BR'), false)

  let lead = doudizhu.fromSpec({ hands: ['345', '678', '9TJ'], turn: 0 })
  lead = doudizhu.apply(lead, '3')
  lead = doudizhu.apply(lead, 'pass')
  lead = doudizhu.apply(lead, 'pass')
  assert.equal(lead.turn, 0)
  assert.equal(doudizhu.legal(lead).includes('pass'), false)
})

test('each engine only returns legal actions and the scripted games finish', () => {
  for (const engine of [leduc, limitHoldem, doudizhu]) {
    for (let seed = 1; seed <= 5; seed++) {
      let state = engine.start(seed)
      let steps = 0
      while (!state.over && steps < 200) {
        const action = engine.actor(state) === 'human'
          ? (engine.legal(state).includes('check') ? 'check' : engine.legal(state).includes('call') ? 'call' : engine.ai(state))
          : engine.ai(state)
        assert.equal(engine.legal(state).includes(action), true, `${engine.id} ${seed} ${action}`)
        state = engine.apply(state, action)
        steps += 1
      }
      assert.ok(state.over, engine.id)
    }
  }
  for (let seed = 1; seed <= 5; seed++) {
    let state = uno.start(seed)
    let steps = 0
    while (!state.over && steps < 250) {
      const action = uno.ai(state)
      assert.equal(uno.legal(state).includes(action), true, action)
      state = uno.apply(state, action)
      steps += 1
    }
  }
})

test('table images and captions do not read a hidden card', () => {
  const plain = renderTable({ game: 'leduc', mark: 'LED', rows: [{ label: 'A', cards: [{ hidden: true }] }] }).png
  const dirty = renderTable({
    game: 'leduc',
    mark: 'LED',
    rows: [{ label: 'A', cards: [{ hidden: true, code: 'QH', rank: 'Q', suit: 'H', text: 'QH' }] }],
  }).png
  assert.deepEqual(plain, dirty)
  const view = leduc.publicView(leduc.fromSpec({
    hands: [[card('J', 'S')], [card('Q', 'H')]],
    turn: 0,
    sb: 0,
    street: [1, 2],
    chips: [1, 2],
  }))
  const caption = captionFor({ type: 'open', view: { ...view, game: 'leduc', label: '勒杜克扑克' } })
  assert.equal(caption.includes(cardCode(view.rows[0].cards[0]) === 'JS' ? 'QH' : cardCode({ rank: 'Q', suit: 'H' })), false)
  assert.match(caption, /暗牌/)
})

test('saves stay split by game and context, and lastResult does not cross games', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-games-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  const key = contextKey({ sessionId: 'iso' })
  try {
    const opened = await openSession({ game: 'leduc', skipSource: true, seed: 7, sessionId: 'iso', persist: true, playerName: 'Shiro' })
    const dealt = leduc.replay(7, [])
    const secret = cardCode(dealt.hands[1][0])
    const own = cardCode(dealt.hands[0][0])
    if (secret !== own) {
      assert.equal(JSON.stringify(opened).includes(secret), false)
      assert.equal(readFileSync(saveFileFor(key, 'leduc'), 'utf8').includes(secret), false)
    }
    await assert.rejects(() => openSession({ game: 'uno', skipSource: true, sessionId: 'iso', persist: true }), /已经有一局/)
    assert.equal(closeSession(key).closed, true)

    const other = await openSession({ game: 'uno', skipSource: true, seed: 3, sessionId: 'iso', persist: true })
    assert.equal(other.resumed, undefined)
    assert.equal(other.lastResult, undefined)
    assert.equal(other.game, 'uno')
    assert.equal(closeSession(key).closed, true)

    const again = await openSession({ game: 'leduc', skipSource: true, seed: 99, sessionId: 'iso', persist: true })
    assert.equal(again.resumed.moveCount >= 0, true)
    assert.equal(again.id, opened.id)
    const kept = lookSession(key).id
    const cleared = await resetGame(key, 'uno')
    assert.equal(cleared.active, false)
    assert.equal(lookSession(key).id, kept)
    assert.equal(existsSync(saveFileFor(key, 'uno')), false)
    const redealt = await resetGame(key, 'leduc')
    assert.equal(redealt.reset, true)
    assert.equal(redealt.game, 'leduc')
    assert.notEqual(redealt.id, kept)

    let view = lookSession(key)
    let guard = 0
    while (!view.over && guard < 40) {
      const action = view.legal.includes('fold') ? 'fold' : view.legal[0]
      view = (await playSession(key, action, 'human')).view
      guard += 1
    }
    assert.ok(view.over)
    const reason = view.over.reason
    assert.equal(closeSession(key).closed, true)
    const follow = await openSession({ game: 'leduc', skipSource: true, seed: 4, sessionId: 'iso', persist: true })
    assert.equal(follow.lastResult.reason, reason)
    assert.equal(closeSession(key).closed, true)

    const unoView = await openSession({ game: 'uno', skipSource: true, seed: 6, sessionId: 'iso', persist: true })
    assert.equal(unoView.lastResult, undefined)
    assert.equal(JSON.stringify(unoView).includes(reason), false)
    const unoSave = JSON.parse(readFileSync(saveFileFor(key, 'uno'), 'utf8'))
    assert.equal(unoSave.options.players, 4)
    const replayed = uno.replay(6, unoSave.actions, unoSave.options)
    const opponent = replayed.hands[1].map((item) => `${item.color}-${item.trait}`).join(' ')
    if (opponent.length > 8) assert.equal(readFileSync(saveFileFor(key, 'uno'), 'utf8').includes(opponent), false)
    assert.equal(closeSession(key).closed, true)
    assert.equal(existsSync(saveFileFor(key, 'leduc')), true)
    const onlyUno = await resetGame(key, 'uno')
    assert.equal(onlyUno.active, false)
    assert.equal(existsSync(saveFileFor(key, 'uno')), false)
    assert.equal(existsSync(saveFileFor(key, 'leduc')), true)
  } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
