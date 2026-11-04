import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import {
  CHANNEL_CAPABILITIES,
  channelIdFromHarnessEvent,
  channelIdFromOrigin,
  channelIdFromSource,
  capabilitiesFor,
  normalizeChannelId,
  noteQQSessionOrigin,
  originForSession,
  resetQQSessionOrigins,
  resolveChannelId,
  resolveSurface,
  lookupSessionChannelHit,
} from './surface.mjs'
import {
  installQQSessionOriginLink,
  originFromQQContext,
} from './qq/session-origin.mjs'
import { clearTelegramBridge, setTelegramBridge } from '../boards/telegram-bridge.mjs'

describe('normalizeChannelId', () => {
  it('maps aliases', () => {
    assert.equal(normalizeChannelId('desktop'), 'desktop')
    assert.equal(normalizeChannelId('local'), 'desktop')
    assert.equal(normalizeChannelId('Telegram'), 'telegram')
    assert.equal(normalizeChannelId('tg'), 'telegram')
    assert.equal(normalizeChannelId('QQ'), 'qq')
    assert.equal(normalizeChannelId('qqbot'), 'qq')
    assert.equal(normalizeChannelId('nope'), null)
  })
})

describe('channelIdFromSource / harness', () => {
  it('reads channelId / channel / surface', () => {
    assert.equal(channelIdFromSource({ channelId: 'qq' }), 'qq')
    assert.equal(channelIdFromSource({ channel: 'telegram' }), 'telegram')
    assert.equal(channelIdFromSource({ surface: 'desktop' }), 'desktop')
  })
  it('reads nested harness event fields', () => {
    assert.equal(channelIdFromHarnessEvent({ conversation: { channel: 'qq' } }), 'qq')
    assert.equal(channelIdFromHarnessEvent({ binding: { surface: 'telegram' } }), 'telegram')
  })
  it('origin defaults to desktop when empty', () => {
    assert.equal(channelIdFromOrigin(null), 'desktop')
    assert.equal(channelIdFromOrigin({ channel: 'qq' }), 'qq')
  })
})

describe('capabilities', () => {
  it('telegram rich true, qq calendarCard true (map still stub)', () => {
    assert.equal(capabilitiesFor('telegram').calendarCard, true)
    assert.equal(capabilitiesFor('qq').calendarCard, true)
    assert.equal(capabilitiesFor('qq').mapVenue, false)
    assert.equal(CHANNEL_CAPABILITIES.desktop.boardPhoto, true)
  })
})

describe('QQ session origin + resolveChannelId', () => {
  beforeEach(() => resetQQSessionOrigins())

  it('notes and looks up qq session', () => {
    noteQQSessionOrigin('sess-a', {
      conversationId: 'group-1',
      senderId: 'u1',
      conversationType: 'group',
    })
    const hit = lookupSessionChannelHit('sess-a')
    assert.ok(hit)
    assert.equal(hit.channelId, 'qq')
    assert.equal(hit.chatId, 'group-1')
    assert.equal(hit.conversationType, 'group')
  })

  it('resolveChannelId prefers session qq over desktop default', () => {
    noteQQSessionOrigin('agent-1', { conversationId: 'c9', conversationType: 'dm', senderId: 's' })
    assert.equal(resolveChannelId({ sessionId: 'agent-1' }), 'qq')
    assert.equal(resolveChannelId({ exec: { agent: { id: 'agent-1' } } }), 'qq')
    assert.equal(resolveChannelId({}), 'desktop')
  })

  it('explicit origin wins over empty session', () => {
    assert.equal(resolveChannelId({ origin: { channel: 'telegram' } }), 'telegram')
  })

  it('originForSession returns qq stub origin', () => {
    noteQQSessionOrigin('s2', { conversationId: 'peer', conversationType: 'dm', senderId: 'me' })
    const o = originForSession('s2')
    assert.equal(o.channel, 'qq')
    assert.equal(o.chatId, 'peer')
    assert.equal(o.peerId, 'peer')
  })

  it('resolveSurface carries capabilities and peer', () => {
    noteQQSessionOrigin('s3', { conversationId: 'g', conversationType: 'group' })
    const s = resolveSurface({ sessionId: 's3' })
    assert.equal(s.channelId, 'qq')
    assert.equal(s.capabilities.calendarCard, true)
    assert.equal(s.peerId, 'g')
  })
})


