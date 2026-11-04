/**
 * 月历无损 PNG（纯 JS + 预烘焙字形遮罩）。供 QQ 等走 harness image 出站的通道。
 * 不依赖运行时字体 / canvas / 原生模块。Telegram 仍走 HTML，不经过这里。
 */
import { deflateSync, inflateRawSync } from 'node:zlib'
import { GLYPHS } from './glyphs.mjs'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const PAD = 16
const COLS = 7
const CELL_W = 92
const CELL_H = 78
const HEADER_H = 52
const WEEK_H = 28
const FOOTER_H = 36

export function rgb(hex, alpha = 1) {
  const h = String(hex).replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha]
}

export class Canvas {
  constructor(width, height, background = '#ffffff') {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 4)
    const [r, g, b] = rgb(background)
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = r
      this.data[i * 4 + 1] = g
      this.data[i * 4 + 2] = b
      this.data[i * 4 + 3] = 255
    }
  }

  blend(x, y, color, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const k = a * color[3]
    if (k <= 0) return
    const i = (y * this.width + x) * 4
    const d = this.data
    d[i] += (color[0] - d[i]) * k
    d[i + 1] += (color[1] - d[i + 1]) * k
    d[i + 2] += (color[2] - d[i + 2]) * k
  }

  fillRect(x, y, w, h, color) {
    const c = typeof color === 'string' ? rgb(color) : color
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.width, Math.round(x + w))
    const y1 = Math.min(this.height, Math.round(y + h))
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, 1)
  }

  strokeRect(x, y, w, h, color, width = 1) {
    const c = typeof color === 'string' ? rgb(color) : color
    this.fillRect(x, y, w, width, c)
    this.fillRect(x, y + h - width, w, width, c)
    this.fillRect(x, y, width, h, c)
    this.fillRect(x + w - width, y, width, h, c)
  }

  /** kind: k 正文 / s 小字。anchor: left | center */
  text(str, x, y, color, { kind = 'k', anchor = 'left', gap = 1 } = {}) {
    const glyphs = [...String(str)].map((ch) => glyphMask(kind, ch)).filter(Boolean)
    if (!glyphs.length) return 0
    const total = glyphs.reduce((s, g) => s + g.w, 0) + gap * Math.max(0, glyphs.length - 1)
    let cx = anchor === 'center' ? x - total / 2 : x
    const c = typeof color === 'string' ? rgb(color) : color
    for (const g of glyphs) {
      const ox = Math.round(cx)
      const oy = Math.round(y + (g.oy ?? -g.h))
      for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) {
        const a = g.mask[yy * g.w + xx]
        if (a) this.blend(ox + xx, oy + yy, c, a / 255)
      }
      cx += g.w + gap
    }
    return total
  }

  toPng() {
    return encodePng(this.width, this.height, this.data)
  }
}

