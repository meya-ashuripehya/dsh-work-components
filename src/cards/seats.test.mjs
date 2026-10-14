import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextKey } from './context.mjs'
import { cardCode } from './rules.mjs'
import { closeSession, lookSession, openSession, playSession, resetSession, saveFileFor } from './session.mjs'
import { createCardsTools } from './tools.mjs'
import { cardsPage } from './page.mjs'

async function withData(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cards-seats-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  try { await fn() } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

function toolsFor(cfg = {}) {
  return Object.fromEntries(createCardsTools({ getConfig: () => cfg }).map((t) => [t.name, t]))
}

/** 用户座位 0 的真实手牌（从存档重放取得），用于断言 AI 输出里没有它。 */
async function userHandCodes(key, game, options) {
  const { engineFor } = await import('./games/index.mjs')
  const saved = JSON.parse(readFileSync(saveFileFor(key, game), 'utf8'))
  const state = engineFor(game).replay(saved.seed, saved.actions, saved.options)
  const hand = state.hands[0]
  if (game === 'doudizhu') return { state, codes: [hand] }
  if (game === 'uno') return { state, codes: hand.map((c) => `${c.color}-${c.trait}`) }
  return { state, codes: hand.map(cardCode) }
}

function containsUserHand(json, codes, game) {
  if (game === 'doudizhu') return json.includes(`"${codes[0]}"`)
  // UNO 有同名牌，按整手的序列判断；扑克按每张单独判断（AI 的牌不同）
  if (game === 'uno') return json.includes(codes.join('","'))
  return codes.some((c) => json.includes(`"${c}"`))
}

test('versus: AI tool output is its own seat only and never contains the user hand', async () => {
  await withData(async () => {
    for (const game of ['uno', 'doudizhu', 'leduc', 'limit-holdem']) {
      for (let seed = 1; seed <= 6; seed++) {
        resetSession()
        const tools = toolsFor({ cardsUnoPlayers: 4 })
        const exec = { agent: { id: `iso-${game}-${seed}` } }
        const key = contextKey({ sessionId: exec.agent.id })
        const opened = await tools.card_open.execute({ game }, exec)
        assert.equal(opened.mode, 'versus')
        assert.equal(opened.you.seat, 1)
        assert.equal(opened.rows, undefined)
        assert.equal(opened.caption, undefined)
        const { state, codes } = await userHandCodes(key, game)
        if (state.over) { closeSession(key); continue }
        const mine = state.hands[1]
        const expectMine = game === 'doudizhu' ? mine : game === 'uno' ? mine.map((c) => `${c.color}-${c.trait}`) : mine.map(cardCode)
        assert.deepEqual(opened.yourHand, expectMine)
        for (const out of [opened, await tools.card_look.execute({}, exec)]) {
          assert.equal(containsUserHand(JSON.stringify(out), codes, game), false, `${game} ${seed} leaked user hand`)
        }
        // 页面视图里是用户自己的手牌
        const page = lookSession(key)
        assert.equal(page.rows.find((r) => r.label === 'H').cards.length, game === 'doudizhu' ? codes[0].length : codes.length)
        closeSession(key)
      }
    }
  })
})

test('versus: turn enforcement between user, AI and bots', async () => {
  await withData(async () => {
    const tools = toolsFor({ cardsUnoPlayers: 4 })
    const exec = { agent: { id: 'turns' } }
    const key = contextKey({ sessionId: 'turns' })
    let view = await tools.card_open.execute({ game: 'uno' }, exec)
    let guard = 0
    while (!view.over && guard++ < 400) {
      const user = lookSession(key)
      if (view.turn === 'user') {
        assert.equal(user.canAct, true)
        assert.deepEqual(view.legal, [])
        await assert.rejects(() => tools.card_play.execute({ action: 'draw' }, exec), /user's turn/)
        const pick = user.drawAction || user.rows.find((r) => r.label === 'H').cards.find((c) => c.playable)?.play[0]
        const played = await playSession(key, pick, 'human')
        assert.ok(played.prompt.includes('用户'))
        if (!played.view.over && played.view.turnRole === 'agent') assert.match(played.prompt, /轮到你（AI/)
        view = played.agentView
      } else if (view.turn === 'you') {
        assert.equal(user.canAct, false)
        assert.equal(user.turnRole, 'agent')
        await assert.rejects(() => playSession(key, view.legal[0], 'human'), /不是你的回合/)
        view = await tools.card_play.execute({ action: view.legal[0] }, exec)
      } else assert.fail(`bots must auto-advance, got turn ${view.turn}`)
    }
    assert.ok(view.over)
    assert.ok(['you_win', 'you_lose', 'draw'].includes(view.over.result))
    closeSession(key)

    // 两人扑克：用户对 AI
    const poker = await tools.card_open.execute({ game: 'leduc' }, { agent: { id: 'p2' } })
    assert.equal(poker.seats.length, 2)
    assert.deepEqual(poker.seats.map((s) => s.role), ['user', 'agent'])
    closeSession(contextKey({ sessionId: 'p2' }))

    // 斗地主：用户地主座位 0，AI 座位 1，机器人座位 2
    const ddz = await tools.card_open.execute({ game: 'doudizhu' }, { agent: { id: 'dd' } })
    assert.deepEqual(ddz.seats.map((s) => s.role), ['user', 'agent', 'bot'])
    assert.equal(ddz.landlordSeat, 0)
    assert.equal(ddz.turn, 'user')
    closeSession(contextKey({ sessionId: 'dd' }))

    // 二十一点 versus：AI 不能替用户要牌
    await tools.card_open.execute({ game: 'blackjack' }, { agent: { id: 'bj' } })
    const bjKey = contextKey({ sessionId: 'bj' })
    if (!lookSession(bjKey).over) await assert.rejects(() => tools.card_play.execute({ action: 'hit' }, { agent: { id: 'bj' } }), /belongs to the user/)
    closeSession(bjKey)
  })
})

test('solo mode keeps the old single-seat behaviour, and old saves without mode still resume', async () => {
  await withData(async () => {
    const tools = toolsFor()
    const exec = { agent: { id: 'solo-1' } }
    const key = contextKey({ sessionId: 'solo-1' })
    const view = await tools.card_open.execute({ game: 'leduc', mode: 'solo' }, exec)
    assert.equal(view.mode, 'solo')
    assert.equal(view.you.seat, 0)
    if (!view.over) {
      const after = await tools.card_play.execute({ action: view.legal[0] }, exec)
      assert.equal(after.moveCount >= 1, true)
    }
    closeSession(key)

    // 旧存档：去掉 mode 字段后续局
    const legacy = { agent: { id: 'legacy' } }
    const lkey = contextKey({ sessionId: 'legacy' })
    await openSession({ game: 'uno', skipSource: true, seed: 5, sessionId: 'legacy', persist: true, gameOptions: { unoPlayers: 3 } })
    let user = lookSession(lkey)
    if (!user.over) await playSession(lkey, user.drawAction || user.legal[0], 'human')
    closeSession(lkey)
    const file = saveFileFor(lkey, 'uno')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    delete data.mode
    writeFileSync(file, JSON.stringify(data))
    const resumed = await tools.card_open.execute({ game: 'uno' }, legacy)
    if (!data.over) {
      assert.equal(resumed.resumed.moveCount, data.actions.length)
      assert.equal(resumed.mode, 'versus')
    }
    closeSession(lkey)
  })
})

test('page: click-to-play annotations, dimming, draw pile and doudizhu selection controls', async () => {
  await withData(async () => {
    const key = contextKey({ sessionId: 'click' })
    const opened = await openSession({ game: 'uno', skipSource: true, seed: 11, sessionId: 'click', persist: false, mode: 'versus', gameOptions: { unoPlayers: 3 } })
    if (!opened.over && opened.canAct) {
      const cards = opened.rows.find((r) => r.label === 'H').cards
      assert.equal(opened.handMode, 'single')
      for (const c of cards) {
        assert.equal(typeof c.playable, 'boolean')
        for (const a of c.play) assert.ok(opened.legal.includes(a))
        if (c.wild && c.playable) assert.equal(c.play.length, 4)
      }
      if (opened.legal.includes('draw')) {
        assert.equal(opened.drawAction, 'draw')
        assert.ok(cards.every((c) => !c.playable))
      }
    }
    closeSession(key)
    const dd = await openSession({ game: 'doudizhu', skipSource: true, seed: 3, sessionId: 'click', persist: false, mode: 'versus' })
    assert.equal(dd.handMode, 'multi')
    assert.ok(dd.rows.find((r) => r.label === 'H').cards.every((c) => typeof c.rank === 'string' && c.playable === true))
    closeSession(key)
    const html = cardsPage()
    for (const marker of ['wirePlay', 'chooseColor', 'draw-pile', '"出牌"', '"不出"', 'Enter', '.card.dim']) assert.ok(html.includes(marker), marker)
  })
})

test('UNO never auto-plays a drawn card: drawer chooses to play it or pass; old saves replay the old way', async () => {
  const { uno } = await import('./games/uno.mjs')
  const c = (color, trait) => ({ type: trait === 'wild' || trait === 'wild_draw_4' ? 'wild' : /^\d$/.test(trait) ? 'number' : 'action', color, trait })
  const spec = { hands: [[c('b', '3')], [c('g', '7')], [c('y', '1')]], deck: [c('r', '9')], target: c('r', '5'), turn: 0, drawChoice: true }
  let s = uno.fromSpec(spec)
  assert.deepEqual(uno.legal(s), ['draw'])
  s = uno.apply(s, 'draw')
  assert.equal(s.turn, 0, 'drawer keeps the turn')
  assert.equal(s.hands[0].length, 2, 'drawn card stays in hand')
  assert.deepEqual(uno.legal(s), ['r-9', 'pass'])
  const kept = uno.apply(s, 'pass')
  assert.equal(kept.turn, 1)
  assert.equal(kept.hands[0].length, 2)
  const played = uno.apply(s, 'r-9')
  assert.equal(played.turn, 1)
  assert.equal(played.target.trait, '9')
  assert.deepEqual(played.hands[0].map((x) => x.trait), ['3'])
  // 不能出的牌：摸完直接轮到下家
  const dead = uno.apply(uno.fromSpec({ ...spec, deck: [c('g', '2')] }), 'draw')
  assert.equal(dead.turn, 1)
  // 摸到万能牌：自己选颜色
  const wild = uno.apply(uno.fromSpec({ ...spec, deck: [c('r', 'wild')] }), 'draw')
  assert.deepEqual(uno.legal(wild), ['r-wild', 'g-wild', 'b-wild', 'y-wild', 'pass'])
  // 旧规则（旧存档，没有 drawChoice）：仍按旧版自动打出，重放结果不变
  const legacy = uno.apply(uno.fromSpec({ ...spec, drawChoice: false }), 'draw')
  assert.equal(legacy.turn, 1)
  assert.equal(legacy.hands[0].length, 1)
  assert.equal(uno.validOptions({ players: 4 }), true)
  assert.equal(uno.validOptions({ players: 4, drawChoice: true }), true)
  assert.equal(uno.defaultOptions({}).drawChoice, true)
  assert.equal(uno.canonical('不出'), 'pass')
})

test('session: AI seat gets drawnCard and must decide; page gets pass control for the user', async () => {
  await withData(async () => {
    let foundAgent = false
    let foundUser = false
    for (let seed = 1; seed < 300 && !(foundAgent && foundUser); seed++) {
      resetSession()
      const tools = toolsFor({ cardsUnoPlayers: 3 })
      const exec = { agent: { id: `dr${seed}` } }
      const key = contextKey({ sessionId: exec.agent.id })
      let view = await tools.card_open.execute({ game: 'uno' }, exec)
      for (let step = 0; step < 60 && !view.over; step++) {
        if (view.turn === 'you') {
          if (view.drawnCard) {
            foundAgent = true
            assert.ok(view.legal.includes('pass'))
            assert.ok(view.legal.every((a) => a === 'pass' || a.split('-')[1] === view.drawnCard.split('-')[1]))
            view = await tools.card_play.execute({ action: 'pass' }, exec)
          } else view = await tools.card_play.execute({ action: view.legal.includes('draw') ? 'draw' : view.legal[0] }, exec)
        } else {
          const user = lookSession(key)
          if (user.passAction) {
            foundUser = true
            const cards = user.rows.find((r) => r.label === 'H').cards
            assert.equal(cards.filter((x) => x.playable).length, 1)
            assert.equal(user.drawAction, undefined)
            view = (await playSession(key, 'pass', 'human')).agentView
          } else view = (await playSession(key, user.drawAction || 'draw', 'human').catch(() => playSession(key, user.legal[0], 'human'))).agentView
        }
      }
      closeSession(key)
    }
    assert.ok(foundAgent && foundUser)
  })
})
