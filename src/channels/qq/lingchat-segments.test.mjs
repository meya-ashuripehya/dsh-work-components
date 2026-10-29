import assert from 'node:assert/strict'
import { parseLingChatSegments, qqOutboundPieces, isSkipReply } from './lingchat-segments.mjs'

const segs = parseLingChatSegments(`【高兴】今天要不要一起吃蛋糕呀？
【无语】只是今天天气有点不好呢。
（后退了两步）
【慌张】被那种东西碰到的话，感觉浑身都不干净啦！`)
assert.equal(segs.length, 3)
assert.equal(segs[0].emotion, '高兴')
assert.equal(segs[0].text, '今天要不要一起吃蛋糕呀？')
assert.match(segs[1].text, /天气/)
assert.match(segs[1].text, /后退/)
assert.equal(segs[2].emotion, '慌张')

const pieces = qqOutboundPieces(`【高兴】你好呀~
【调皮】要不要出去走走？`)
assert.deepEqual(pieces, ['你好呀~', '要不要出去走走？'])

assert.equal(isSkipReply('【跳过】'), true)
assert.deepEqual(qqOutboundPieces('【跳过】'), [])
assert.deepEqual(qqOutboundPieces('普通一句没有标签'), ['普通一句没有标签'])

console.log('lingchat-segments ok')