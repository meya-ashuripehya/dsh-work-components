import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isJsonValue } from '../../vendor/dsh-tools/util-values.js'
import { toLosslessJson } from './json-output.mjs'
import { lookSession, openSession, resetGame, resetSession } from './session.mjs'
import { contextKey } from './context.mjs'
import { createCardsTools } from './tools.mjs'

const GAMES = ['blackjack', 'leduc', 'limit-holdem', 'uno', 'doudizhu']

test('toLosslessJson 规范化不可无损往返的值', () => {
  const out = toLosslessJson({ a: undefined, b: NaN, c: -0, d: [undefined, Infinity], e: new Date(0), f: () => 1, g: new Set([1]) })
  assert.deepEqual(out, { b: null, c: 0, d: [null, null], e: '1970-01-01T00:00:00.000Z', g: [1] })
  assert.equal(Object.is(out.c, 0), true)
  assert.equal(isJsonValue(out), true)
  const cyc = {}; cyc.self = cyc
  assert.throws(() => toLosslessJson(cyc))
})

test('所有牌类工具输出与原始视图都是无损 JSON（含 UNO 2/3/4/10 人与异常设置）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cards-json-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  try {
    for (const setting of [undefined, '', '3', 'abc', 2, 3, 4, 10, 99, -1]) {
      resetSession()
      const tools = Object.fromEntries(createCardsTools({ getConfig: () => ({ cardsUnoPlayers: setting }) }).map((t) => [t.name, t]))
      const exec = { agent: { id: `json-${String(setting)}` } }
      const key = contextKey({ sessionId: exec.agent.id })
      for (const game of GAMES) {
        const ok = (label, value) => assert.equal(isJsonValue(value), true, `${String(setting)} ${game} ${label}`)
        ok('open', await tools.card_open.execute({ game }, exec))
        ok('raw look', lookSession(key))
        ok('reset', await tools.card_reset.execute({ game }, exec))
        ok('raw reset', await resetGame(key, game, { unoPlayers: setting }))
        for (let i = 0; i < 30; i++) {
          const view = await tools.card_look.execute({}, exec)
          ok('look', view)
          if (view.over || !view.legal?.length) break
          ok('play', await tools.card_play.execute({ action: view.legal[0] }, exec))
        }
        ok('close', await tools.card_close.execute({}, exec))
        ok('reset closed', await tools.card_reset.execute({ game }, exec))
      }
    }
  } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
