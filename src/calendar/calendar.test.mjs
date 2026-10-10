import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeDay, shanghaiToday } from './day.mjs'
import { weatherCodes, weatherKind, weatherKindFromText, weatherText, WEATHER_EMOJI } from './weather.mjs'
import { buildMonth } from './month.mjs'
import { deleteEvent, listEvents, saveEvent } from './store.mjs'
import { createCalendarTools } from './tools.mjs'
import { createCalendarFeature } from './index.mjs'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-cal-'))
}

test('2026 spring festival is lunar new year, a rest day, and the day of 立春 is marked', () => {
  const day = describeDay(2026, 2, 17)
  assert.equal(day.lunarText, '正月初一')
  assert.equal(day.holiday, '春节')
  assert.equal(day.rest, true)
  assert.equal(day.work, false)
  assert.equal(day.festivals.includes('春节'), true)
  assert.equal(describeDay(2026, 2, 4).term, '立春')
  const shift = describeDay(2026, 2, 14)
  assert.equal(shift.work, true)
  assert.equal(shift.rest, false)
  assert.equal(describeDay(2026, 1, 1).holiday, '元旦节')
})

test('shanghai today stays on the China date when the host is still on the previous evening', () => {
  assert.equal(shanghaiToday(new Date('2026-10-09T18:00:00Z')), '2026-10-10')
})

test('events persist, edit, cover a date range, and delete', async () => {
  const dir = await tempDir()
  try {
    const created = await saveEvent({ title: '出发', date: '2026-10-10', time: '14:30', note: '金桥' }, dir)
    assert.match(created.id, /^evt_/)
    assert.equal(created.allDay, false)
    assert.equal(created.time, '14:30')
    const updated = await saveEvent({ id: created.id, title: '返程', date: '2026-10-10', endDate: '2026-10-11' }, dir)
    assert.equal(updated.title, '返程')
    assert.equal(updated.endDate, '2026-10-11')
    assert.equal(updated.time, '14:30')
    const saved = await listEvents(dir)
    assert.equal(saved.length, 1)
    const month = await buildMonth('2026-10', { dir })
    assert.equal(month.days.find((day) => day.date === '2026-10-10').events[0].title, '返程')
    assert.equal(month.days.find((day) => day.date === '2026-10-11').events[0].id, created.id)
    assert.equal(month.days.find((day) => day.date === '2026-10-12').events.length, 0)
    assert.equal(month.weather, null)
    await deleteEvent(created.id, dir)
    assert.equal((await listEvents(dir)).length, 0)
    await assert.rejects(() => deleteEvent(created.id, dir), (error) => error.status === 404)
    await assert.rejects(() => saveEvent({ title: '', date: '2026-10-10' }, dir))
    await assert.rejects(() => saveEvent({ title: '坏日期', date: '2026-02-31' }, dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('calendar month uses Open-Meteo and attaches a stubbed forecast', async () => {
  const dir = await tempDir()
  try {
    let calls = 0
    const view = await buildMonth('2026-02', {
      dir,
      city: '510100',
      fetchImpl: async () => {
        calls += 1
        throw new Error('should not request an adcode')
      },
    })
    assert.equal(calls, 0)
    assert.match(view.weather.error, /城市名/)
    assert.equal(view.days.find((day) => day.date === '2026-02-17').forecast, null)

    const failed = await buildMonth('2026-02', {
      dir,
      city: '成都',
      fetchImpl: async (url) => {
        const parsed = new URL(String(url))
        assert.equal(parsed.searchParams.has('key'), false)
        assert.match(parsed.hostname, /open-meteo\.com$/)
        throw new Error('fetch failed')
      },
    })
    assert.match(failed.weather.error, /天气请求失败/)
    assert.equal(JSON.stringify(failed).includes('restapi.amap.com'), false)
    assert.equal(JSON.stringify(failed).includes('key='), false)

    const ok = await buildMonth('2026-02', {
      dir,
      city: '成都',
      fetchImpl: async (url) => {
        const parsed = new URL(String(url))
        assert.equal(parsed.searchParams.has('key'), false)
        assert.match(parsed.hostname, /open-meteo\.com$/)
        if (parsed.pathname === '/v1/search') {
          assert.equal(parsed.searchParams.get('name'), '成都')
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                results: [
                  { name: 'Chengdu', latitude: 1, longitude: 2, country_code: 'US' },
                  { name: '成都', latitude: 30.67, longitude: 104.07, country_code: 'CN' },
                ],
              })
            },
          }
        }
        assert.equal(parsed.pathname, '/v1/forecast')
        assert.equal(parsed.searchParams.get('latitude'), '30.67')
        assert.equal(parsed.searchParams.get('timezone'), 'Asia/Shanghai')
        assert.equal(parsed.searchParams.get('forecast_days'), '16')
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              daily: {
                time: ['2026-02-17', '2026-02-18'],
                weather_code: [0, 3],
                temperature_2m_max: [12.4, 11],
                temperature_2m_min: [4.2, 3],
              },
            })
          },
        }
      },
    })
    assert.equal(ok.weather.city, '成都')
    assert.equal(ok.weather.source, 'Open-Meteo')
    const forecast = ok.days.find((day) => day.date === '2026-02-17').forecast
    assert.equal(forecast.dayWeather, '晴')
    assert.equal(forecast.icon, 'clear')
    assert.equal(forecast.dayTemp, '12')
    assert.equal(forecast.nightTemp, '4')
    assert.equal(forecast.week, '二')
    assert.equal(ok.days.find((day) => day.date === '2026-02-18').forecast.dayWeather, '阴')
    assert.equal(ok.days.find((day) => day.date === '2026-02-18').forecast.icon, 'overcast')
    assert.equal(ok.weather.forecasts.length, 2)
    assert.equal(ok.days.find((day) => day.date === '2026-02-16').forecast, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every Open-Meteo weather code maps to a kind and a telegram emoji', () => {
  for (const code of weatherCodes()) {
    const kind = weatherKind(code)
    assert.notEqual(kind, 'unknown', String(code))
    assert.ok(WEATHER_EMOJI[kind], kind)
    assert.equal(weatherKindFromText(weatherText(code)), kind)
  }
  assert.equal(weatherKind(12345), 'unknown')
  assert.equal(WEATHER_EMOJI.unknown, '🌡️')
})

