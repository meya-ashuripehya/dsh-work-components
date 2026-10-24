import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRawHub, rawHub, setDiscoverHandler, noteDiscover } from '../telegram/raw-hub.mjs'
import { claimPollingToken, channelOwnsToken, resetPollingOwners } from '../telegram/polling-owners.mjs'
import { pollingRestartKey } from '../channels/telegram/accounts.mjs'
import { classifyDestination } from '../telegram/dispatch.mjs'

test('rawHub and polling-owners share globalThis across re-imports', async () => {
  resetPollingOwners()
  rawHub.reset()
  const token = '999:zzzzzzzzzzzzzzzzzzzzzzzz'
  claimPollingToken(token, 'channel', 'main')
  assert.equal(channelOwnsToken(token), true)
  assert.equal(rawHub, globalThis.__dshWorkbenchTelegramRawHub)
  const got = []
  const off = rawHub.subscribe(token, { id: 'x', onUpdate: (u) => got.push(u.update_id) })
  await rawHub.publish(token, { update_id: 42 })
  assert.deepEqual(got, [42])
  off()
  resetPollingOwners()
})

test('noteDiscover bridge works without hub subscribers', async () => {
  const seen = []
  setDiscoverHandler(async (info) => { seen.push(info.chatId) })
  assert.equal(await noteDiscover({ chatId: '-100111', title: 't' }), true)
  assert.deepEqual(seen, ['-100111'])
  setDiscoverHandler(null)
  assert.equal(await noteDiscover({ chatId: '-100222' }), false)
})

test('pollingRestartKey flips when channelOwned changes', () => {
  const base = { seatId: 's1', tokenRef: 'R', hasToken: true, telegramEnabled: true, tokens: ['a'] }
  const a = pollingRestartKey({ ...base, channelOwned: false })
  const b = pollingRestartKey({ ...base, channelOwned: true })
  assert.notEqual(a, b)
})

test('unbound group with chatroom enabled routes to chatroom', () => {
  assert.equal(classifyDestination(
    { chatId: '-5469067315', isGroup: true },
    { boundIds: [], channelGroupIds: '-5118389615', chatroomEnabled: true },
  ), 'chatroom')
})
