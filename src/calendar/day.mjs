/**
 * 中国大陆公历 / 农历、节气、传统节日、法定节假日与调休。
 * 数据来自 lunar-javascript，不在运行时抓网页。「今天」按 Asia/Shanghai。
 */
import { HolidayUtil, Solar } from 'lunar-javascript'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export class CalendarError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'CalendarError'
    this.status = status
  }
}

export function shanghaiParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value)
  return { year: pick('year'), month: pick('month'), day: pick('day') }
}

export function formatYmd(year, month, day) {
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
}

export function shanghaiToday(now = new Date()) {
  const parts = shanghaiParts(now)
  return formatYmd(parts.year, parts.month, parts.day)
}

export function parseMonth(value, now = new Date()) {
  const text = String(value ?? '').trim()
  if (!text) {
    const parts = shanghaiParts(now)
    return { year: parts.year, month: parts.month }
  }
  const matched = /^(\d{4})-(\d{2})$/.exec(text)
  if (!matched) throw new CalendarError('月份须为 YYYY-MM')
  const year = Number(matched[1])
  const month = Number(matched[2])
  if (month < 1 || month > 12) throw new CalendarError('月份须为 YYYY-MM')
  return { year, month }
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function validDate(text) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''))
  if (!matched) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function cellMark(term, festivals, lunarDay, lunarMonth) {
  if (term) return term
  if (festivals.length) return festivals[0]
  if (lunarDay === '初一') return lunarMonth + '月'
  if (lunarDay === '十五') return '十五'
  return lunarDay
}

/** 一天的历法与节假日。weekday：0 为星期日。 */
export function describeDay(year, month, day) {
  const solar = Solar.fromYmd(year, month, day)
  const lunar = solar.getLunar()
  const term = lunar.getJieQi() || ''
  const festivals = [...(lunar.getFestivals() || []), ...(solar.getFestivals() || [])]
  const holiday = HolidayUtil.getHoliday(year, month, day)
  const work = !!(holiday && holiday.isWork())
  const rest = !!(holiday && !holiday.isWork())
  const weekday = solar.getWeek()
  const lunarDay = lunar.getDayInChinese()
  const lunarMonth = lunar.getMonthInChinese()
  return {
    date: formatYmd(year, month, day),
    solarDay: day,
    weekday,
    weekdayLabel: WEEK[weekday] || '',
    lunarText: lunarMonth + '月' + lunarDay,
    term,
    festivals,
    holiday: rest ? holiday.getName() : '',
    rest,
    work,
    weekend: weekday === 0 || weekday === 6,
    mark: cellMark(term, festivals, lunarDay, lunarMonth),
  }
}
