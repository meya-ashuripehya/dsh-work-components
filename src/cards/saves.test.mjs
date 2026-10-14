import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextKey } from './context.mjs'
import { cardCode, publicView, replay, startFromSeed } from './rules.mjs'
import { closeSession, lookSession, openSession, playSession, resetGame, resetSession, saveFileFor } from './session.mjs'
import { createCardsTools } from './tools.mjs'

function findSeeds() {
  let playable = null
  let natural = null
  for (let seed = 1; seed < 8000 && (!playable || !natural); seed++) {
    const state = startFromSeed(seed)
    if (!natural && state.over?.reason === '天成') natural = seed
    if (!playable && !state.over) {
      const hit = replay(seed, ['hit'])
      const hole = cardCode(state.dealer[1])
      if (!hit.over && !JSON.stringify(publicView(state)).includes(hole)) playable = { seed, hole }
    }
  }
  if (!playable || !natural) throw new Error('seed search failed')
  return { playable, natural }
}

test('saves stay inside one conversation: resume, reset, and lastResult', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-saves-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  const { playable, natural } = findSeeds()
  const deskA = contextKey({ sessionId: 'desk-a' })
  const deskB = contextKey({ sessionId: 'desk-b' })
  const deskC = contextKey({ sessionId: 'desk-c' })
  const chat = { channel: 'telegram', chatId: '42', threadId: '', conversationType: 'dm', starterId: '5', messageId: null }
  const otherThread = { ...chat, threadId: '7' }
  const tg = contextKey({ origin: chat })
  const tgOther = contextKey({ origin: otherThread })
  try {
    const opened = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-a', persist: true, playerName: 'Shiro' })
    assert.equal(opened.revealed, false)
    assert.deepEqual(opened.dealer[1], { hidden: true })
    assert.equal(JSON.stringify(opened.dealer).includes(playable.hole), false)
    assert.equal(opened.dealerScore, handUp(playable.seed))
    const hit = await playSession(deskA, 'hit', 'ai')
    assert.equal(hit.view.revealed, false)
    assert.equal(JSON.stringify(hit.view).includes(playable.hole), false)
    const raw = readFileSync(saveFileFor(deskA), 'utf8')
    assert.equal(raw.includes(playable.hole), false)
    assert.equal(raw.includes('"rank"'), false)
    assert.equal(raw.includes('"suit"'), false)
    assert.equal(closeSession(deskA).closed, true)

    const other = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-b', persist: true })
    assert.equal(other.lastResult, undefined)
    assert.equal(other.resumed, undefined)
    assert.equal(JSON.stringify(other).includes('天成'), false)
    assert.equal(closeSession(deskB).saved, true)

    const resumed = await openSession({ skipSource: true, seed: 99, sessionId: 'desk-a', persist: true })
    assert.equal(resumed.resumed.moveCount, 1)
    assert.equal(resumed.moveCount, 1)
    assert.equal(JSON.stringify(resumed.dealer).includes(playable.hole), false)
    assert.deepEqual(resumed.player.map((card) => card.code), hit.view.player.map((card) => card.code))
    await assert.rejects(() => openSession({ skipSource: true, sessionId: 'desk-b', persist: true }), /另一会话/)
    await assert.rejects(() => openSession({ skipSource: true, sessionId: 'desk-a', persist: true }), /已经有一局/)
    assert.equal(closeSession(deskB).closed, false)
    assert.equal(lookSession(deskA).id, resumed.id)
    assert.throws(() => lookSession(deskB), /没有进行中/)
    await assert.rejects(() => playSession(deskB, 'stand', 'ai'), /没有进行中/)
    assert.equal(closeSession(deskA).closed, true)

    const tools = Object.fromEntries(createCardsTools().map((tool) => [tool.name, tool]))
    const live = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-live', persist: true })
    const looked = await tools.card_look.execute({}, { agent: { id: 'desk-live' } })
    assert.equal(JSON.stringify(looked.dealer).includes(playable.hole), false)
    assert.equal(looked.id, live.id)
    await assert.rejects(() => tools.card_look.execute({}, { agent: { id: 'desk-other' } }), /没有进行中/)
    await assert.rejects(() => tools.card_play.execute({ action: 'stand' }, { agent: { id: 'desk-other' } }), /没有进行中/)
    assert.deepEqual(await tools.card_close.execute({}, { agent: { id: 'desk-other' } }), { closed: false })
    assert.equal(lookSession(contextKey({ sessionId: 'desk-live' })).id, live.id)
    assert.equal(closeSession(contextKey({ sessionId: 'desk-live' })).closed, true)

    const firstTg = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'agent-1', origin: chat, persist: true })
    await playSession(tg, '要牌', 'human')
    assert.equal(closeSession(tg).saved, true)
    const secondAgent = await openSession({ skipSource: true, seed: 3, sessionId: 'agent-2', origin: chat, persist: true })
    assert.equal(secondAgent.resumed.moveCount, 1)
    assert.equal(JSON.stringify(secondAgent.dealer).includes(playable.hole), false)
    assert.equal(closeSession(tg).closed, true)
    const thread = await openSession({ skipSource: true, seed: natural, sessionId: 'agent-2', origin: otherThread, persist: true })
    assert.equal(thread.resumed, undefined)
    assert.equal(thread.over.reason, '天成')
    assert.notEqual(tgOther, tg)
    assert.equal(closeSession(tgOther).closed, true)
    const desktop = await openSession({ skipSource: true, seed: natural, sessionId: 'agent-1', persist: true })
    assert.equal(desktop.resumed, undefined)
    assert.equal(desktop.over.reason, '天成')
    assert.equal(closeSession(contextKey({ sessionId: 'agent-1' })).closed, true)

    const finished = await openSession({ skipSource: true, seed: natural, sessionId: 'desk-c', persist: true })
    assert.equal(finished.over.reason, '天成')
    assert.equal(finished.lastResult, undefined)
    assert.equal(closeSession(deskC).closed, true)
    const beside = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-b', persist: true })
    assert.equal(beside.lastResult, undefined)
    assert.equal(JSON.stringify(beside).includes('天成'), false)
    assert.equal(closeSession(deskB).closed, true)
    const nextA = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-c', persist: true })
    assert.equal(nextA.lastResult.reason, '天成')
    assert.equal(nextA.lastResult.winner, 'player')
    assert.equal(nextA.resumed, undefined)
    assert.equal(nextA.revealed, false)
    assert.equal(closeSession(deskC).closed, true)
    const nextB = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'desk-b', persist: true })
    assert.equal(nextB.resumed.moveCount, 0)
    assert.equal(nextB.lastResult, undefined)
    assert.equal(JSON.stringify(nextB).includes('天成'), false)
    assert.equal(closeSession(deskB).closed, true)

    assert.equal(existsSync(saveFileFor(deskA)), true)
    assert.equal(existsSync(saveFileFor(tg)), true)
    const resetAway = await resetGame(deskA)
    assert.equal(resetAway.active, false)
    assert.equal(existsSync(saveFileFor(deskA)), false)
    assert.equal(existsSync(saveFileFor(tg)), true)
    const back = await openSession({ skipSource: true, seed: playable.seed, sessionId: 'agent-9', origin: chat, persist: true })
    assert.equal(back.resumed.moveCount, 1)
    const redealt = await resetGame(tg)
    assert.equal(redealt.reset, true)
    assert.equal(redealt.moveCount, 0)
    assert.equal(redealt.resumed, undefined)
    assert.equal(existsSync(saveFileFor(deskA)), false)
    assert.equal(existsSync(saveFileFor(tg)), true)
    const secret = cardCode(replay(redealtSeed(tg), []).dealer[1])
    assert.equal(readFileSync(saveFileFor(tg), 'utf8').includes(secret), false)
    assert.equal(JSON.stringify(redealt.dealer).includes(secret), redealt.revealed === true)
  } finally {
    resetSession()
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

function handUp(seed) {
  const state = startFromSeed(seed)
  return publicView(state).dealerScore
}

function redealtSeed(key) {
  return JSON.parse(readFileSync(saveFileFor(key), 'utf8')).seed
}
