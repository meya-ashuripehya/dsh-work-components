import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuthorizedIds as resolveQqAuthorizedIds } from './owner-gate.mjs'
import { resolveAuthorizedIds as resolveTelegramAuthorizedIds } from '../telegram/owner-gate.mjs'

const OPENID = 'B4C6E62A8A0919E62678494F20F30530'
const OWNER = '9000000001'

test('QQ authorized OpenIDs pass; Telegram numeric IDs stay on the Telegram resolver', () => {
  assert.deepEqual(resolveQqAuthorizedIds(OPENID, ''), [OPENID])
  assert.deepEqual(resolveQqAuthorizedIds(`${OPENID}, ${OPENID}  C0FFEE00C0FFEE00C0FFEE00C0FFEE00`, OWNER), [
    OPENID,
    'C0FFEE00C0FFEE00C0FFEE00C0FFEE00',
  ])
  assert.deepEqual(resolveQqAuthorizedIds('', OPENID), [OPENID])
  assert.deepEqual(resolveQqAuthorizedIds('   ', ''), [])
  assert.throws(() => resolveQqAuthorizedIds('bad id!', OPENID), /QQ 开放平台 OpenID/)
  assert.throws(() => resolveQqAuthorizedIds(`short, ${OPENID}`, OPENID), /QQ 开放平台 OpenID/)

  assert.throws(() => resolveTelegramAuthorizedIds(OPENID, OWNER), /不是 Telegram 数字用户 ID/)
  assert.deepEqual(resolveTelegramAuthorizedIds('6153059771, -1003435238151', OWNER), ['6153059771', '-1003435238151'])
  assert.throws(() => resolveTelegramAuthorizedIds('abc', OWNER), /不是 Telegram 数字用户 ID/)
})

test('bundled QQ runtime accepts OpenID authorized ids', async () => {
  const qq = await import(new URL('../../../lib/channel-qq.mjs', import.meta.url).href)
  assert.deepEqual(qq.resolveAuthorizedIds(OPENID, ''), [OPENID])
  assert.deepEqual(qq.resolveAuthorizedIds(`${OPENID}, ${OPENID}`, 'owneropenid123456789012345678901234'), [OPENID])
  assert.throws(() => qq.resolveAuthorizedIds('short', OPENID), /QQ 开放平台 OpenID/)
  assert.throws(() => qq.resolveAuthorizedIds('bad id!', ''), /QQ 开放平台 OpenID/)
})
