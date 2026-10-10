import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import {
  AmapError,
  amapFetch,
  buildAmapUrl,
  buildMarkerLink,
  buildRouteShare,
  directRequestOptions,
  geocode,
  redactKey,
  resolveAmapFetch,
  route,
  searchPlaces,
  staticMapParams,
  staticRouteParams,
  summarizeRoute,
} from './amap.mjs'
import { createMapTools } from './tools.mjs'
import { createMapFeature } from './index.mjs'
import { gcj02ToWgs84 } from './wgs.mjs'

const KEY = 'test-key-do-not-leak-0123456789abcd'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function jsonResponse(body) {
  return {
    async arrayBuffer() { return Buffer.from(JSON.stringify(body)) },
  }
}

function pngResponse() {
  return {
    async arrayBuffer() { return PNG },
  }
}

test('geocode keeps address, admin area, and coordinate', async () => {
  const hit = await geocode({ address: '阜通东大街6号', city: '北京' }, KEY, async (url) => {
    assert.equal(url.searchParams.get('address'), '阜通东大街6号')
    assert.equal(url.searchParams.get('city'), '北京')
    return jsonResponse({
      status: '1',
      geocodes: [{
        formatted_address: '北京市朝阳区阜通东大街6号',
        province: '北京市',
        city: [],
        district: '朝阳区',
        adcode: '110105',
        location: '116.482086,39.990496',
        level: '门址',
      }],
    })
  })
  assert.deepEqual(hit, {
    formattedAddress: '北京市朝阳区阜通东大街6号',
    province: '北京市',
    city: '北京市',
    district: '朝阳区',
    adcode: '110105',
    location: '116.482086,39.990496',
  })
})

test('place search returns at most five summary rows', async () => {
  const pois = Array.from({ length: 6 }, (_, i) => ({
    name: '店' + i,
    address: '路' + i,
    location: '116.1,39.' + i,
    distance: String(i * 10),
    id: 'B' + i,
    tel: 'should-drop',
  }))
  const places = await searchPlaces({ keywords: '咖啡', city: '北京' }, KEY, async () => jsonResponse({
    status: '1',
    pois,
  }))
  assert.equal(places.length, 5)
  assert.deepEqual(Object.keys(places[0]).sort(), ['address', 'distance', 'id', 'location', 'name'])
  assert.equal(places[0].tel, undefined)
})

test('route summary drops polyline and steps', () => {
  const summary = summarizeRoute('driving', {
    route: {
      paths: [{
        distance: '2500',
        cost: { duration: '600', tolls: '5' },
        steps: [{ instruction: '直行', polyline: '1,2;3,4' }],
        polyline: '9,9;8,8',
      }],
    },
  })
  assert.deepEqual(summary, {
    mode: 'driving',
    distance: '2500',
    duration: '600',
    tolls: '5',
    summary: '驾车 2.5 公里，约 10 分钟，过路费 5 元',
  })
  assert.equal(JSON.stringify(summary).includes('polyline'), false)
  assert.equal(JSON.stringify(summary).includes('steps'), false)

  const bare = summarizeRoute('driving', {
    route: { paths: [{ distance: '17900', steps: [{ polyline: '1,2;3,4' }] }] },
  })
  assert.equal(bare.duration, '')
  assert.equal(bare.summary, '驾车 17.9 公里')

  const fromSteps = summarizeRoute('walking', {
    route: {
      paths: [{
        distance: '800',
        steps: [{ cost: { duration: '200' } }, { cost: { duration: '400' } }],
      }],
    },
  })
  assert.equal(fromSteps.duration, '600')
  assert.equal(fromSteps.summary, '步行 800 米，约 10 分钟')
})

