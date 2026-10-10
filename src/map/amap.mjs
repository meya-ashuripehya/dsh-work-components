/**
 * 高德 Web 服务调用。Key 只由调用方传入（设置页），不读环境变量。
 * 错误信息里抹掉 Key 和 key= 查询参数。
 * 「绕过代理」开启时直连 restapi.amap.com，不使用环境变量中的 HTTP 代理。
 */
import https from 'node:https'

const ORIGIN = 'https://restapi.amap.com'
export const STATIC_MAP_MAX_BYTES = 25 * 1024 * 1024

const MODE_PATH = {
  driving: '/v5/direction/driving',
  walking: '/v5/direction/walking',
  cycling: '/v5/direction/bicycling',
  transit: '/v5/direction/transit/integrated',
}

const MODE_LABEL = {
  driving: '驾车',
  walking: '步行',
  cycling: '骑行',
  transit: '公交',
}

/** 网页分享链 mode。对照 URI API《路径规划》（2025-03-03）。 */
const MODE_WEB = {
  driving: 'car',
  transit: 'bus',
  walking: 'walk',
  cycling: 'ride',
}

/** 导航深链 t。0 驾车，1 公交，2 步行，3 骑行。 */
const MODE_T = {
  driving: '0',
  transit: '1',
  walking: '2',
  cycling: '3',
}

const SHARE_SRC = 'dsh-workbench'
const MAX_WAYPOINTS = 16

export class AmapError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AmapError'
  }
}

/** 抹掉明文 Key 以及 URL 里的 key 参数。 */
export function redactKey(text, key) {
  let out = String(text ?? '')
  if (key) out = out.split(String(key)).join('***')
  return out.replace(/([?&]key=)[^&\s"'<>]*/gi, '$1***')
}

export function buildAmapUrl(path, params, key) {
  const url = new URL(path, ORIGIN)
  for (const [name, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(name, String(value))
  }
  url.searchParams.set('key', String(key ?? ''))
  return url
}

function fail(key, message) {
  throw new AmapError(redactKey(message, key))
}

function errorText(error) {
  const code = error?.cause?.code || error?.code
  const message = error?.cause?.message || error?.message || String(error)
  if (code && !String(message).includes(code)) return message + '（' + code + '）'
  return String(message)
}

/**
 * 选择高德请求所用的 fetch。
 * 显式传入 fetchImpl 时优先使用。bypassProxy 不为 false 时直连，否则沿用全局 fetch（含系统代理）。
 */
export function resolveAmapFetch(bypassProxy, fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl
  return bypassProxy === false ? globalThis.fetch : amapFetch
}

/** 独立连接，不使用 https.globalAgent，因此不会继承进程上替换过的代理 Agent。 */
const directHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 })

/** 直连选项。不读取下载代理、HTTPS_PROXY，也不把请求交给全局 fetch。 */
export function directRequestOptions(url, init) {
  const target = url instanceof URL ? url : new URL(url)
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: String(init?.method || 'GET').toUpperCase(),
    headers: init?.headers,
    servername: target.hostname,
    timeout: 20000,
    agent: directHttpsAgent,
  }
}

/** 直连高德。请求中不包含任何代理地址。 */
export function amapFetch(url, init) {
  return new Promise((resolve, reject) => {
    const req = https.request(directRequestOptions(url, init), (res) => {
      const chunks = []
      res.on('error', reject)
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          status: res.statusCode,
          async arrayBuffer() { return body },
          async text() { return body.toString('utf8') },
        })
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('高德请求超时'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (init?.body) req.write(init.body)
    req.end()
  })
}

async function readBody(res) {
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer())
  if (typeof res.text === 'function') return Buffer.from(await res.text())
  throw new AmapError('高德响应无法读取')
}

export async function amapJson(path, params, key, fetchImpl = amapFetch) {
  const url = buildAmapUrl(path, params, key)
  let res
  try {
    res = await fetchImpl(url)
  } catch (error) {
    fail(key, '高德请求失败：' + errorText(error))
  }
  let json
  try {
    json = JSON.parse((await readBody(res)).toString('utf8'))
  } catch {
    fail(key, '高德返回的不是 JSON')
  }
  if (String(json?.status) !== '1') {
    fail(key, '高德返回错误 ' + (json?.infocode || '') + ' ' + (json?.info || 'unknown'))
  }
  return json
}

export function isPng(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
}

