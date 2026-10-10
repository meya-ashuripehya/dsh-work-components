/**
 * 地图工具。坐标为 GCJ-02。Key 不进参数、不进返回值。
 * map_card 与路线图把图片字节交给 attachments.saveImage，不写盘。
 * 路线分享链接与导航深链只用于在手机打开导航，不写入高德账号收藏夹。
 */
import { defineTool } from '../../vendor/dsh-tools/schema.js'
import {
  AmapError,
  buildMarkerLink,
  fetchStaticMap,
  resolveAmapFetch,
  geocode,
  parseWaypoints,
  placeDetail,
  pngSize,
  route,
  searchPlaces,
  staticMapParams,
  staticRouteParams,
  weather,
} from './amap.mjs'
import { gcj02ToWgs84 } from './wgs.mjs'

const COORD = '坐标为 GCJ-02（经度,纬度）。'

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

function textBlock(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function imageRef(image, name) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(name ? { name } : {}),
  }
}

/** 路线图。source.url 打开高德导航页。不带 place，避免 Telegram 把它当成一个标点。 */
function mmRouteBlock(value) {
  const block = {
    type: 'mm',
    kind: 'route',
    status: 'ready',
    title: value.summary || '路线',
    source: { url: value.share },
  }
  if (value.image) block.asset = { attachment: imageRef(value.image, '路线') }
  return block
}

/** 地图标点。预览图仍在 asset 里；source.url 打开高德标点页。place 里的 wgs* 供 Telegram sendVenue。 */
function mmPlaceBlock(image, opts) {
  const wgs = gcj02ToWgs84(opts.lon, opts.lat)
  return {
    type: 'mm',
    kind: 'place',
    status: 'ready',
    title: opts.title,
    ...(opts.caption ? { caption: opts.caption } : {}),
    source: { url: opts.url },
    place: {
      longitude: Number(opts.lon),
      latitude: Number(opts.lat),
      wgsLongitude: wgs.lon,
      wgsLatitude: wgs.lat,
      title: opts.title,
      address: opts.address || opts.title,
    },
    asset: { attachment: imageRef(image, opts.title || image.name) },
  }
}

function asText(value) {
  return String(value ?? '').trim()
}

function requireCoord(value, label) {
  const text = asText(value)
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(text)) {
    throw new AmapError(label + '须为 GCJ-02 坐标，格式经度,纬度')
  }
  return text
}

/**
 * @param {{ apiKey: string, bypassProxy?: boolean, fetchImpl?: typeof fetch, getAttachments?: () => { saveImage: Function } }} options
 */