test('route tool calls one mode and returns the summary', async () => {
  const paths = []
  const tool = createMapTools({
    apiKey: KEY,
    fetchImpl: async (url) => {
      paths.push(url.pathname)
      assert.equal(url.searchParams.get('show_fields'), 'cost')
      return jsonResponse({
        status: '1',
        route: { paths: [{ distance: '800', cost: { duration: '600' }, steps: [{ polyline: '1,2' }] }] },
      })
    },
  }).find((item) => item.name === 'route')
  const value = await tool.execute({
    mode: 'walking',
    origin: '116.1,39.1',
    destination: '116.2,39.2',
  })
  assert.deepEqual(paths, ['/v5/direction/walking'])
  assert.equal(value.summary, '步行 800 米，约 10 分钟')
  assert.equal(JSON.stringify(value).includes('polyline'), false)
  assert.equal(value.points, undefined)
  assert.equal(value.handoff.includes('二维码'), false)
  const blocks = tool.output.render({}, value)
  assert.deepEqual(blocks.map((block) => block.type), ['text'])
  assert.match(blocks[0].text, /https:\/\/uri\.amap\.com\/navigation/)
  assert.equal(blocks[0].text.includes(KEY), false)
  assert.equal(blocks[0].text.includes('二维码'), false)
  const meta = tool.output.presentationMeta({}, value)
  assert.equal(meta.mm.kind, 'route')
  assert.equal(meta.mm.place, undefined)
  assert.equal(new URL(meta.mm.source.url).pathname, '/navigation')
  assert.equal(meta.mm.source.url.includes(KEY), false)
  const share = new URL(value.share)
  const deep = new URL(value.deepLink)
  assert.equal(share.origin + share.pathname, 'https://uri.amap.com/navigation')
  assert.equal(share.searchParams.get('from'), '116.1,39.1')
  assert.equal(share.searchParams.get('to'), '116.2,39.2')
  assert.equal(share.searchParams.get('mode'), 'walk')
  assert.equal(share.searchParams.get('callnative'), '1')
  assert.equal(share.searchParams.get('via'), null)
  assert.equal(deep.protocol, 'amapuri:')
  assert.equal(deep.hostname, 'route')
  assert.equal(deep.pathname, '/plan/')
  assert.equal(deep.searchParams.get('slat'), '39.1')
  assert.equal(deep.searchParams.get('slon'), '116.1')
  assert.equal(deep.searchParams.get('dlat'), '39.2')
  assert.equal(deep.searchParams.get('dlon'), '116.2')
  assert.equal(deep.searchParams.get('dev'), '0')
  assert.equal(deep.searchParams.get('t'), '2')
  assert.equal(value.share.includes(KEY), false)
  assert.equal(value.deepLink.includes(KEY), false)
  assert.equal(value.share.includes('key='), false)
  assert.equal(value.deepLink.includes('key='), false)
  assert.match(value.handoff, /Telegram/)
  assert.match(value.handoff, /收藏夹/)
})

test('driving share keeps one web via and every deep-link via', async () => {
  let waypoints = ''
  const tool = createMapTools({
    apiKey: KEY,
    fetchImpl: async (url) => {
      assert.equal(url.pathname, '/v5/direction/driving')
      assert.equal(url.searchParams.get('show_fields'), 'cost')
      waypoints = url.searchParams.get('waypoints')
      assert.equal(url.searchParams.get('key'), KEY)
      return jsonResponse({
        status: '1',
        route: { paths: [{ distance: '3000', cost: { duration: '600', tolls: '0' } }] },
      })
    },
  }).find((item) => item.name === 'route')
  const value = await tool.execute({
    mode: 'driving',
    origin: '116.478346,39.997361',
    destination: '116.3246,39.966577',
    originName: '起点',
    destinationName: '终点',
    waypoints: '116.40,39.93,甲;116.50,39.94,乙',
  })
  assert.equal(waypoints, '116.40,39.93;116.50,39.94')
  const share = new URL(value.share)
  assert.equal(share.searchParams.get('from'), '116.478346,39.997361,起点')
  assert.equal(share.searchParams.get('to'), '116.3246,39.966577,终点')
  assert.equal(share.searchParams.get('via'), '116.40,39.93,甲')
  assert.equal(share.searchParams.get('mode'), 'car')
  const deep = new URL(value.deepLink)
  assert.equal(deep.searchParams.get('t'), '0')
  assert.equal(deep.searchParams.get('vian'), '2')
  assert.equal(deep.searchParams.get('vialons'), '116.40|116.50')
  assert.equal(deep.searchParams.get('vialats'), '39.93|39.94')
  assert.equal(deep.searchParams.get('vianames'), '甲|乙')
  assert.equal(deep.searchParams.get('sourceApplication'), 'dsh-workbench')
  assert.equal(value.deepLink.includes('%7C'), false)
  assert.equal(value.share.includes(KEY), false)
  assert.equal(value.deepLink.includes(KEY), false)
  assert.match(value.handoff, /第一个途经点/)
})