export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export async function fetchStaticMap(params, key, fetchImpl = amapFetch) {
  const url = buildAmapUrl('/v3/staticmap', params, key)
  let res
  try {
    res = await fetchImpl(url)
  } catch (error) {
    fail(key, '静态地图请求失败：' + errorText(error))
  }
  const buf = await readBody(res)
  if (!isPng(buf)) {
    let info = '静态地图没有返回 PNG'
    try {
      const json = JSON.parse(buf.toString('utf8'))
      info = (json.info || info) + (json.infocode ? ' (' + json.infocode + ')' : '')
    } catch { /* 非 JSON 错误页 */ }
    fail(key, info)
  }
  if (buf.length > STATIC_MAP_MAX_BYTES) fail(key, '静态地图超过 25MB')
  return buf
}

function text(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item).join('')
  if (value == null) return ''
  return String(value)
}

export async function geocode({ address, city }, key, fetchImpl) {
  const json = await amapJson('/v3/geocode/geo', { address, city }, key, fetchImpl)
  const hit = Array.isArray(json.geocodes) ? json.geocodes[0] : null
  if (!hit?.location) fail(key, '没有解析到坐标')
  return {
    formattedAddress: text(hit.formatted_address),
    province: text(hit.province),
    city: text(hit.city) || text(hit.province),
    district: text(hit.district),
    adcode: text(hit.adcode),
    location: text(hit.location),
  }
}

function placeRow(poi) {
  return {
    name: text(poi?.name),
    address: text(poi?.address),
    location: text(poi?.location),
    distance: text(poi?.distance),
    id: text(poi?.id),
  }
}

export async function searchPlaces(args, key, fetchImpl) {
  const pageSize = 5
  const json = args.location
    ? await amapJson('/v5/place/around', {
      location: args.location,
      radius: args.radius || 2000,
      keywords: args.keywords,
      types: args.types,
      page_size: pageSize,
    }, key, fetchImpl)
    : await amapJson('/v5/place/text', {
      keywords: args.keywords,
      types: args.types,
      region: args.city,
      city_limit: args.city ? 'true' : undefined,
      page_size: pageSize,
    }, key, fetchImpl)
  const pois = Array.isArray(json.pois) ? json.pois : []
  return pois.slice(0, pageSize).map(placeRow)
}

export async function placeDetail(id, key, fetchImpl) {
  const json = await amapJson('/v5/place/detail', { id, show_fields: 'business' }, key, fetchImpl)
  const poi = (Array.isArray(json.pois) ? json.pois[0] : null) || {}
  return {
    id: text(poi.id) || id,
    name: text(poi.name),
    address: text(poi.address),
    location: text(poi.location),
    tel: text(poi.business?.tel) || text(poi.tel),
    type: text(poi.type),
  }
}

function metersText(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return String(raw ?? '')
  if (n >= 1000) return (n / 1000).toFixed(1) + ' 公里'
  return Math.round(n) + ' 米'
}

function secondsText(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ''
  const min = Math.max(1, Math.round(n / 60))
  if (min < 60) return min + ' 分钟'
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest ? hour + ' 小时 ' + rest + ' 分钟' : hour + ' 小时'
}

function positiveText(value) {
  if (value == null) return ''
  const text = String(value).trim()
  const n = Number(text)
  if (!text || !Number.isFinite(n) || n <= 0) return ''
  return text
}

function stepDuration(item) {
  const steps = Array.isArray(item?.steps) ? item.steps : []
  let total = 0
  for (const step of steps) {
    const n = Number(step?.cost?.duration ?? step?.duration)
    if (Number.isFinite(n) && n > 0) total += n
  }
  return total > 0 ? String(Math.round(total)) : ''
}

export function summarizeRoute(mode, json) {
  const route = json?.route
  const item = Array.isArray(route?.paths)
    ? route.paths[0]
    : (Array.isArray(route?.transits) ? route.transits[0] : null)
  if (!item) throw new AmapError('没有路线')
  const distance = item.distance != null ? String(item.distance) : ''
  const duration = positiveText(item.cost?.duration)
    || positiveText(item.duration)
    || stepDuration(item)
  const tolls = item.cost?.tolls != null
    ? String(item.cost.tolls)
    : (item.tolls != null ? String(item.tolls) : '')
  const label = MODE_LABEL[mode] || mode
  const time = secondsText(duration)
  let summary = label + ' ' + metersText(distance) + (time ? '，约 ' + time : '')
  if (tolls) summary += '，过路费 ' + tolls + ' 元'
  return {
    mode,
    distance,
    duration,
    ...(tolls ? { tolls } : {}),
    summary,
  }
}

