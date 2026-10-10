/**
 * 把一个月的历法、日程和可选天气预报合成日历卡片数据。
 * 天气来自 Open-Meteo。没有城市时不请求。返回值里没有密钥。
 */
import { daysInMonth, describeDay, formatYmd, parseMonth, shanghaiToday } from './day.mjs'
import { eventCovers, listEvents } from './store.mjs'
import { forecastCity } from './weather.mjs'

function matchForecast(forecasts, date) {
  const compact = date.replace(/-/g, '')
  return (forecasts || []).find((item) => item.date === date || item.date === compact) || null
}

export async function buildMonth(month, options = {}) {
  const parsed = parseMonth(month, options.now)
  const city = String(options.city ?? '').trim()
  const events = await listEvents(options.dir)
  const count = daysInMonth(parsed.year, parsed.month)
  const days = []
  for (let day = 1; day <= count; day++) {
    const info = describeDay(parsed.year, parsed.month, day)
    days.push({
      ...info,
      events: events.filter((event) => eventCovers(event, info.date)),
    })
  }
  let weather = null
  if (city) {
    try {
      const report = await forecastCity(city, options.fetchImpl)
      weather = report
        ? { city: report.city, source: report.source, forecasts: report.forecasts }
        : null
    } catch (error) {
      weather = { city, error: error?.message || '天气请求失败' }
    }
  }
  const label = parsed.year + '年' + parsed.month + '月'
  return {
    month: formatYmd(parsed.year, parsed.month, 1).slice(0, 7),
    title: label,
    today: shanghaiToday(options.now),
    city,
    weather,
    days: days.map((day) => ({
      ...day,
      forecast: weather && !weather.error ? matchForecast(weather.forecasts, day.date) : null,
    })),
  }
}