test('walking share omits vias that the web uri cannot carry', () => {
  const built = buildRouteShare({
    mode: 'walking',
    origin: '116.1,39.1',
    destination: '116.2,39.2',
    waypoints: [{ lon: '116.15', lat: '39.15', name: '中途' }],
  })
  assert.equal(new URL(built.share).searchParams.get('via'), null)
  assert.equal(new URL(built.deepLink).searchParams.get('vian'), '1')
  assert.equal(built.share.includes('key='), false)
  assert.equal(built.deepLink.includes(KEY), false)
})

test('static map url carries the marker and errors omit the key', async () => {
  const params = staticMapParams('116.482086,39.990496', 16)
  const url = buildAmapUrl('/v3/staticmap', params, KEY)
  assert.equal(url.searchParams.get('markers'), 'mid,0xFF0000,A:116.482086,39.990496')
  assert.equal(url.searchParams.get('zoom'), '16')
  assert.equal(url.searchParams.get('size'), '750*400')
  assert.equal(url.searchParams.get('scale'), '2')
  await assert.rejects(
    () => route({
      mode: 'driving',
      origin: '116.1,39.1',
      destination: '116.2,39.2',
    }, KEY, async () => {
      throw new Error('connect failed ' + buildAmapUrl('/v5/direction/driving', {}, KEY).href)
    }),
    (error) => {
      assert.equal(error instanceof AmapError, true)
      assert.equal(error.message.includes(KEY), false)
      assert.equal(error.message.includes('key=' + KEY), false)
      assert.match(error.message, /key=\*\*\*/)
      return true
    },
  )
  assert.equal(redactKey('key=' + KEY + '&x=1', KEY).includes(KEY), false)
})

test('map_card render is text plus image and the card meta has an attachment', async () => {
  let saved = null
  const tool = createMapTools({
    apiKey: KEY,
    fetchImpl: async (url) => {
      assert.equal(url.pathname, '/v3/staticmap')
      assert.equal(url.searchParams.get('key'), KEY)
      return pngResponse()
    },
    getAttachments: () => ({
      async saveImage(image) {
        saved = image
        return { attachmentId: 'att-map', bytes: image.data.length, width: 1, height: 1, mediaType: 'image/png' }
      },
    }),
  }).find((item) => item.name === 'map_card')

  const value = await tool.execute({ location: '116.482086,39.990496', title: '阜通东大街' })
  assert.equal(saved.mediaType, 'image/png')
  assert.equal(Buffer.isBuffer(saved.data), true)
  assert.equal(value.image.attachmentId, 'att-map')
  const blocks = tool.output.render({}, value)
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'image'])
  assert.equal(blocks.some((block) => block.type === 'mm'), false)
  assert.equal(blocks[1].attachment.attachmentId, 'att-map')
  const meta = tool.output.presentationMeta({}, value)
  assert.equal(meta.mm.type, 'mm')
  assert.equal(meta.mm.kind, 'place')
  assert.equal(meta.mm.status, 'ready')
  assert.equal(meta.mm.asset.attachment.attachmentId, 'att-map')
  assert.equal(meta.title, '阜通东大街')
  const marker = new URL(meta.mm.source.url)
  assert.equal(marker.origin + marker.pathname, 'https://uri.amap.com/marker')
  assert.equal(marker.searchParams.get('position'), '116.482086,39.990496')
  assert.equal(marker.searchParams.get('coordinate'), 'gaode')
  assert.equal(marker.searchParams.get('name'), '阜通东大街')
  assert.equal(meta.mm.source.url.includes(KEY), false)
  assert.equal(meta.mm.source.url.includes('key='), false)
  assert.equal(meta.mm.place.longitude, 116.482086)
  assert.equal(meta.mm.place.latitude, 39.990496)
  assert.notEqual(meta.mm.place.wgsLongitude, meta.mm.place.longitude)
  assert.equal(meta.mm.place.wgsLatitude < 90, true)
})

