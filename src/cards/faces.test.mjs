import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doudizhu, suitPlan } from './games/doudizhu.mjs'
import { freshDeck, show, uno } from './games/uno.mjs'
import { cardsPage } from './page.mjs'
import { renderTable } from './render.mjs'
import { toLosslessJson } from './json-output.mjs'

function playOut(game, seed, options, each) {
  let state = game.start(seed, options)
  each(state)
  for (let i = 0; i < 400 && !state.over; i++) {
    state = game.apply(state, game.ai(state))
    each(state)
  }
  return state
}

const key = (c) => c.code + c.pip

test('斗地主：同点数四张花色各不相同，整局不变，王无花色', () => {
  for (let seed = 1; seed <= 25; seed++) {
    let before = null
    playOut(doudizhu, seed, undefined, (state) => {
      const plan = suitPlan(state)
      const byRank = {}
      for (const seat of plan) for (const [ch, list] of Object.entries(seat.own)) (byRank[ch] ||= []).push(...list)
      for (const [ch, list] of Object.entries(byRank)) {
        assert.equal(list.length, 4, ch)
        assert.equal(new Set(list).size, 4, ch)
      }
      const view = doudizhu.publicView(state)
      assert.deepEqual(toLosslessJson(view), view)
      const hand = view.rows.find((r) => r.label === 'H').cards
      for (const c of hand) {
        assert.equal('suit' in c, false)
        if (c.code === 'B' || c.code === 'R') {
          assert.equal(c.text, 'JOKER'); assert.equal(c.pip, 'J'); assert.equal(c.color, c.code === 'R' ? 'red' : 'black')
        } else assert.equal(c.color, c.pip === 'H' || c.pip === 'D' ? 'red' : 'black')
        if (c.code === 'T') assert.equal(c.text, '10')
      }
      const now = hand.map(key)
      assert.equal(new Set(now).size, now.length)
      if (before) for (const k of now) assert.ok(before.includes(k), `seed ${seed}: ${k} 换了花色`)
      before = now
      const bottom = view.rows.find((r) => r.label === 'BD')
      if (bottom && state.trace.length === 0) for (const c of bottom.cards) assert.ok(now.includes(key(c)))
    })
  }
})

test('斗地主：显示花色不影响合法动作', () => {
  const state = doudizhu.start(7)
  const view = doudizhu.publicView(state)
  assert.deepEqual(view.legal, doudizhu.legal(state))
})

test('UNO：万能牌手里四色，打出后按所选颜色上色', () => {
  const W = { type: 'wild', color: 'r', trait: 'wild' }
  const W4 = { type: 'wild', color: 'r', trait: 'wild_draw_4' }
  const state = uno.fromSpec({
    hands: [[W, W4, { type: 'number', color: 'b', trait: '5' }], [{ type: 'number', color: 'y', trait: '1' }, { type: 'number', color: 'y', trait: '2' }]],
    deck: Array.from({ length: 10 }, (_, i) => ({ type: 'number', color: 'b', trait: String(i) })),
    target: { type: 'number', color: 'r', trait: '3' },
  })
  const hand = uno.publicView(state).rows[0].cards
  assert.deepEqual(hand.filter((c) => c.wild).map((c) => [c.text, c.tone]), [['W', ''], ['+4', '']])
  const next = uno.apply(state, 'g-wild')
  const top = uno.publicView(next).rows.find((r) => r.label === 'T').cards[0]
  assert.equal(top.tone, 'g'); assert.equal(top.wild, true); assert.equal(top.kind, 'wild')
  assert.ok(renderTable(uno.publicView(next)).png.length > 100)
})

test('UNO：牌面文字从不是原始编码，动作牌有专用图标', () => {
  const faces = freshDeck().map((c) => show(c))
  for (const f of faces) assert.doesNotMatch(String(f.text), /^[rgby]-/)
  assert.deepEqual([...new Set(faces.filter((f) => f.kind !== 'number').map((f) => f.text))].sort(), ['+2', '+4', 'W', '⇄', '⊘'].sort())
  assert.equal(new Set(faces.map((f) => f.kind + f.text + f.tone)).size, 54)
})

test('页面：牌面用 card.text，不显示 r-wild 一类原始编码', () => {
  const page = cardsPage()
  const src = page.match(/var TONE[^\n]*\n/)[0] + page.match(/var UNO_WHEEL[^\n]*\n/)[0] + page.match(/var PIP_SYMBOL[^\n]*\n/)[0] + page.match(/function cardEl[\s\S]*?\n}\n/)[0]
  const el = () => { const n = { className: '', style: {}, children: [], _t: '', classList: { add() {} } }
    Object.defineProperty(n, 'textContent', { get() { return n._t + n.children.map((c) => c.textContent).join('') }, set(v) { n._t = v } })
    n.append = (...k) => n.children.push(...k); return n }
  const document = { createElement: el }
  const cardEl = new Function('document', src + '; return cardEl')(document)
  const views = []
  playOut(uno, 3, { players: 4 }, (s) => views.push(uno.publicView(s)))
  for (const v of views) for (const row of v.rows) for (const c of row.cards) {
    const n = cardEl(c)
    if (!c.hidden) { assert.equal(n.textContent, c.text); assert.doesNotMatch(n.textContent, /^[rgby]-/) }
  }
  for (const c of doudizhu.publicView(doudizhu.start(5)).rows[0].cards) { const n = cardEl(c); assert.notEqual(n.textContent, 'T'); assert.ok(n.textContent.startsWith(c.text)) }
})
