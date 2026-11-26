import test from 'node:test'
import assert from 'node:assert/strict'
import { toHarnessUserMessage } from '../../vendor/wsz987/channel-harness/lib/message-converter.js'
import { harnessConfig as telegramConfig } from './telegram/runtime.mjs'
import { harnessConfig as qqConfig } from './qq/runtime.mjs'

function inbound(channel, type) {
  return {
    channel, accountId: 'main',
    conversation: { id: type === 'group' ? 'group-123' : 'user-123', type },
    sender: { id: 'user-123', name: '角色名' },
    message: { id: 'message-456', content: [
      { type: 'text', text: '晚安，今天也在等你。正文里的 user-123 保留。' },
      { type: 'image', alt: '月亮' },
    ] },
  }
}

for (const [channel, config] of [['telegram', telegramConfig], ['qq', qqConfig]]) {
  test(`${channel}: ID prefix defaults on and respects the existing saved boolean`, () => {
    assert.equal(config().includeMetadataPrefix, true)
    assert.equal(config({ includeMetadataPrefix: true }).includeMetadataPrefix, true)
    assert.equal(config({ includeMetadataPrefix: false }).includeMetadataPrefix, false)
  })
  for (const type of ['dm', 'group']) {
    test(`${channel} ${type}: turning ID prefix off preserves content, attachments and routing identities`, async () => {
      const event = inbound(channel, type)
      const snapshot = structuredClone(event)
      const tagged = await toHarnessUserMessage(event, config({ includeMetadataPrefix: true }))
      const plain = await toHarnessUserMessage(event, config({ includeMetadataPrefix: false }))
      assert.deepEqual(event, snapshot)
      assert.equal(tagged.content.length, plain.content.length + 1)
      assert.match(tagged.content[0].text, /user-123/)
      if (channel === 'telegram') assert.match(tagged.content[0].text, /channel=telegram.*message=message-456/)
      else assert.match(tagged.content[0].text, /角色名/)
      assert.deepEqual(plain.content, tagged.content.slice(1))
      assert.equal(plain.content[0].text, event.message.content[0].text)
      assert.equal(plain.content[1].text, '[image: 月亮]')
      assert.equal(plain.source.kind, 'user')
      assert.equal(event.sender.id, 'user-123')
      assert.equal(event.conversation.type, type)
    })
  }
}

test('Telegram and QQ identity switches are independent', async () => {
  const telegram = await toHarnessUserMessage(inbound('telegram', 'dm'), telegramConfig({ includeMetadataPrefix: false }))
  const qq = await toHarnessUserMessage(inbound('qq', 'dm'), qqConfig())
  assert.equal(telegram.content.length, 2)
  assert.equal(qq.content.length, 3)
  assert.match(qq.content[0].text, /user-123/)
})
