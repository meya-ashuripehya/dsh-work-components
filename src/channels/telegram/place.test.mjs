import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMapPlaceDelivery, venueFromMm, venuesFromToolResult } from './place.mjs'

function placeEvent(extra) {
  return {
    data: {
      turn: 3,
      meta: {
        mm: {
          type: 'mm',
          kind: 'place',
          title: '蜜雪冰城',
          source: { url: 'https://uri.amap.com/marker?position=104.06,30.57' },
          place: {
            longitude: 104.06,
            latitude: 30.57,
            wgsLongitude: 104.057,
            wgsLatitude: 30.569,
            title: '蜜雪冰城',
            address: '金雁路32号',
          },
          asset: { attachment: { attachmentId: 'att-map', mediaType: 'image/png' } },
        },
      },
      message: {
        isError: false,
        content: [{ type: 'image', attachment: { attachmentId: 'att-map', mediaType: 'image/png' } }],
      },
      ...extra,
    },
  }
}

class Router {
  constructor() {
    this.options = {
      replyContexts: { getTurn: () => ({}) },
      logger: { warn() {} },
    }
    this.active = new Map()
    this.currentTurns = new Map()
    this.pendingImages = new Map()
    this.collected = 0
  }

  collectToolResultImages() {
    this.collected += 1
  }

  async deliverTurnImages() {
    this.deliveredImages = true
  }

  dispose() {
    this.disposed = true
  }
}

test('venue uses WGS-84 fields and rejects a place without them', () => {
  const [venue] = venuesFromToolResult(placeEvent())
  assert.deepEqual(venue, {
    latitude: 30.569,
    longitude: 104.057,
    title: '蜜雪冰城',
    address: '金雁路32号',
  })
  assert.equal(venueFromMm({ type: 'mm', kind: 'image' }), null)
  assert.equal(venueFromMm({ type: 'mm', kind: 'place', place: { title: '无坐标' } }), null)
})

test('a map place is sent as sendVenue and its preview image is not forwarded', async () => {
  const installed = installMapPlaceDelivery(Router)
  assert.equal(installed, true)
  assert.equal(installMapPlaceDelivery(Router), false)
  const router = new Router()
  router.collectToolResultImages({ id: 's1' }, placeEvent())
  assert.equal(router.collected, 0)
  assert.equal(router.pendingPlaces.get('s1:3').length, 1)

  const calls = []
  await router.deliverTurnImages('s1', 3, {
    adapter: { upstream: { requestOk: async (method, body) => { calls.push({ method, body }); return { data: { ok: true } } } } },
    target: { conversationId: '6153059771' },
  })
  assert.equal(router.deliveredImages, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendVenue')
  assert.equal(calls[0].body.chat_id, '6153059771')
  assert.equal(calls[0].body.latitude, 30.569)
  assert.equal(calls[0].body.longitude, 104.057)
  assert.equal(calls[0].body.title, '蜜雪冰城')
  assert.equal(JSON.stringify(calls[0].body).includes('att-map'), false)

  router.collectToolResultImages({ id: 's1' }, {
    data: {
      turn: 4,
      message: { content: [{ type: 'image', attachment: { attachmentId: 'att-photo', mediaType: 'image/png' } }] },
    },
  })
  assert.equal(router.collected, 1)
  router.pendingPlaces.set('s1:5', [{ title: '待清' }])
  router.dispose()
  assert.equal(router.disposed, true)
  assert.equal(router.pendingPlaces.size, 0)
})