describe('Telegram session bridge + resolveChannelId', () => {
  let bridge

  beforeEach(() => {
    resetQQSessionOrigins()
    bridge = {
      lookup(sessionId) {
        if (String(sessionId) !== 'tg-sess') return null
        return {
          chatId: '9000000001',
          senderId: '7000000002',
          conversationType: 'dm',
          accountId: 'main',
        }
      },
    }
    setTelegramBridge(bridge)
  })

  afterEach(() => {
    clearTelegramBridge(bridge)
  })

  it('bridge lookup yields channelId telegram for tools', () => {
    const hit = lookupSessionChannelHit('tg-sess')
    assert.ok(hit)
    assert.equal(hit.channelId, 'telegram')
    assert.equal(hit.chatId, '9000000001')
    assert.equal(resolveChannelId({ sessionId: 'tg-sess' }), 'telegram')
    assert.equal(resolveChannelId({ exec: { agent: {id: 'tg-sess' } } }), 'telegram')
    const surface = resolveSurface({ sessionId: 'tg-sess' })
    assert.equal(surface.channelId, 'telegram')
    assert.equal(surface.peerId, '9000000001')
    assert.equal(surface.capabilities.calendarCard, true)
    const origin = originForSession('tg-sess')
    assert.equal(origin.channel, 'telegram')
    assert.equal(origin.chatId, '9000000001')
  })

  it('unknown session stays desktop without origin', () => {
    assert.equal(resolveChannelId({ sessionId: 'desk-only' }), 'desktop')
  })
})


describe('installQQSessionOriginLink (live harness register shape)', () => {
  /** Fresh class each suite so __dshQQSessionOrigin can install once. */
  let ReplyContextStore

  beforeEach(() => {
    resetQQSessionOrigins()
    ReplyContextStore = class {
      register(messageId, pending) {
        this.last = { messageId, pending }
      }
    }
    assert.equal(installQQSessionOriginLink(ReplyContextStore), true)
    assert.equal(installQQSessionOriginLink(ReplyContextStore), false)
  })

  it('originFromQQContext reads C2C author.user_openid and group_openid', () => {
    const dm = originFromQQContext({
      conversationType: 'dm',
      senderId: 'user-openid-dm',
      raw: { author: { user_openid: 'user-openid-dm' } },
    })
    assert.equal(dm.chatId, 'user-openid-dm')
    assert.equal(dm.conversationType, 'dm')
    const group = originFromQQContext({
      conversationType: 'group',
      senderId: 'member-openid',
      raw: { group_openid: 'group-openid-1', author: { member_openid: 'member-openid' } },
    })
    assert.equal(group.chatId, 'group-openid-1')
    assert.equal(group.conversationType, 'group')
    assert.equal(group.senderId, 'member-openid')
  })

  it('register notes qq origin; resolveChannelId === qq for dm and group', () => {
    const store = new ReplyContextStore()
    store.register('msg-dm', {
      sessionId: 'qq-live-dm',
      context: {
        conversationType: 'dm',
        senderId: 'user-openid-dm',
        replyToMessageId: 'm1',
        raw: { id: 'm1', author: { user_openid: 'user-openid-dm' } },
        runId: 'r1',
      },
    })
    store.register('msg-g', {
      sessionId: 'qq-live-group',
      context: {
        conversationType: 'group',
        senderId: 'member-openid',
        replyToMessageId: 'm2',
        raw: {
          id: 'm2',
          group_openid: 'group-openid-1',
          author: { member_openid: 'member-openid' },
        },
        runId: 'r2',
      },
    })
    assert.equal(resolveChannelId({ sessionId: 'qq-live-dm' }), 'qq')
    assert.equal(resolveChannelId({ exec: { agent: { id: 'qq-live-dm' } } }), 'qq')
    assert.equal(resolveChannelId({ sessionId: 'qq-live-group' }), 'qq')
    const dmHit = lookupSessionChannelHit('qq-live-dm')
    assert.equal(dmHit.channelId, 'qq')
    assert.equal(dmHit.chatId, 'user-openid-dm')
    const gHit = lookupSessionChannelHit('qq-live-group')
    assert.equal(gHit.channelId, 'qq')
    assert.equal(gHit.chatId, 'group-openid-1')
  })

  it('dm with senderId only (no raw author) still resolves qq', () => {
    const store = new ReplyContextStore()
    store.register('msg-dm2', {
      sessionId: 'qq-live-dm2',
      context: {
        conversationType: 'dm',
        senderId: 'only-sender',
        replyToMessageId: 'm3',
        raw: { id: 'm3' },
        runId: 'r3',
      },
    })
    assert.equal(resolveChannelId({ sessionId: 'qq-live-dm2' }), 'qq')
    assert.equal(lookupSessionChannelHit('qq-live-dm2').chatId, 'only-sender')
  })
})