test('calendar_show card is text only for the model and a calendar mm block for the page', async () => {
  const dir = await tempDir()
  try {
    const tools = createCalendarTools({
      dir,
      getConfig: () => ({ calendarCity: '成都', gaodeApiKey: 'unused-gaode-key' }),
      fetchImpl: async () => { throw new Error('fetch failed') },
    })
    assert.deepEqual(tools.map((tool) => tool.name), ['calendar_show', 'calendar_event_save', 'calendar_event_delete'])
    const show = tools[0]
    const value = await show.execute({ month: '2026-02' })
    const blocks = show.output.render({}, value)
    assert.deepEqual(blocks.map((block) => block.type), ['text'])
    assert.match(value.weather.error, /天气请求失败/)
    assert.equal(blocks[0].text.includes('unused-gaode-key'), false)
    assert.equal(blocks[0].text.includes('restapi.amap.com'), false)
    const meta = show.output.presentationMeta({}, value)
    assert.equal(meta.mm.type, 'mm')
    assert.equal(meta.mm.kind, 'calendar')
    assert.equal(meta.mm.calendar.month, '2026-02')
    assert.equal(JSON.stringify(meta).includes('unused-gaode-key'), false)
    const saved = await tools[1].execute({ title: '开会', date: '2026-02-17', time: '09:00' })
    assert.equal(saved.event.title, '开会')
    const again = await show.execute({ month: '2026-02' })
    assert.equal(again.days.find((day) => day.date === '2026-02-17').events[0].id, saved.event.id)
    await tools[2].execute({ id: saved.event.id })
    const after = await show.execute({ month: '2026-02' })
    assert.equal(after.days.find((day) => day.date === '2026-02-17').events.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('calendar tools mount by default and unmount when disabled', async () => {
  const registered = []
  let disposed = 0
  const ctx = {
    plugin(def) {
      const sub = {
        inject(_names, apply) { apply(sub) },
        tools: { register(tool) { registered.push(tool.name) } },
      }
      def.apply(sub)
      return { async dispose() { disposed += 1 } }
    },
  }
  let cfg = {}
  const feature = createCalendarFeature(ctx, () => cfg)
  await feature.sync()
  assert.equal(feature.state().mounted, true)
  assert.deepEqual(registered, ['calendar_show', 'calendar_event_save', 'calendar_event_delete'])
  cfg = { calendarEnabled: false }
  await feature.sync()
  assert.equal(disposed, 1)
  assert.equal(feature.state().mounted, false)
  assert.equal(feature.state().detail, '未启用')
  await feature.dispose()
})
