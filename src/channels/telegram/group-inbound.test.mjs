import test from 'node:test'
import assert from 'node:assert/strict'
import { mapInbound } from '../../../vendor/wsz987/channel-telegram/lib/mapper.js'

const bot = { id: 8942606654, username: 'kujira_deepseek_bot' }
const meta = { channel: 'telegram', accountId: 'main', bot }

function update(message) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: -1009000000001, type: 'supergroup', title: 'lkun' },
      from: { id: 9000000001, first_name: 'Shiro' },
      ...message,
    },
  }
}

test('plain @username wakes even without a mention entity', () => {
  const event = mapInbound(update({ text: '@kujira_deepseek_bot 111' }), meta)
  assert.equal(event.conversation.type, 'group')
  assert.equal(event.conversation.id, '-1009000000001')
  assert.equal(event.message.activation.mentionedBot, true)
})

test('a longer name does not count as this bot', () => {
  const event = mapInbound(update({ text: '@kujira_deepseek_bot_two 111' }), meta)
  assert.equal(event.message.activation.mentionedBot, false)
})

test('reply to the bot wakes without an @', () => {
  const event = mapInbound(update({
    text: '111',
    reply_to_message: { message_id: 9, from: { id: bot.id, username: bot.username } },
  }), meta)
  assert.equal(event.message.activation.mentionedBot, true)
})

test('ordinary group text is not a mention', () => {
  const event = mapInbound(update({ text: '111' }), meta)
  assert.equal(event.message.activation.mentionedBot, false)
})
