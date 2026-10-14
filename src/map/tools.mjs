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

const COORD = 'Coordinates are GCJ-02 (longitude,latitude).'

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
    description: 'Geocode an address to GCJ-02 coordinates. A city is required so same-named places are not matched in the wrong city. Returns only the formatted address, administrative divisions, and coordinates. Consumes AMap basic LBS quota.',
    parameters: {
      address: { type: 'string', required: true, description: 'Street address or place name.' },
      city: { type: 'string', required: true, description: 'City name or city adcode, used to scope the lookup.' },
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
    description: 'Search for places. Does a nearby search when a location is given, otherwise a keyword search. Returns at most 5 results: name, address, coordinates, distance, POI ID. Consumes AMap basic search quota. ' + COORD,
    parameters: {
      keywords: { type: 'string', description: 'Keywords. Required when no location is given; for nearby search, provide keywords or types (either is enough).' },
      location: { type: 'string', description: 'Nearby-search center, GCJ-02 longitude,latitude.' },
      radius: { type: 'string', description: 'Nearby-search radius in meters. Default 2000.' },
      types: { type: 'string', description: 'POI type codes; separate multiple with |.' },
      city: { type: 'string', description: 'City to restrict a keyword search to.' },
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
    description: 'Fetch extra place details (phone, type) by POI ID. Call only when place_search results are insufficient. Consumes AMap basic search quota.',
    parameters: {
      id: { type: 'string', required: true, description: 'POI ID returned by place_search.' },
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
    description: 'Plan a route for one travel mode (one of driving, walking, cycling, transit). Returns distance, duration, tolls, and a summary, and posts a clickable route map on the page. The route map opens the https://uri.amap.com/navigation share link, which works on iOS and Android. Send share to the phone via Telegram, or copy it into a system browser. deepLink (amapuri) opens directly on Android and HarmonyOS. Do not generate QR codes, do not automatically call all four modes just to compare, and do not write to the AMap account\'s favorites. In the web share link, waypoints are supported only for driving and only the first one is included; all waypoints are in deepLink. Consumes AMap route-planning quota; the route map uses one additional static-map quota call. ' + COORD,
    parameters: {
      mode: { type: 'string', required: true, description: 'driving, walking, cycling, or transit.' },
      origin: { type: 'string', required: true, description: 'Origin, GCJ-02 longitude,latitude.' },
      destination: { type: 'string', required: true, description: 'Destination, GCJ-02 longitude,latitude.' },
      originName: { type: 'string', description: 'Origin name, included in the share link and deep link for display on the phone.' },
      destinationName: { type: 'string', description: 'Destination name, included in the share link and deep link for display on the phone.' },
      waypoints: { type: 'string', description: 'Waypoints, GCJ-02. Separate multiple points with ASCII semicolons; each point is "lon,lat" or "lon,lat,name"; at most 16. Waypoints are sent to the route-planning API only for driving.' },
      city: { type: 'string', description: 'Required for transit: city name or adcode.' },
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
          share: { type: 'string', required: true, description: 'https://uri.amap.com/navigation share link, without the API key.' },
          deepLink: { type: 'string', required: true, description: 'amapuri://route/plan/ navigation deep link, without the API key.' },
          handoff: { type: 'string', required: true, description: 'Instructions for sending to a phone.' },
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
            // 宿主可能转码，读取时核对 mediaType，须用它返回的值。
            mediaType: String(ref.mediaType || 'image/png'),
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
    description: 'Get a weather forecast summary for a city for the next few days. Consumes AMap weather-forecast quota.',
    parameters: {
      city: { type: 'string', required: true, description: 'City name or adcode.' },
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
    description: 'Create a map pin card. On the page it is a card that opens AMap; when sent to Telegram it becomes a native location (venue) instead of a static map image. Pass an address (with a city) or existing GCJ-02 coordinates. Every card fetches a fresh static map as the page preview; do not reuse a previous image. Consumes AMap basic LBS quota; if an address is geocoded first, that counts as one more call. ' + COORD,
    parameters: {
      address: { type: 'string', description: 'Address to pin. Use either this or location; when using an address, city is also required.' },
      city: { type: 'string', description: 'City of the address. Required when address is used.' },
      location: { type: 'string', description: 'Existing coordinates, GCJ-02 longitude,latitude. If given, no geocoding is done.' },
      title: { type: 'string', description: 'Card title. Defaults to the resolved address or the coordinates.' },
      caption: { type: 'string', description: 'Card caption.' },
      zoom: { type: 'integer', description: 'Zoom level 1–17, default 16 (street-address level). Use a smaller value for a district/city-area view.' },
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