/** 解析「经度,纬度」或「经度,纬度,名称」。坐标视为 GCJ-02。 */
export function parseRoutePoint(raw, label) {
  const text = String(raw ?? '').trim()
  const matched = text.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(.*))?$/)
  if (!matched) throw new AmapError(`${label}须为「经度,纬度」或「经度,纬度,名称」`)
  const lon = Number(matched[1])
  const lat = Number(matched[2])
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AmapError(`${label}坐标超出范围`)
  return {
    lon: matched[1],
    lat: matched[2],
    name: String(matched[3] || '').replace(/[,|]/g, ' ').trim(),
  }
}

export function parseWaypoints(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const parts = text.split(';').map((part) => part.trim()).filter(Boolean)
  if (parts.length > MAX_WAYPOINTS) throw new AmapError(`途经点最多 ${MAX_WAYPOINTS} 个`)
  return parts.map((part, index) => parseRoutePoint(part, `第 ${index + 1} 个途经点`))
}

function namedPoint(location, name) {
  const point = parseRoutePoint(location, '坐标')
  const extra = String(name || '').replace(/[,|]/g, ' ').trim()
  if (extra) point.name = extra
  return point
}

function webPoint(point) {
  return point.lon + ',' + point.lat + (point.name ? ',' + encodeURIComponent(point.name) : '')
}

function shareQuery(pairs) {
  return pairs
    .filter(([name, value]) => value != null && (value !== '' || name === 'vianames'))
    .map(([name, value]) => encodeURIComponent(name) + '=' + encodeURIComponent(String(value)).replace(/%7C/gi, '|'))
    .join('&')
}

/**
 * 网页分享链与导航深链。
 * 网页：https://uri.amap.com/navigation ，via 仅驾车且只保留一个途经点。
 * 深链：amapuri://route/plan/ ，dev=0 表示坐标已是 GCJ-02；途经点用 vian、vialons、vialats、vianames，数量一致。
 * 两条链接都不含 Web 服务 Key，也不写入账号收藏夹。
 */
export function buildRouteShare(input) {
  const mode = MODE_WEB[input.mode] ? input.mode : ''
  if (!mode) throw new AmapError('不支持的出行方式')
  const origin = namedPoint(input.origin, input.originName)
  const destination = namedPoint(input.destination, input.destinationName)
  const vias = Array.isArray(input.waypoints) ? input.waypoints : []
  const web = [
    'from=' + webPoint(origin),
    'to=' + webPoint(destination),
  ]
  let limitNote = ''
  if (mode === 'driving' && vias.length === 1) {
    web.push('via=' + webPoint(vias[0]))
  } else if (mode === 'driving' && vias.length > 1) {
    web.push('via=' + webPoint(vias[0]))
    limitNote = '网页分享链接仅包含第一个途经点；导航深链包含全部途经点。'
  } else if (vias.length) {
    limitNote = '网页分享链接不含途经点（官方网页接口的途经点仅支持驾车）；导航深链包含全部途经点。'
  }
  web.push('mode=' + MODE_WEB[mode], 'src=' + SHARE_SRC, 'callnative=1')
  const deep = [
    ['sourceApplication', SHARE_SRC],
    ['slat', origin.lat],
    ['slon', origin.lon],
    ['sname', origin.name],
    ['dlat', destination.lat],
    ['dlon', destination.lon],
    ['dname', destination.name],
    ['dev', '0'],
    ['t', MODE_T[mode]],
  ]
  if (vias.length) {
    deep.push(['vian', String(vias.length)])
    deep.push(['vialons', vias.map((point) => point.lon).join('|')])
    deep.push(['vialats', vias.map((point) => point.lat).join('|')])
    deep.push(['vianames', vias.map((point) => point.name).join('|')])
  }
  return {
    share: 'https://uri.amap.com/navigation?' + web.join('&'),
    deepLink: 'amapuri://route/plan/?' + shareQuery(deep),
    handoff: '页面会显示可点击的路线图，点开后进入高德导航。请把 share 通过 Telegram 发给手机，或复制到系统浏览器打开。share 适用于 iOS 与 Android。deepLink 为 amapuri 协议，供 Android 与 HarmonyOS 直接打开导航。在微信、QQ 等应用内打开分享链接时，可能无法调起高德地图。上述链接均不写入高德账号收藏夹。' + limitNote,
  }
}

/**
 * 标点页。coordinate=gaode 表示 position 已是 GCJ-02。不含 Web 服务 Key。
 * https://uri.amap.com/marker?position=经度,纬度&name=&src=&coordinate=gaode&callnative=1
 */