const cache = new Map()
function glyphMask(kind, ch) {
  const key = kind + ':' + ch
  if (cache.has(key)) return cache.get(key)
  const raw = GLYPHS[key]
  const g = raw ? { w: raw.w, h: raw.h, oy: raw.oy, mask: inflateRawSync(Buffer.from(raw.d, 'base64')) } : null
  cache.set(key, g)
  return g
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(width, height, rgba) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = y * stride + 1 + x * 3
      raw[d] = rgba[s]
      raw[d + 1] = rgba[s + 1]
      raw[d + 2] = rgba[s + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function clip(text, max) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function tempPair(forecast) {
  if (!forecast) return ''
  const day = String(forecast.dayTemp ?? '').trim()
  const night = String(forecast.nightTemp ?? '').trim()
  if (!day && !night) return ''
  return (day || '–') + '/' + (night || '–') + '°'
}

function weatherShort(forecast) {
  if (!forecast) return ''
  const w = String(forecast.dayWeather ?? '').trim()
  if (!w) return ''
  if (w.includes('雷')) return '雷'
  if (w.includes('雪')) return '雪'
  if (w.includes('雨')) return '雨'
  if (w.includes('雾')) return '雾'
  if (w.includes('阴')) return '阴'
  if (w.includes('云')) return '多云'
  if (w.includes('晴')) return '晴'
  return clip(w, 3)
}

/**
 * @param {object} calendar buildMonth() result
 * @returns {{ png: Buffer, width: number, height: number }}
 */
export function renderCalendarPng(calendar) {
  const days = Array.isArray(calendar?.days) ? calendar.days : []
  const firstWeekday = days[0] ? Number(days[0].weekday) || 0 : 0
  const rows = Math.ceil((firstWeekday + days.length) / COLS) || 5
  const width = PAD * 2 + COLS * CELL_W
  const height = PAD + HEADER_H + WEEK_H + rows * CELL_H + FOOTER_H + PAD
  const canvas = new Canvas(width, height, '#f4f6f8')

  canvas.fillRect(PAD - 4, PAD - 4, width - (PAD - 4) * 2, height - (PAD - 4) * 2, '#ffffff')
  canvas.strokeRect(PAD - 4, PAD - 4, width - (PAD - 4) * 2, height - (PAD - 4) * 2, '#e5e7eb', 1)

  const title = clip(calendar?.title || calendar?.month || '日历', 24)
  canvas.text(title, PAD + 8, PAD + 28, '#111827', { kind: 'k' })

  const weather = calendar?.weather
  let sub = ''
  if (weather?.error) sub = clip(weather.error, 28)
  else if (weather?.city) {
    const src = weather.source ? ' · ' + weather.source : ''
    sub = clip(String(weather.city) + src, 32)
  } else if (calendar?.city) sub = clip(calendar.city, 24)
  if (sub) canvas.text(sub, PAD + 8, PAD + 48, '#6b7280', { kind: 's' })

  const gridTop = PAD + HEADER_H
  for (let i = 0; i < COLS; i++) {
    const x = PAD + i * CELL_W + CELL_W / 2
    const color = i === 0 || i === 6 ? '#dc2626' : '#374151'
    canvas.text(WEEK[i], x, gridTop + 20, color, { kind: 's', anchor: 'center' })
  }

  const today = String(calendar?.today || '')
  for (let i = 0; i < days.length; i++) {
    const day = days[i]
    const idx = firstWeekday + i
    const col = idx % COLS
    const row = Math.floor(idx / COLS)
    const x = PAD + col * CELL_W
    const y = gridTop + WEEK_H + row * CELL_H

    let bg = null
    if (day.rest) bg = '#fef2f2'
    else if (day.work) bg = '#fffbeb'
    else if (day.weekend) bg = '#f9fafb'
    if (bg) canvas.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2, bg)

    if (day.date === today) canvas.strokeRect(x + 2, y + 2, CELL_W - 4, CELL_H - 4, '#2563eb', 2)

    const dayColor = day.rest || day.weekend ? '#dc2626' : '#111827'
    canvas.text(String(day.solarDay ?? ''), x + 8, y + 22, dayColor, { kind: 'k' })

    if (day.rest) canvas.text('休', x + CELL_W - 22, y + 20, '#dc2626', { kind: 's' })
    else if (day.work) canvas.text('班', x + CELL_W - 22, y + 20, '#d97706', { kind: 's' })

    const mark = clip(day.mark || day.term || day.holiday || '', 5)
    if (mark) canvas.text(mark, x + 8, y + 40, '#6b7280', { kind: 's' })

    const wx = weatherShort(day.forecast)
    const temps = tempPair(day.forecast)
    if (wx || temps) {
      canvas.text(clip([wx, temps].filter(Boolean).join(' '), 10), x + 8, y + 56, '#4b5563', { kind: 's' })
    }

    const ev = (day.events || [])[0]
    if (ev?.title) {
      const when = ev.allDay ? '' : String(ev.time || '').trim()
      canvas.text(clip((when ? when + ' ' : '') + ev.title, 8), x + 8, y + 70, '#1d4ed8', { kind: 's' })
    }
  }

  canvas.text('农历 · 节气 · 休班 · 天气', PAD + 8, height - PAD - 10, '#9ca3af', { kind: 's' })

  const png = canvas.toPng()
  return { png, width, height }
}