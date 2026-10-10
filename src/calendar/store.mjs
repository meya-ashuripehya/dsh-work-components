/**
 * 日程落在数据目录 calendar/events.json，不写入 settings.json。
 * 先写临时文件再替换。同一进程内的读写串行执行。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { CalendarError, validDate } from './day.mjs'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

let tail = Promise.resolve()

function exclusive(fn) {
  const run = tail.then(fn, fn)
  tail = run.then(() => undefined, () => undefined)
  return run
}

export function eventsFile(root) {
  return join(root || dataDir(), 'calendar', 'events.json')
}

function replaceFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(file, { force: true })
    renameSync(tmp, file)
  }
}

function readStore(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [] }
    throw new CalendarError('日程文件无法读取')
  }
  try {
    const data = JSON.parse(raw)
    return { events: Array.isArray(data?.events) ? data.events : [] }
  } catch {
    throw new CalendarError('日程文件无法读取')
  }
}

function writeStore(file, events) {
  replaceFile(file, JSON.stringify({ events }, null, 2) + '\n')
}

function cleanText(value, label, max) {
  const text = String(value ?? '').trim()
  if (text.length > max) throw new CalendarError(label + '不超过 ' + max + ' 字')
  return text
}

export function normalizeEvent(input, existing) {
  const source = input || {}
  const title = cleanText(source.title ?? existing?.title, '标题', 80)
  if (!title) throw new CalendarError('日程需要标题')
  const date = String(source.date ?? existing?.date ?? '').trim()
  if (!DATE.test(date) || !validDate(date)) throw new CalendarError('日期须为 YYYY-MM-DD')
  const endRaw = source.endDate === undefined ? (existing?.endDate || '') : source.endDate
  const endDate = String(endRaw ?? '').trim()
  if (endDate && (!DATE.test(endDate) || !validDate(endDate) || endDate < date)) {
    throw new CalendarError('结束日期不能早于开始日期')
  }
  const time = String(source.time === undefined ? (existing?.time || '') : source.time).trim()
  const endTime = String(source.endTime === undefined ? (existing?.endTime || '') : source.endTime).trim()
  if (time && !TIME.test(time)) throw new CalendarError('时间须为 HH:MM')
  if (endTime && !TIME.test(endTime)) throw new CalendarError('结束时间须为 HH:MM')
  const note = cleanText(source.note === undefined ? existing?.note : source.note, '备注', 500)
  const event = {
    id: existing?.id || ('evt_' + randomBytes(8).toString('hex')),
    title,
    date,
    allDay: !time,
    updatedAt: new Date().toISOString(),
  }
  if (endDate) event.endDate = endDate
  if (time) event.time = time
  if (endTime) event.endTime = endTime
  if (note) event.note = note
  return event
}

export function publicEvent(event) {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    allDay: event.allDay !== false && !event.time,
    ...(event.endDate ? { endDate: event.endDate } : {}),
    ...(event.time ? { time: event.time } : {}),
    ...(event.endTime ? { endTime: event.endTime } : {}),
    ...(event.note ? { note: event.note } : {}),
  }
}

export function eventCovers(event, date) {
  const end = event.endDate || event.date
  return event.date <= date && date <= end
}

export function listEvents(root) {
  return exclusive(async () => readStore(eventsFile(root)).events.map(publicEvent))
}

export function saveEvent(input, root) {
  return exclusive(async () => {
    const file = eventsFile(root)
    const store = readStore(file)
    const id = String(input?.id ?? '').trim()
    let existing = null
    if (id) {
      existing = store.events.find((event) => event.id === id) || null
      if (!existing) throw new CalendarError('没有这条日程', 404)
    }
    const next = normalizeEvent(input, existing)
    const events = existing
      ? store.events.map((event) => (event.id === existing.id ? next : event))
      : store.events.concat([next])
    writeStore(file, events)
    return publicEvent(next)
  })
}

export function deleteEvent(id, root) {
  return exclusive(async () => {
    const eventId = String(id ?? '').trim()
    if (!eventId) throw new CalendarError('需要日程 id')
    const file = eventsFile(root)
    const store = readStore(file)
    if (!store.events.some((event) => event.id === eventId)) throw new CalendarError('没有这条日程', 404)
    writeStore(file, store.events.filter((event) => event.id !== eventId))
    return { id: eventId }
  })
}
