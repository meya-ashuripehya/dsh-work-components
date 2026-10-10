/**
 * 地图标点卡片（presentationMeta.mm.kind = 'place'）发到 Telegram 时走 sendVenue，
 * 不再把静态地图预览当图片发出。坐标必须已是 WGS-84（place.wgsLongitude / wgsLatitude）。
 * 挂在 ReplyRouter 原型上，不改 vendor 补丁文件。
 */

const TITLE_MAX = 128
const ADDRESS_MAX = 256

function clip(value, max) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) : text
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

function mmBlocks(meta) {
  if (!meta || typeof meta !== 'object') return []
  if (meta.mm && meta.mm.type === 'mm') return [meta.mm]
  if (Array.isArray(meta.mms)) return meta.mms.filter((block) => block && block.type === 'mm')
  return []
}

export function venueFromMm(mm) {
  if (!mm || mm.type !== 'mm' || mm.kind !== 'place' || !mm.place) return null
  const lat = Number(mm.place.wgsLatitude)
  const lon = Number(mm.place.wgsLongitude)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null
  const title = clip(mm.place.title || mm.title, TITLE_MAX) || '位置'
  const address = clip(mm.place.address || mm.caption, ADDRESS_MAX) || title
  return {
    latitude: round6(lat),
    longitude: round6(lon),
    title,
    address,
  }
}

export function venuesFromToolResult(event) {
  const venues = []
  for (const block of mmBlocks(event?.data?.meta)) {
    const venue = venueFromMm(block)
    if (venue) venues.push(venue)
  }
  return venues
}

function turnOf(router, sessionId, data) {
  if (data.turn !== undefined) return data.turn
  if (router.currentTurns?.has(sessionId)) return router.currentTurns.get(sessionId)
  return router.active?.get(sessionId)?.turn
}

export function installMapPlaceDelivery(ReplyRouter) {
  const proto = ReplyRouter && ReplyRouter.prototype
  if (!proto || proto.__dshMapPlace || typeof proto.collectToolResultImages !== 'function') return false
  proto.__dshMapPlace = true
  const origCollect = proto.collectToolResultImages
  const origDeliver = proto.deliverTurnImages
  const origDispose = proto.dispose

  proto.collectToolResultImages = function collectToolResultImages(session, event) {
    const venues = venuesFromToolResult(event)
    if (!venues.length) return origCollect.call(this, session, event)
    const sessionId = String(session.id)
    const data = (event && event.data) || {}
    const message = data.message
    if (!message || message.isError === true) return
    const turn = turnOf(this, sessionId, data)
    if (turn === undefined) return
    if (!this.options?.replyContexts?.getTurn(sessionId, turn)) return
    const key = sessionId + ':' + String(turn)
    if (!this.pendingPlaces) this.pendingPlaces = new Map()
    const list = this.pendingPlaces.get(key) || []
    for (const venue of venues) {
      if (list.length >= 10) break
      list.push(venue)
    }
    this.pendingPlaces.set(key, list)
  }

  proto.deliverTurnImages = async function deliverTurnImages(sessionId, turn, terminalTarget) {
    const key = sessionId + ':' + String(turn)
    const venues = this.pendingPlaces ? this.pendingPlaces.get(key) : undefined
    if (this.pendingPlaces) this.pendingPlaces.delete(key)
    if (venues && venues.length && terminalTarget && terminalTarget.adapter) {
      const upstream = terminalTarget.adapter.upstream
      const chatId = terminalTarget.target && terminalTarget.target.conversationId
      if (upstream && typeof upstream.requestOk === 'function' && chatId) {
        for (const venue of venues) {
          try {
            await upstream.requestOk('sendVenue', {
              chat_id: chatId,
              latitude: venue.latitude,
              longitude: venue.longitude,
              title: venue.title,
              address: venue.address,
            })
          } catch (error) {
            this.options?.logger?.warn?.(
              `[channel-harness] failed to send venue '${venue.title}'`,
              error,
            )
          }
        }
      } else {
        this.options?.logger?.warn?.('[channel-harness] map place dropped: telegram upstream unavailable')
      }
    }
    if (typeof origDeliver === 'function') return origDeliver.call(this, sessionId, turn, terminalTarget)
  }

  proto.dispose = function dispose() {
    this.pendingPlaces?.clear()
    if (typeof origDispose === 'function') return origDispose.call(this)
  }
  return true
}