test('marker link keeps GCJ-02 and omits the key; WGS conversion leaves points outside China unchanged', () => {
  const url = buildMarkerLink('104.066,30.572', '蜜雪冰城（金雁路）')
  const marker = new URL(url)
  assert.equal(marker.searchParams.get('position'), '104.066,30.572')
  assert.equal(marker.searchParams.get('coordinate'), 'gaode')
  assert.equal(marker.searchParams.get('callnative'), '1')
  assert.equal(url.includes(KEY), false)
  const wgs = gcj02ToWgs84(104.066, 30.572)
  assert.equal(Math.abs(wgs.lon - 104.066) > 0.001, true)
  assert.equal(Math.abs(wgs.lon - 104.066) < 0.02, true)
  assert.deepEqual(gcj02ToWgs84(10, 10), { lon: 10, lat: 10 })
})

test('route card draws the polyline and opens the navigation page', async () => {
  const calls = []
  let saved = null
  const tools = createMapTools({
    apiKey: KEY,
    fetchImpl: async (url) => {
      calls.push(url.pathname)
      if (url.pathname === '/v5/direction/driving') {
        assert.equal(url.searchParams.get('key'), KEY)
        return jsonResponse({
          status: '1',
          route: {
            paths: [{
              distance: '2500',
              cost: { duration: '600', tolls: '5' },
              steps: [
                { polyline: '116.1,39.1;116.15,39.15' },
                { polyline: '116.15,39.15;116.2,39.2' },
              ],
            }],
          },
        })
      }
      assert.equal(url.pathname, '/v3/staticmap')
      assert.equal(url.searchParams.get('paths'), '5,0x2F6BFF,1,,:116.1,39.1;116.15,39.15;116.2,39.2')
      assert.equal(url.searchParams.get('markers'), 'mid,0x00A000,A:116.1,39.1|mid,0xE00000,B:116.2,39.2')
      assert.equal(url.searchParams.get('key'), KEY)
      return pngResponse()
    },
    getAttachments: () => ({
      async saveImage(image) {
        saved = image
        return { attachmentId: 'att-route', bytes: image.data.length, width: 1, height: 1, mediaType: 'image/png' }
      },
    }),
  })
  assert.equal(tools.some((item) => item.name === 'route_qr'), false)
  const tool = tools.find((item) => item.name === 'route')
  const value = await tool.execute({
    mode: 'driving',
    origin: '116.1,39.1',
    destination: '116.2,39.2',
    originName: '家',
    destinationName: '公司',
  })
  assert.deepEqual(calls, ['/v5/direction/driving', '/v3/staticmap'])
  assert.equal(saved.name, 'route.png')
  assert.equal(value.image.attachmentId, 'att-route')
  assert.equal(JSON.stringify(value).includes('polyline'), false)
  assert.equal(value.share.includes(KEY), false)
  const blocks = tool.output.render({}, value)
  assert.deepEqual(blocks.map((block) => block.type), ['text'])
  assert.match(blocks[0].text, /https:\/\/uri\.amap\.com\/navigation/)
  assert.equal(blocks[0].text.includes(KEY), false)
  const meta = tool.output.presentationMeta({}, value)
  assert.equal(meta.mm.kind, 'route')
  assert.equal(meta.mm.place, undefined)
  assert.equal(meta.mm.asset.attachment.attachmentId, 'att-route')
  const page = new URL(meta.mm.source.url)
  assert.equal(page.origin + page.pathname, 'https://uri.amap.com/navigation')
  assert.equal(page.searchParams.get('from'), '116.1,39.1,家')
  assert.equal(page.searchParams.get('to'), '116.2,39.2,公司')
  assert.equal(meta.mm.source.url.includes(KEY), false)
  assert.equal(JSON.stringify(meta).includes('二维码'), false)
})