export function buildMarkerLink(location, name) {
  const point = parseRoutePoint(location, '坐标')
  const label = String(name || point.name || '').replace(/[,|]/g, ' ').trim()
  const parts = ['position=' + point.lon + ',' + point.lat]
  if (label) parts.push('name=' + encodeURIComponent(label))
  parts.push('src=' + SHARE_SRC, 'coordinate=gaode', 'callnative=1')
  return 'https://uri.amap.com/marker?' + parts.join('&')
}

export async function route(args, key, fetchImpl) {
  const path = MODE_PATH[args.mode]
  if (!path) fail(key, '不支持的出行方式')
  const waypoints = Array.isArray(args.waypoints) ? args.waypoints : []
  const params = { origin: args.origin, destination: args.destination, show_fields: 'cost' }
  if (args.mode === 'driving' && waypoints.length) {
    params.waypoints = waypoints.map((point) => point.lon + ',' + point.lat).join(';')
  }
  if (args.mode === 'transit') {
    if (!args.city) fail(key, '公交路线需要城市名或 adcode')
    params.city1 = args.city
    params.city2 = args.city
  }
  const json = await amapJson(path, params, key, fetchImpl)
  return {
    ...summarizeRoute(args.mode, json),
    ...buildRouteShare({
      mode: args.mode,
      origin: args.origin,
      destination: args.destination,
      originName: args.originName,
      destinationName: args.destinationName,
      waypoints,
    }),
    points: collectRoutePoints(json),
  }
}

function pushPolyline(points, raw) {
  const text = String(raw || '').trim()
  if (!text) return
  for (const part of text.split(';')) {
    const bit = part.trim()
    if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(bit)) continue
    if (points[points.length - 1] !== bit) points.push(bit)
  }
}

/** 从路径规划结果里取出折线点，供静态路线图使用。不放进给模型的摘要。 */
export function collectRoutePoints(json) {
  const points = []
  const route = json?.route
  const path = Array.isArray(route?.paths) ? route.paths[0] : null
  if (path) {
    if (Array.isArray(path.steps)) {
      for (const step of path.steps) pushPolyline(points, step?.polyline)
    }
    if (!points.length) pushPolyline(points, path.polyline)
  }
  const transit = Array.isArray(route?.transits) ? route.transits[0] : null
  if (transit && Array.isArray(transit.segments)) {
    for (const segment of transit.segments) {
      const walking = segment?.walking
      if (walking && Array.isArray(walking.steps)) {
        for (const step of walking.steps) pushPolyline(points, step?.polyline)
      }
      const lines = segment?.bus?.buslines
      if (Array.isArray(lines)) {
        for (const line of lines) pushPolyline(points, line?.polyline)
      }
    }
  }
  return points
}

export function simplifyPoints(points, max = 80) {
  const list = Array.isArray(points) ? points.filter(Boolean) : []
  if (list.length <= max) return list
  const out = []
  const last = list.length - 1
  for (let i = 0; i < max; i++) {
    const point = list[Math.round(i * last / (max - 1))]
    if (out[out.length - 1] !== point) out.push(point)
  }
  if (out[out.length - 1] !== list[last]) out.push(list[last])
  return out
}

/** 静态路线图：折线自动取景，起终点用标记。不含 Key。 */
export function staticRouteParams(origin, destination, points) {
  const line = simplifyPoints(points && points.length >= 2 ? points : [origin, destination])
  const params = {
    size: '750*400',
    scale: 2,
    markers: 'mid,0x00A000,A:' + origin + '|mid,0xE00000,B:' + destination,
  }
  if (line.length >= 2) params.paths = '5,0x2F6BFF,1,,:' + line.join(';')
  return params
}

export async function weather(args, key, fetchImpl) {
  const json = await amapJson('/v3/weather/weatherInfo', { city: args.city, extensions: 'all' }, key, fetchImpl)
  const block = Array.isArray(json.forecasts) ? json.forecasts[0] : null
  const casts = Array.isArray(block?.casts) ? block.casts : []
  return {
    city: text(block?.city) || args.city,
    forecasts: casts.slice(0, 4).map((cast) => ({
      date: text(cast.date),
      week: text(cast.week),
      dayWeather: text(cast.dayweather),
      nightWeather: text(cast.nightweather),
      dayTemp: text(cast.daytemp),
      nightTemp: text(cast.nighttemp),
    })),
  }
}

export function staticMapParams(location, zoom) {
  return {
    location,
    zoom,
    size: '750*400',
    scale: 2,
    markers: 'mid,0xFF0000,A:' + location,
  }
}
