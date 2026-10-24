import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatIdKey, splitChatIds, findRoomConflicts, findChannelConflicts, roomConflictMessage, channelConflictMessage } from './group-conflict.mjs'

test('chatIdKey normalizes number/string and the -100 supergroup prefix', () => {
  assert.equal(chatIdKey('-1001234567890'), '1234567890')
  assert.equal(chatIdKey(-1001234567890), '1234567890')
  assert.equal(chatIdKey('1234567890'), '1234567890')
  assert.equal(chatIdKey(' -123456789 '), '123456789')
  assert.equal(chatIdKey('abc'), '')
  assert.equal(chatIdKey(''), '')
})

test('splitChatIds accepts text with mixed separators and arrays', () => {
  assert.deepEqual(splitChatIds('-1001, -1002\n-1003，-1004'), ['-1001', '-1002', '-1003', '-1004'])
  assert.deepEqual(splitChatIds([-1001, ' -1002 ', '']), ['-1001', '-1002'])
})

test('findRoomConflicts reports channel IDs already bound to a room', () => {
  const rooms = [{ id: 'r1', title: '圆桌', telegramChatIds: ['-1001234567890'] }, { id: 'r2', title: '空房', telegramChatIds: [] }]
  const c = findRoomConflicts('1234567890\n-1009999999999\n-1001234567890', rooms)
  assert.deepEqual(c, [{ chatId: '1234567890', roomId: 'r1', roomTitle: '圆桌' }])
  assert.equal(roomConflictMessage(c).startsWith('群聊 1234567890 已绑定到聊天室「圆桌」，不能再加入通道'), true)
  assert.deepEqual(findRoomConflicts('', rooms), [])
})

test('findChannelConflicts reports room IDs already configured in the channel', () => {
  assert.deepEqual(findChannelConflicts(['-1001234567890', '-1005555555555'], '1234567890, -42424242'), ['-1001234567890'])
  assert.deepEqual(findChannelConflicts([-42424242], '-42424242'), ['-42424242'])
  assert.deepEqual(findChannelConflicts(['-1001234567890'], ''), [])
  assert.match(channelConflictMessage(['-1001234567890']), /^群聊 -1001234567890 已在 Telegram 通道中配置，请先从通道移除/)
})