test('static route line keeps the ends and drops repeated points', () => {
  const many = []
  for (let i = 0; i < 200; i++) many.push((100 + i / 100) + ',30')
  const params = staticRouteParams('100,30', '101.99,30', many)
  const line = params.paths.split(':')[1].split(';')
  assert.equal(line[0], '100,30')
  assert.equal(line[line.length - 1], '101.99,30')
  assert.equal(line.length <= 81, true)
  assert.equal(params.paths.includes('key='), false)
})

test('map tools mount only from the settings key', async () => {
  process.env.GAODE_API_KEY = 'env-key-should-not-be-used'
  const registered = []
  let disposed = 0
  const ctx = {
    plugin(def) {
      const sub = {
        inject(_names, apply) { apply(sub) },
        tools: { register(tool) { registered.push(tool.name) } },
        get(name) {
          if (name === 'attachments') return { saveImage: async () => ({ attachmentId: 'x' }) }
          return null
        },
      }
      def.apply(sub)
      return { async dispose() { disposed += 1 } }
    },
  }
  let cfg = { mapEnabled: true, gaodeApiKey: '' }
  const feature = createMapFeature(ctx, () => cfg)
  await feature.sync()
  assert.equal(feature.state().mounted, false)
  assert.equal(feature.state().detail, '未配置高德 Key')
  assert.equal(registered.length, 0)
  assert.equal(JSON.stringify(feature.state()).includes('env-key'), false)

  cfg = { mapEnabled: true, gaodeApiKey: 'settings-key' }
  await feature.sync()
  assert.equal(feature.state().mounted, true)
  assert.deepEqual(registered, ['geo_resolve', 'place_search', 'place_detail', 'route', 'weather', 'map_card'])

  cfg = { mapEnabled: false, gaodeApiKey: 'settings-key' }
  await feature.sync()
  assert.equal(disposed, 1)
  assert.equal(feature.state().mounted, false)
  assert.equal(feature.state().detail, '未启用')
  delete process.env.GAODE_API_KEY
})

test('direct amap request carries no proxy', () => {
  const options = directRequestOptions('https://restapi.amap.com/v5/place/text?keywords=a&region=b')
  const { agent, ...rest } = options
  assert.equal(options.hostname, 'restapi.amap.com')
  assert.equal(options.port, 443)
  assert.equal(agent === https.globalAgent, false)
  assert.equal(Object.hasOwn(options, 'proxy'), false)
  assert.equal(JSON.stringify(rest).includes('7890'), false)
  assert.equal(JSON.stringify(rest).includes('PROXY'), false)
  assert.equal(resolveAmapFetch(true), amapFetch)
})

test('bypass proxy setting selects direct fetch and remounts tools', async () => {
  const custom = async () => {}
  assert.equal(resolveAmapFetch(true), amapFetch)
  assert.equal(resolveAmapFetch(undefined), amapFetch)
  assert.equal(resolveAmapFetch(false), globalThis.fetch)
  assert.equal(resolveAmapFetch(false, custom), custom)

  let disposed = 0
  const ctx = {
    plugin() {
      return { async dispose() { disposed += 1 } }
    },
  }
  let cfg = { mapEnabled: true, gaodeApiKey: 'settings-key', mapBypassProxy: true }
  const feature = createMapFeature(ctx, () => cfg)
  await feature.sync()
  assert.equal(feature.state().mounted, true)
  cfg = { mapEnabled: true, gaodeApiKey: 'settings-key', mapBypassProxy: false }
  await feature.sync()
  assert.equal(disposed, 1)
  assert.equal(feature.state().mounted, true)
})
