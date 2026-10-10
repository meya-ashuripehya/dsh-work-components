/**
 * 日历天气预报。数据来自 Open-Meteo（CC BY 4.0），不使用高德，也不需要 Key。
 * 使用进程自己的 fetch，从而沿用 HTTPS_PROXY；不走地图的直连代理绕过。
 */

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'

const WEATHER_TEXT = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '强雷暴伴冰雹',
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export function weatherText(code) {
  return WEATHER_TEXT[Number(code)] || '未知'
}

function weekdayLabel(ymd) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''))
  if (!matched) return ''
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])))
  return WEEK[date.getUTCDay()] || ''
}

function formatTemp(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return String(Math.round(n))
}

function fail(error) {
  const name = error?.name
  if (name === 'TimeoutError' || name === 'AbortError') return new Error('天气请求失败：超时')
  const message = String(error?.message || '网络错误')
  if (message.startsWith('天气请求失败')) return error instanceof Error ? error : new Error(message)
  return new Error('天气请求失败：' + message)
}

async function getJson(url, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-workbench' },
      signal: AbortSignal.timeout(12000),
    })
  } catch (error) {
    throw fail(error)
  }
  if (response && response.ok === false) throw new Error('天气请求失败：HTTP ' + (response.status || ''))
  let json
  try {
    if (response && typeof response.json === 'function') json = await response.json()
    else json = JSON.parse(await response.text())
  } catch {
    throw new Error('天气请求失败：返回的不是 JSON')
  }
  if (json && json.error) {
    const reason = String(json.reason || '接口拒绝').slice(0, 80)
    throw new Error('天气请求失败：' + reason)
  }
  return json
}

/**
 * @param {string} city 城市名。纯数字（高德 adcode）不查询。
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ city: string, source: string, forecasts: object[] }>}
 */
export async function forecastCity(city, fetchImpl = globalThis.fetch) {
  const name = String(city ?? '').trim()
  if (!name) return null
  if (/^\d+$/.test(name)) throw new Error('天气城市请填写城市名，例如成都')

  const geoUrl = new URL(GEOCODE)
  geoUrl.searchParams.set('name', name)
  geoUrl.searchParams.set('count', '5')
  geoUrl.searchParams.set('language', 'zh')
  geoUrl.searchParams.set('format', 'json')
  const geo = await getJson(geoUrl, fetchImpl)
  const results = Array.isArray(geo?.results) ? geo.results : []
  const place = results.find((item) => item && item.country_code === 'CN') || results[0]
  if (!place || place.latitude == null || place.longitude == null) {
    throw new Error('没有找到城市：' + name)
  }

  const forecastUrl = new URL(FORECAST)
  forecastUrl.searchParams.set('latitude', String(place.latitude))
  forecastUrl.searchParams.set('longitude', String(place.longitude))
  forecastUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min')
  forecastUrl.searchParams.set('timezone', 'Asia/Shanghai')
  forecastUrl.searchParams.set('forecast_days', '4')
  const report = await getJson(forecastUrl, fetchImpl)
  const daily = report?.daily || {}
  const times = Array.isArray(daily.time) ? daily.time : []
  const forecasts = times.slice(0, 4).map((date, index) => {
    const text = weatherText(daily.weather_code?.[index])
    return {
      date: String(date),
      week: weekdayLabel(date),
      dayWeather: text,
      nightWeather: text,
      dayTemp: formatTemp(daily.temperature_2m_max?.[index]),
      nightTemp: formatTemp(daily.temperature_2m_min?.[index]),
    }
  })
  return {
    city: String(place.name || name),
    source: 'Open-Meteo',
    forecasts,
  }
}
