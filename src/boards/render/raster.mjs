/**
 * 极简 RGBA 光栅器 + PNG 编码（纯 JS，只用 node:zlib）。供棋盘出图：直线、矩形、抗锯齿圆、字形遮罩。
 * 不依赖字体、canvas 或原生模块，Windows / Linux 输出一致。
 */
import { deflateSync, inflateRawSync } from 'node:zlib'
import { GLYPHS } from './glyphs.mjs'

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
      this.data[i * 4] = r; this.data[i * 4 + 1] = g; this.data[i * 4 + 2] = b; this.data[i * 4 + 3] = 255
    }
  }

  /** 以覆盖率 a（0..1）把颜色混到 (x, y)。 */
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
    const x0 = Math.max(0, Math.round(x)); const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.width, Math.round(x + w)); const y1 = Math.min(this.height, Math.round(y + h))
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, 1)
  }

  /** 抗锯齿线段（圆头），width 为线宽。 */
  line(x1, y1, x2, y2, color, width = 1) {
    const c = typeof color === 'string' ? rgb(color) : color
    const r = width / 2
    const minX = Math.floor(Math.min(x1, x2) - r - 1); const maxX = Math.ceil(Math.max(x1, x2) + r + 1)
    const minY = Math.floor(Math.min(y1, y2) - r - 1); const maxY = Math.ceil(Math.max(y1, y2) + r + 1)
    const dx = x2 - x1; const dy = y2 - y1
    const len2 = dx * dx + dy * dy || 1
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5; const py = y + 0.5
        let t = ((px - x1) * dx + (py - y1) * dy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const qx = x1 + t * dx - px; const qy = y1 + t * dy - py
        const dist = Math.sqrt(qx * qx + qy * qy)
        const a = Math.min(1, Math.max(0, r + 0.5 - dist))
        if (a > 0) this.blend(x, y, c, a)
      }
    }
  }

  /** 抗锯齿实心圆；ring 给出时画圆环（ring 为环宽）。 */
  circle(cx, cy, radius, color, ring = 0) {
    const c = typeof color === 'string' ? rgb(color) : color
    const minX = Math.floor(cx - radius - 1); const maxX = Math.ceil(cx + radius + 1)
    const minY = Math.floor(cy - radius - 1); const maxY = Math.ceil(cy + radius + 1)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        let a = Math.min(1, Math.max(0, radius + 0.5 - dist))
        if (ring > 0) a = Math.min(a, Math.min(1, Math.max(0, dist - (radius - ring) + 0.5)))
        if (a > 0) this.blend(x, y, c, a)
      }
    }
  }

  /** 以 (cx, cy) 为中心画字形遮罩。kind: x 象棋子 / c 国际象棋子 / a 坐标字符。 */
  glyph(kind, ch, cx, cy, color) {
    const g = glyphMask(kind, ch)
    if (!g) return 0
    const c = typeof color === 'string' ? rgb(color) : color
    const ox = Math.round(cx - g.w / 2); const oy = Math.round(cy - g.h / 2)
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const a = g.mask[y * g.w + x]
      if (a) this.blend(ox + x, oy + y, c, a / 255)
    }
    return g.w
  }

  /** 居中写一串坐标字符（只支持 GLYPHS 里的 a:*）。 */
  text(str, cx, cy, color) {
    const chars = [...String(str)].map((ch) => glyphMask('a', ch)).filter(Boolean)
    const gap = 1
    const total = chars.reduce((s, g) => s + g.w, 0) + gap * Math.max(0, chars.length - 1)
    let x = cx - total / 2
    const c = typeof color === 'string' ? rgb(color) : color
    for (const g of chars) {
      const ox = Math.round(x); const oy = Math.round(cy + 13 / 2) + (g.oy ?? -g.h) // 基线对齐（大写高约 13px）
      for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) {
        const a = g.mask[yy * g.w + xx]
        if (a) this.blend(ox + xx, oy + yy, c, a / 255)
      }
      x += g.w + gap
    }
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** RGBA → PNG（存为 RGB，8 位，无滤波行）。 */
export function encodePng(width, height, rgba) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4; const d = y * stride + 1 + x * 3
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
