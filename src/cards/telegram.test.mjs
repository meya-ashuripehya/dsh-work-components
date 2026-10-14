import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTelegramBridge } from '../boards/telegram-bridge.mjs'
import { DENY_MESSAGE, createOwnerGate, isOpenTool } from '../channels/telegram/owner-gate.mjs'
import { installCardsLink } from '../channels/telegram/cards-link.mjs'
import { clearCardsInbound, setCardsInbound } from './telegram-bridge.mjs'
import { cardCode, replay, startFromSeed } from './rules.mjs'
import { renderTable } from './render.mjs'
import { closeSession, openSession, resetSession } from './session.mjs'
import { captionFor, handleCardInbound, installCardsTelegram, whenCardsPublished } from './telegram.mjs'

function findHiddenSeed() {
  for (let seed = 1; seed < 8000; seed++) {
    const state = startFromSeed(seed)
    if (state.over) continue
    const hit = replay(seed, ['hit'])
    if (hit.over) continue
    return { seed, hole: cardCode(state.dealer[1]) }
  }
  throw new Error('seed search failed')
}

test('telegram replaces the table image and the owner gate leaves only look and play open', async () => {
  assert.equal(isOpenTool('card_look'), true)
  assert.equal(isOpenTool('card_play'), true)
  assert.equal(isOpenTool('card_open'), false)
  assert.equal(isOpenTool('card_close'), false)
  assert.equal(isOpenTool('card_reset'), false)
  const gate = createOwnerGate({ authorized: ['6153059771'] })
  gate.noteTurn('tg-1', '7000000001')
  const exec = (name) => ({ name, agent: { id: 'tg-1' } })
  assert.equal(gate.check(exec('card_open')), DENY_MESSAGE)
  assert.equal(gate.check(exec('card_close')), DENY_MESSAGE)
  assert.equal(gate.check(exec('card_reset')), DENY_MESSAGE)
  assert.equal(gate.check(exec('card_look')), undefined)
  assert.equal(gate.check(exec('card_play')), undefined)

  class Bridge {
    constructor() { this.last = ''; this.notice = '' }
    async handleQueuedMessage(_event, _key, text) { this.last = text; return { text } }
    async sendCommandNotice(_event, notice) { this.notice = notice }
  }
  installCardsLink(Bridge)
  const link = new Bridge()
  const hook = async ({ text }) => (text === 'hit' ? { notice: 'nope' } : null)
  setCardsInbound(hook)
  const event = { channel: 'telegram', raw: { message: { chat: { id: 1 } } }, conversation: { id: 1 }, sender: { id: 2 }, message: { content: [] } }
  const passed = await link.handleQueuedMessage(event, 'k', '你好', null, 1)
  assert.equal(passed.text, '你好')
  const stopped = await link.handleQueuedMessage(event, 'k', 'hit', null, 1)
  assert.equal(stopped, undefined)
  assert.equal(link.notice, 'nope')
  clearCardsInbound(hook)

  const root = await mkdtemp(join(tmpdir(), 'dsh-cards-tg-'))
  const previous = process.env.DSH_WORKBENCH_DATA_DIR
  process.env.DSH_WORKBENCH_DATA_DIR = root
  resetSession()
  const sent = []
  const deleted = []
  setTelegramBridge({
    lookup(id) {
      return id === 'agent-tg' ? { chatId: '900', senderId: '5', conversationType: 'dm' } : null
    },
    async sendPhoto({ png, caption, chatId }) {
      sent.push({ png: Buffer.from(png), caption, chatId })
      return 1000 + sent.length
    },
    async deletePhoto({ messageId }) { deleted.push(String(messageId)) },
  })
  const off = installCardsTelegram()
  const { seed, hole } = findHiddenSeed()
  const origin = { channel: 'telegram', chatId: '900', threadId: '', conversationType: 'dm', starterId: '5', messageId: null }
  try {
    const before = sent.length
    await openSession({ skipSource: true, seed, sessionId: 'desk-quiet', persist: true })
    assert.equal(sent.length, before)
    closeSession()

    const view = await openSession({ skipSource: true, seed, sessionId: 'agent-tg', origin, persist: true, playerName: 'Shiro' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, '900')
    assert.match(sent[0].caption, /暗牌/)
    assert.equal(sent[0].caption.includes(hole), false)
    assert.deepEqual(sent[0].png, renderTable(view).png)
    assert.equal(captionFor({ type: 'open', view }).includes(hole), false)

    const spoken = await handleCardInbound({ chatId: '900', senderId: '5', text: '要牌, 再来一张' })
    assert.match(spoken.forward, /要牌了，并说：再来一张。现在仍是玩家回合/)
    await whenCardsPublished()
    assert.equal(sent.length, 2)
    assert.equal(deleted.includes('1001'), true)
    assert.equal(sent[1].caption.includes(hole), false)
    assert.match(sent[1].caption, /暗牌/)

    assert.equal(await handleCardInbound({ chatId: '900', senderId: '5', text: '你好' }), null)
    assert.equal(await handleCardInbound({ chatId: '901', senderId: '5', text: 'hit' }), null)
    const ended = await handleCardInbound({ chatId: '900', senderId: '5', text: '停牌, 就这样' })
    assert.match(ended.forward, /停牌了，并说：就这样。/)
    assert.match(ended.forward, /可以调用 card_close/)
    await whenCardsPublished()
    assert.match(sent.at(-1).caption, /终局/)
    assert.equal(sent.at(-1).caption.includes(hole), true)
    closeSession()

    const group = { channel: 'telegram', chatId: '901', threadId: '', conversationType: 'group', starterId: '5', messageId: null }
    await openSession({ skipSource: true, seed, sessionId: 'agent-g', origin: group, persist: true, playerName: 'Shiro' })
    await whenCardsPublished()
    assert.deepEqual(await handleCardInbound({ chatId: '901', senderId: '9', text: 'hit' }), { notice: '只有发起这手的人可以要牌或停牌' })
    assert.equal(await handleCardInbound({ chatId: '901', senderId: '9', text: 'hit, 帮我看一眼' }), null)
    assert.equal(await handleCardInbound({ chatId: '901', senderId: '9', text: '你好' }), null)
    const stood = await handleCardInbound({ chatId: '901', senderId: '5', text: '停牌' })
    assert.match(stood.forward, /停牌/)
    await whenCardsPublished()
    assert.match(sent.at(-1).caption, /终局/)
  } finally {
    try { off() } catch { /* ignore */ }
    resetSession()
    setTelegramBridge(null)
    if (previous === undefined) delete process.env.DSH_WORKBENCH_DATA_DIR
    else process.env.DSH_WORKBENCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
