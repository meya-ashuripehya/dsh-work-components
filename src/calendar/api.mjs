/**
 * 日历的同源接口。修改请求拒绝 cross-site，与设置接口相同。
 */
import { CalendarError } from './day.mjs'
import { buildMonth } from './month.mjs'
import { deleteEvent, saveEvent } from './store.mjs'

function weatherOptions(cfg) {
  const current = cfg || {}
  return {
    city: String(current.calendarCity ?? '').trim(),
  }
}

function refuseCrossSite(req) {
  return req.headers['sec-fetch-site'] === 'cross-site'
}

/**
 * @returns {Promise<boolean>} 是否已处理该路径
 */
export async function handleCalendarApi(req, res, sub, helpers) {
  const { sendJson, readBody, getConfig } = helpers
  if (sub === '/calendar' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local')
    const calendar = await buildMonth(url.searchParams.get('month') || '', weatherOptions(getConfig()))
    sendJson(res, 200, { ok: true, calendar })
    return true
  }

  const one = /^\/calendar\/events\/([^/]+)$/.exec(sub)
  if (one && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (refuseCrossSite(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return true
    }
    const id = decodeURIComponent(one[1])
    if (req.method === 'DELETE') {
      const removed = await deleteEvent(id)
      sendJson(res, 200, { ok: true, ...removed })
      return true
    }
    const body = JSON.parse(await readBody(req) || '{}')
    const event = await saveEvent({ ...body, id })
    const calendar = await buildMonth(event.date.slice(0, 7), weatherOptions(getConfig()))
    sendJson(res, 200, { ok: true, event, calendar })
    return true
  }

  if (sub === '/calendar/events' && req.method === 'POST') {
    if (refuseCrossSite(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return true
    }
    const body = JSON.parse(await readBody(req) || '{}')
    const event = await saveEvent(body)
    const calendar = await buildMonth(event.date.slice(0, 7), weatherOptions(getConfig()))
    sendJson(res, 200, { ok: true, event, calendar })
    return true
  }

  return false
}

export function calendarErrorStatus(error) {
  if (error instanceof CalendarError) return error.status || 400
  return error?.status ?? 400
}
