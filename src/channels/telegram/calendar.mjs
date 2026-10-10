/**
 * 日历卡片（presentationMeta.mm.kind = 'calendar'）发到 Telegram 时走 sendMessage（HTML）。
 * 页面上的动态天气图标在这里换成对应表情。挂在 ReplyRouter 原型上，不改 vendor 补丁文件。
 */
import { WEATHER_EMOJI, weatherKindFromText } from '../../calendar/weather.mjs'

const LIMIT = 3800
const LINE_MAX = 240

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function clip(value, max) {
  const text = String(value ?? '').trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + '…'
}

function mmBlocks(meta) {
  if (!meta || typeof meta !== 'object') return []
  if (meta.mm && meta.mm.type === 'mm') return [meta.mm]
  if (Array.isArray(meta.mms)) return meta.mms.filter((block) => block && block.type === 'mm')
  return []
}

function emojiFor(forecast) {
  if (!forecast) return ''
  const kind = WEATHER_EMOJI[forecast.icon] ? forecast.icon : weatherKindFromText(forecast.dayWeather)
  return WEATHER_EMOJI[kind] || WEATHER_EMOJI.unknown
}

function tempPair(forecast) {
  const day = String(forecast.dayTemp ?? '').trim()
  const night = String(forecast.nightTemp ?? '').trim()
  if (!day && !night) return ''
  return (day || '–') + '°/' + (night || '–') + '°'
}

function headerOf(calendar) {
  const lines = ['<b>' + esc(clip(calendar.title || calendar.month || '日历', 40)) + '</b>']
  const weather = calendar.weather
  if (weather && weather.error) lines.push(esc(clip(weather.error, 120)))
  else if (weather && weather.city) {
    const source = weather.source ? ' · ' + weather.source : ''
    lines.push(esc(clip(String(weather.city) + source, 80)))
  }
  return lines.join('\n')
}

function dayLine(day, today) {
  const head = (day.date && day.date === today ? '今天 ' : '')
    + (day.solarDay ?? '') + '日 周' + (day.weekdayLabel || '')
  const bits = [esc(head)]
  if (day.lunarText) bits.push(esc(day.lunarText))
  const forecast = day.forecast
  if (forecast) {
    const emoji = emojiFor(forecast)
    if (emoji) bits.push(emoji)
    const temps = tempPair(forecast)
    if (temps) bits.push(esc(temps))
    if (forecast.dayWeather) bits.push(esc(forecast.dayWeather))
  }
  if (day.rest) bits.push('休')
  else if (day.work) bits.push('班')
  if (day.holiday) bits.push(esc(day.holiday))
  if (day.term) bits.push(esc(day.term))
  for (const event of (day.events || []).slice(0, 3)) {
    const when = event.allDay ? '全天' : String(event.time || '').trim()
    const title = clip(event.title, 40)
    const label = (when ? when + ' ' : '') + title
    if (label.trim()) bits.push(esc(label.trim()))
  }
  return clip(bits.filter(Boolean).join(' '), LINE_MAX)
}

/** 把一个月历收成若干条不超过 Telegram 正文上限的 HTML。 */
export function calendarTelegramMessages(calendar) {
  if (!calendar || typeof calendar !== 'object') return []
  const header = headerOf(calendar)
  const lines = (Array.isArray(calendar.days) ? calendar.days : []).map((day) => dayLine(day || {}, calendar.today))
  if (!header && lines.length === 0) return []
  const chunks = []
  let buf = header
  for (const line of lines) {
    const next = buf ? buf + '\n' + line : line
    if (next.length <= LIMIT) {
      buf = next
      continue
    }
    if (buf) chunks.push(buf)
    buf = header ? header + '\n' + line : line
    if (buf.length > LIMIT) {
      chunks.push(buf.slice(0, LIMIT))
      buf = header
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

export function calendarsFromToolResult(event) {
  const data = event?.data
  if (!data || data.message?.isError === true) return []
  const found = []
  for (const block of mmBlocks(data.meta)) {
    if (block.kind !== 'calendar' || !block.calendar || typeof block.calendar !== 'object') continue
    found.push(block.calendar)
    if (found.length >= 2) break
  }
  return found
}

function turnOf(router, sessionId, data) {
  if (data.turn !== undefined) return data.turn
  if (router.currentTurns?.has(sessionId)) return router.currentTurns.get(sessionId)
  return router.active?.get(sessionId)?.turn
}

export function installCalendarDelivery(ReplyRouter) {
  const proto = ReplyRouter && ReplyRouter.prototype
  if (!proto || proto.__dshCalendar || typeof proto.collectToolResultImages !== 'function') return false
  proto.__dshCalendar = true
  const origCollect = proto.collectToolResultImages
  const origDeliver = proto.deliverTurnImages
  const origDispose = proto.dispose

  proto.collectToolResultImages = function collectToolResultImages(session, event) {
    const calendars = calendarsFromToolResult(event)
    if (calendars.length) {
      const sessionId = String(session.id)
      const data = (event && event.data) || {}
      const turn = turnOf(this, sessionId, data)
      if (turn !== undefined && this.options?.replyContexts?.getTurn(sessionId, turn)) {
        const key = sessionId + ':' + String(turn)
        if (!this.pendingCalendars) this.pendingCalendars = new Map()
        const list = this.pendingCalendars.get(key) || []
        for (const calendar of calendars) {
          if (list.length >= 2) break
          list.push(calendar)
        }
        this.pendingCalendars.set(key, list)
      }
    }
    return origCollect.call(this, session, event)
  }

  proto.deliverTurnImages = async function deliverTurnImages(sessionId, turn, terminalTarget) {
    const key = sessionId + ':' + String(turn)
    const calendars = this.pendingCalendars ? this.pendingCalendars.get(key) : undefined
    if (this.pendingCalendars) this.pendingCalendars.delete(key)
    if (calendars && calendars.length && terminalTarget && terminalTarget.adapter) {
      const upstream = terminalTarget.adapter.upstream
      const chatId = terminalTarget.target && terminalTarget.target.conversationId
      if (upstream && typeof upstream.requestOk === 'function' && chatId) {
        for (const calendar of calendars) {
          for (const text of calendarTelegramMessages(calendar)) {
            try {
              await upstream.requestOk('sendMessage', {
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
              })
            } catch (error) {
              this.options?.logger?.warn?.(
                '[channel-harness] failed to send calendar',
                error,
              )
            }
          }
        }
      } else {
        this.options?.logger?.warn?.('[channel-harness] calendar dropped: telegram upstream unavailable')
      }
    }
    if (typeof origDeliver === 'function') return origDeliver.call(this, sessionId, turn, terminalTarget)
  }

  proto.dispose = function dispose() {
    this.pendingCalendars?.clear()
    if (typeof origDispose === 'function') return origDispose.call(this)
  }
  return true
}
