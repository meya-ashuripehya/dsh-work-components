import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMapPlaceDelivery } from './place.mjs'
import { calendarTelegramMessages, calendarsFromToolResult, installCalendarDelivery } from './calendar.mjs'

function sampleCalendar() {
  return {
    title: '2026年2月',
    month: '2026-02',
    today: '2026-02-17',
    weather: { city: '成都', source: 'Open-Meteo' },
    days: [
      {
        date: '2026-02-16',
        solarDay: 16,
        weekdayLabel: '一',
        lunarText: '腊月廿九',
        forecast: { icon: 'overcast', dayWeather: '阴', dayTemp: '11', nightTemp: '3' },
      },
      {
        date: '2026-02-17',
        solarDay: 17,
        weekdayLabel: '二',
        lunarText: '正月初一',
        holiday: '春节',
        rest: true,
        forecast: { dayWeather: '晴', dayTemp: '12', nightTemp: '4' },
        events: [{ title: '出发 <金桥>', time: '14:30', allDay: false }],
      },
    ],
  }
}

test('calendar html uses weather emoji, marks today, and escapes event text', () => {
  const [text] = calendarTelegramMessages(sampleCalendar())
  assert.match(text, /<b>2026年2月<\/b>/)
  assert.match(text, /成都 · Open-Meteo/)
  assert.match(text, /16日 周一 腊月廿九 ☁️ 11°\/3° 阴/)
  assert.match(text, /今天 17日 周二 正月初一 ☀️ 12°\/4° 晴 休 春节 14:30 出发 &lt;金桥&gt;/)
  assert.equal(text.includes('<金桥>'), false)
  assert.equal(text.length <= 3800, true)
})

test('a long month is split into several messages that each repeat the title', () => {
  const days = []
  for (let day = 1; day <= 31; day++) {
    days.push({
      date: '2026-10-' + String(day).padStart(2, '0'),
      solarDay: day,
      weekdayLabel: '六',
      lunarText: '历'.repeat(180),
      forecast: { icon: 'rain-heavy', dayWeather: '大雨', dayTemp: '20', nightTemp: '14' },
      events: [{ title: '事项'.repeat(30), allDay: true }],
    })
  }
  const chunks = calendarTelegramMessages({ title: '2026年10月', today: '2026-10-01', days })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3800)
    assert.match(chunk, /<b>2026年10月<\/b>/)
  }
})

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

test('a calendar card is sent as HTML and still forwards unrelated images', async () => {
  const installed = installCalendarDelivery(Router)
  assert.equal(installed, true)
  assert.equal(installCalendarDelivery(Router), false)
  const router = new Router()
  router.collectToolResultImages({ id: 's1' }, {
    data: {
      turn: 3,
      meta: { mm: { type: 'mm', kind: 'calendar', calendar: sampleCalendar() } },
      message: { isError: false, content: [{ type: 'text', text: '{}' }] },
    },
  })
  assert.equal(router.collected, 1)
  assert.equal(router.pendingCalendars.get('s1:3').length, 1)

  const calls = []
  await router.deliverTurnImages('s1', 3, {
    adapter: { upstream: { requestOk: async (method, body) => { calls.push({ method, body }); return { data: { ok: true } } } } },
    target: { conversationId: '6153059771' },
  })
  assert.equal(router.deliveredImages, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'sendMessage')
  assert.equal(calls[0].body.chat_id, '6153059771')
  assert.equal(calls[0].body.parse_mode, 'HTML')
  assert.match(calls[0].body.text, /2026年2月/)
  assert.equal(router.pendingCalendars.has('s1:3'), false)

  assert.equal(calendarsFromToolResult({ data: { message: { isError: true }, meta: { mm: { type: 'mm', kind: 'calendar', calendar: {} } } } }).length, 0)
  router.pendingCalendars.set('s1:9', [{}])
  router.dispose()
  assert.equal(router.disposed, true)
  assert.equal(router.pendingCalendars.size, 0)
})

test('calendar delivery stays outside map venues and does not swallow them', async () => {
  class Both {
    constructor() {
      this.options = { replyContexts: { getTurn: () => ({}) }, logger: { warn() {} } }
      this.active = new Map()
      this.currentTurns = new Map()
      this.pendingImages = new Map()
      this.collected = 0
    }

    collectToolResultImages() { this.collected += 1 }
    async deliverTurnImages() { this.deliveredImages = true }
    dispose() { this.disposed = true }
  }
  assert.equal(installMapPlaceDelivery(Both), true)
  assert.equal(installCalendarDelivery(Both), true)
  const router = new Both()
  router.collectToolResultImages({ id: 's1' }, {
    data: {
      turn: 2,
      meta: {
        mm: {
          type: 'mm',
          kind: 'place',
          place: { wgsLatitude: 30.57, wgsLongitude: 104.06, title: '蜜雪冰城', address: '金雁路' },
        },
      },
      message: { isError: false, content: [{ type: 'image', attachment: { attachmentId: 'att-map', mediaType: 'image/png' } }] },
    },
  })
  assert.equal(router.collected, 0)
  assert.equal(router.pendingPlaces.get('s1:2').length, 1)
  const calls = []
  await router.deliverTurnImages('s1', 2, {
    adapter: { upstream: { requestOk: async (method, body) => { calls.push(method + ':' + body.title) } } },
    target: { conversationId: '1' },
  })
  assert.deepEqual(calls, ['sendVenue:蜜雪冰城'])
  assert.equal(router.deliveredImages, true)
})