export function createMapTools(options) {
  const key = options.apiKey
  const fetchImpl = resolveAmapFetch(options.bypassProxy, options.fetchImpl)
  const getAttachments = options.getAttachments

  const geo = defineTool({
    name: 'geo_resolve',
    description: '把地址解析为 GCJ-02 坐标。必须带城市，避免同名地点配错城市。只返回格式化地址、行政区划和坐标。消耗高德基础 LBS 配额。',
    parameters: {
      address: { type: 'string', required: true, description: '街道地址或地名。' },
      city: { type: 'string', required: true, description: '城市名或城市 adcode，用于限定解析范围。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          formattedAddress: { type: 'string', required: true },
          province: { type: 'string', required: true },
          city: { type: 'string', required: true },
          district: { type: 'string', required: true },
          adcode: { type: 'string', required: true },
          location: { type: 'string', required: true, description: COORD },
        },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return geocode({ address: asText(args.address), city: asText(args.city) }, key, fetchImpl)
    },
  })

  const search = defineTool({
    name: 'place_search',
    description: '搜索地点。有坐标时按周边搜，否则按关键词搜。最多返回 5 条：名称、地址、坐标、距离、POI ID。消耗高德基础搜索配额。' + COORD,
    parameters: {
      keywords: { type: 'string', description: '关键词。无坐标时必填；周边搜索时可和 types 二选一。' },
      location: { type: 'string', description: '周边搜索中心，GCJ-02 经度,纬度。' },
      radius: { type: 'string', description: '周边半径（米）。默认 2000。' },
      types: { type: 'string', description: 'POI 类型编码，多个用 | 分隔。' },
      city: { type: 'string', description: '关键词搜索时限定城市。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          places: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                address: { type: 'string', required: true },
                location: { type: 'string', required: true },
                distance: { type: 'string', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const keywords = asText(args.keywords)
      const location = asText(args.location)
      const types = asText(args.types)
      if (!location && !keywords) throw new AmapError('关键词搜索需要 keywords')
      if (location && !keywords && !types) throw new AmapError('周边搜索需要 keywords 或 types')
      const places = await searchPlaces({
        keywords,
        location: location ? requireCoord(location, 'location') : '',
        radius: asText(args.radius),
        types,
        city: asText(args.city),
      }, key, fetchImpl)
      return { places }
    },
  })

  const detail = defineTool({
    name: 'place_detail',
    description: '按 POI ID 补地点详情（电话、类型）。只在 place_search 的结果不够时调用。消耗高德基础搜索配额。',
    parameters: {
      id: { type: 'string', required: true, description: 'place_search 返回的 POI ID。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          address: { type: 'string', required: true },
          location: { type: 'string', required: true },
          tel: { type: 'string', required: true },
          type: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return placeDetail(asText(args.id), key, fetchImpl)
    },
  })

  const routeTool = defineTool({
    name: 'route',
    description: '规划一种出行路线（driving、walking、cycling、transit 四选一），返回距离、耗时、过路费、摘要，并在页面上发出可点击的路线图。路线图打开 https://uri.amap.com/navigation 分享链接，适用于 iOS 与 Android。请把 share 通过 Telegram 发给手机，或复制到系统浏览器打开。deepLink（amapuri）供 Android 与 HarmonyOS 直接打开。不要生成二维码，不要为了比较而自动把四种方式都调一遍，也不要写入高德账号收藏夹。网页分享链接的途经点仅支持驾车且只含第一个，全部途经点在 deepLink 中。消耗高德路径规划配额；路线图另消耗一次静态地图配额。' + COORD,
    parameters: {
      mode: { type: 'string', required: true, description: 'driving、walking、cycling 或 transit。' },
      origin: { type: 'string', required: true, description: '起点，GCJ-02 经度,纬度。' },
      destination: { type: 'string', required: true, description: '终点，GCJ-02 经度,纬度。' },
      originName: { type: 'string', description: '起点名称，写入分享链接与深链，便于手机端显示。' },
      destinationName: { type: 'string', description: '终点名称，写入分享链接与深链，便于手机端显示。' },
      waypoints: { type: 'string', description: '途经点，GCJ-02。多个点用英文分号分隔，每点为「经度,纬度」或「经度,纬度,名称」，最多 16 个。仅驾车路线会把途经点提交给路径规划接口。' },
      city: { type: 'string', description: '公交（transit）必填：城市名或 adcode。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          distance: { type: 'string', required: true },
          duration: { type: 'string', required: true },
          tolls: { type: 'string' },
          summary: { type: 'string', required: true },
          share: { type: 'string', required: true, description: 'https://uri.amap.com/navigation 分享链接，不含 Key。' },
          deepLink: { type: 'string', required: true, description: 'amapuri://route/plan/ 导航深链，不含 Key。' },
          handoff: { type: 'string', required: true, description: '发至手机的方式说明。' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: IMAGE_SCHEMA.properties,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.summary,
          '页面上的路线图可直接点开，进入高德导航。',
          '分享链接：' + value.share,
          'Android / HarmonyOS 深链：' + value.deepLink,
          value.handoff,
        ].filter(Boolean).join('\n'),
      }],
      presentationMeta: (_args, value) => ({
        title: value.summary,
        url: value.share,
        mm: mmRouteBlock(value),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const origin = requireCoord(args.origin, 'origin')
      const destination = requireCoord(args.destination, 'destination')
      const planned = await route({
        mode: asText(args.mode),
        origin,
        destination,
        originName: asText(args.originName),
        destinationName: asText(args.destinationName),
        waypoints: parseWaypoints(args.waypoints),
        city: asText(args.city),
      }, key, fetchImpl)
      const points = Array.isArray(planned.points) ? planned.points : []
      const value = { ...planned }
      delete value.points
      const attachments = getAttachments?.()
      if (attachments?.saveImage) {
        try {
          const png = await fetchStaticMap(
            staticRouteParams(origin, destination, points),
            key,
            fetchImpl,
          )
          const size = pngSize(png)
          const ref = await attachments.saveImage({
            data: png,
            mediaType: 'image/png',
            name: 'route.png',
          })
          value.image = {
            attachmentId: String(ref.attachmentId),
            mediaType: 'image/png',
            bytes: Number(ref.bytes ?? png.length),
            width: Number(ref.width ?? size.width) || size.width,
            height: Number(ref.height ?? size.height) || size.height,
            name: 'route.png',
          }
        } catch {
          // 规划结果和分享链接仍然返回。静态图失败时，卡片只保留可点击的导航链接。
        }
      }
      return value
    },
  })

  const weatherTool = defineTool({
    name: 'weather',
    description: '查询城市未来几天的天气预报摘要。消耗高德天气预报配额。',
    parameters: {
      city: { type: 'string', required: true, description: '城市名或 adcode。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          city: { type: 'string', required: true },
          forecasts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                date: { type: 'string', required: true },
                week: { type: 'string', required: true },
                dayWeather: { type: 'string', required: true },
                nightWeather: { type: 'string', required: true },
                dayTemp: { type: 'string', required: true },
                nightTemp: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return weather({ city: asText(args.city) }, key, fetchImpl)
    },
  })

  const card = defineTool({
    name: 'map_card',
    description: '生成地图标点卡片。页面上是可打开高德地图的卡片；发到 Telegram 时改为原生命置，不发送静态地图图片。传入地址（须带城市）或已有 GCJ-02 坐标。每次出卡都重新请求静态地图作为页面预览，不要复用上一张图。消耗高德基础 LBS 配额；若先解析地址，地理编码再计一次。' + COORD,
    parameters: {
      address: { type: 'string', description: '要标注的地址。与 location 二选一；用地址时必须同时给 city。' },
      city: { type: 'string', description: '地址所在城市。用 address 时必填。' },
      location: { type: 'string', description: '已有坐标，GCJ-02 经度,纬度。有则不再地理编码。' },
      title: { type: 'string', description: '卡片标题。默认用解析出的地址或坐标。' },
      caption: { type: 'string', description: '卡片说明。' },
      zoom: { type: 'integer', description: '缩放 1–17，默认 16（门址）。城区可改小。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          caption: { type: 'string' },
          location: { type: 'string', required: true },
          formattedAddress: { type: 'string', required: true },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const title = value.title || value.location
        const dims = value.image.mediaType + ', ' + value.image.width + 'x' + value.image.height + ' px, ' + value.image.bytes + ' bytes.'
        return [
          { type: 'text', text: '地图卡片「' + title + '」' + value.location + '。' + dims },
          { type: 'image', attachment: imageRef(value.image, title) },
        ]
      },
      presentationMeta: (_args, value) => {
        const title = value.title || value.location
        const caption = value.caption
          || (value.formattedAddress ? value.formattedAddress + ' · ' + value.location : value.location)
        const [lon, lat] = String(value.location).split(',')
        return {
          title,
          location: value.location,
          ...(value.caption ? { caption: value.caption } : {}),
          mm: mmPlaceBlock(value.image, {
            title,
            caption,
            lon,
            lat,
            url: buildMarkerLink(value.location, title),
            address: value.formattedAddress || value.caption || title,
          }),
        }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      let location = asText(args.location)
      let formattedAddress = ''
      if (location) {
        location = requireCoord(location, 'location')
      } else {
        const address = asText(args.address)
        const city = asText(args.city)
        if (!address) throw new AmapError('需要 address 或 location')
        if (!city) throw new AmapError('用地址出卡时需要城市')
        const hit = await geocode({ address, city }, key, fetchImpl)
        location = hit.location
        formattedAddress = hit.formattedAddress
      }
      let zoom = Number(args.zoom ?? 16)
      if (!Number.isInteger(zoom) || zoom < 1 || zoom > 17) throw new AmapError('zoom 须为 1 到 17 的整数')
      const png = await fetchStaticMap(staticMapParams(location, zoom), key, fetchImpl)
      const size = pngSize(png)
      const attachments = getAttachments?.()
      if (!attachments?.saveImage) throw new AmapError('宿主没有附件服务，无法发出地图卡片')
      const ref = await attachments.saveImage({
        data: png,
        mediaType: 'image/png',
        name: 'map.png',
      })
      const title = asText(args.title) || formattedAddress || location
      const caption = asText(args.caption)
      return {
        title,
        ...(caption ? { caption } : {}),
        location,
        formattedAddress,
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: 'image/png',
          bytes: Number(ref.bytes ?? png.length),
          width: Number(ref.width ?? size.width) || size.width,
          height: Number(ref.height ?? size.height) || size.height,
          name: 'map.png',
        },
      }
    },
  })

  return [geo, search, detail, routeTool, weatherTool, card]
}
