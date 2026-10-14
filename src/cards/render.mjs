/**
 * 牌桌 PNG。只画公开局面：hidden 的牌画牌背，不读它的点数、花色或编码。
 * 点阵只有拉丁字母和数字，牌桌标题用 LED / HOLD / N1 / DD，不用汉字。
 * 座位与页面一致：玩家在下方，对手顺时针（左 → 上 → 右）排布，对手暗牌画成小牌背扇形。
 */
import { Canvas, rgb } from '../boards/render/raster.mjs'
import { cardTableLayout, fanLayout } from './layout.mjs'

const FELT = '#0c5a38'
const INK = '#1c1915'
const RED = '#b42318'
const CREAM = '#f7f1e4'
const BACK = '#0e3a32'
const GOLD = '#d4b483'

function paintBack(c, x, y, w, h) {
  c.fillRect(x, y, w, h, BACK)
  c.line(x + 1, y + 1, x + w - 2, y + 1, GOLD, 2)
  c.line(x + 1, y + h - 2, x + w - 2, y + h - 2, GOLD, 2)
  c.line(x + 1, y + 1, x + 1, y + h - 2, GOLD, 2)
  c.line(x + w - 2, y + 1, x + w - 2, y + h - 2, GOLD, 2)
  const inset = 10
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if ((row + col) % 2 === 0) c.fillRect(x + inset + col * ((w - inset * 2) / 3), y + inset + row * ((h - inset * 2) / 5), 8, 8, GOLD)
    }
  }
}

function pip(c, suit, cx, cy, scale) {
  const color = suit === 'H' || suit === 'D' ? RED : INK
  const r = 7 * scale
  if (suit === 'H') {
    c.circle(cx - r * 0.55, cy - r * 0.15, r * 0.62, color)
    c.circle(cx + r * 0.55, cy - r * 0.15, r * 0.62, color)
    c.line(cx - r * 1.05, cy, cx, cy + r * 1.35, color, r * 0.9)
    c.line(cx + r * 1.05, cy, cx, cy + r * 1.35, color, r * 0.9)
  } else if (suit === 'D') {
    c.line(cx, cy - r * 1.3, cx + r, cy, color, r * 0.85)
    c.line(cx, cy - r * 1.3, cx - r, cy, color, r * 0.85)
    c.line(cx, cy + r * 1.3, cx + r, cy, color, r * 0.85)
    c.line(cx, cy + r * 1.3, cx - r, cy, color, r * 0.85)
  } else if (suit === 'C') {
    c.circle(cx, cy - r * 0.45, r * 0.48, color)
    c.circle(cx - r * 0.5, cy + r * 0.25, r * 0.48, color)
    c.circle(cx + r * 0.5, cy + r * 0.25, r * 0.48, color)
    c.line(cx, cy + r * 0.2, cx, cy + r * 1.25, color, r * 0.28)
  } else {
    c.circle(cx, cy + r * 0.15, r * 0.55, color)
    c.line(cx, cy - r * 1.15, cx - r * 0.85, cy + r * 0.15, color, r * 0.7)
    c.line(cx, cy - r * 1.15, cx + r * 0.85, cy + r * 0.15, color, r * 0.7)
    c.line(cx, cy + r * 0.35, cx, cy + r * 1.3, color, r * 0.28)
  }
}

function paintFace(c, x, y, w, h, card) {
  c.fillRect(x, y, w, h, CREAM)
  c.line(x + 1, y + 1, x + w - 2, y + 1, INK, 2)
  c.line(x + 1, y + h - 2, x + w - 2, y + h - 2, INK, 2)
  c.line(x + 1, y + 1, x + 1, y + h - 2, INK, 2)
  c.line(x + w - 2, y + 1, x + w - 2, y + h - 2, INK, 2)
  const red = card.suit === 'H' || card.suit === 'D'
  const label = String(card.code || '').replace(/[SHDC]$/, '')
  c.text(label, x + 16, y + 18, red ? RED : INK)
  c.text(card.suit || '', x + 16, y + 34, red ? RED : INK)
  pip(c, card.suit, x + w / 2, y + h / 2 + 6, Math.min(w, h) / 70)
}

const TONE = { r: '#b42318', g: '#1f7a4d', b: '#1d4e89', y: '#c4a035' }

function paintCard(c, x, y, w, h, card) {
  if (!card || card.hidden === true) {
    paintBack(c, x, y, w, h)
    // 多人 UNO：对手牌背上只标张数
    if (card && Number.isInteger(card.count)) {
      c.fillRect(x + w / 2 - 18, y + h / 2 - 12, 36, 24, CREAM)
      c.text(String(card.count), x + w / 2, y + h / 2, INK)
    }
    return
  }
  if (card.suit) {
    paintFace(c, x, y, w, h, card)
    return
  }
  const tone = TONE[card.tone] || ''
  if (card.pip) {
    c.fillRect(x, y, w, h, CREAM)
    edge(c, x, y, w, h)
    ddzDecor(c, card, x + w / 2, y + h / 2, w, h)
    return
  }
  c.fillRect(x, y, w, h, tone || CREAM)
  c.line(x + 1, y + 1, x + w - 2, y + 1, INK, 2)
  c.line(x + 1, y + h - 2, x + w - 2, y + h - 2, INK, 2)
  c.line(x + 1, y + 1, x + 1, y + h - 2, INK, 2)
  c.line(x + w - 2, y + 1, x + w - 2, y + h - 2, INK, 2)
  if (card.kind) {
    unoDecor(c, card, x + w / 2, y + h / 2, w, h)
    return
  }
  const label = String(card.text || card.code || '').replace(/[^0-9A-Za-z]/g, '')
  if (label) c.text(label, x + w / 2, y + h / 2, tone ? '#f7f1e4' : INK)
}

function edge(c, x, y, w, h) {
  c.line(x + 1, y + 1, x + w - 2, y + 1, INK, 2)
  c.line(x + 1, y + h - 2, x + w - 2, y + h - 2, INK, 2)
  c.line(x + 1, y + 1, x + 1, y + h - 2, INK, 2)
  c.line(x + w - 2, y + 1, x + w - 2, y + h - 2, INK, 2)
}

/** 四色轮（UNO 万能牌）：右下红、左下蓝、左上黄、右上绿。 */
function wheel(c, cx, cy, r) {
  const cols = [TONE.r, TONE.b, TONE.y, TONE.g].map((x) => rgb(x))
  const rim = rgb(INK)
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const d = Math.hypot(dx, dy)
      const a = Math.min(1, Math.max(0, r - d + 0.5))
      if (a <= 0) continue
      if (d > r - 1.2) { c.blend(x, y, rim, a); continue }
      const q = Math.floor(((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4
      c.blend(x, y, cols[q], a)
    }
  }
}

/** UNO 图标：数字用点阵字；跳过 = 圆圈斜杠；反转 = 一对反向箭头；+2 / +4 = 画出的加号 + 数字。 */
function unoGlyph(c, card, x, y, w, k) {
  const t = Math.max(2, w / 16)
  const r = w * 0.22
  if (card.kind === 'skip') {
    c.circle(x, y, r, k, t)
    c.line(x - r * 0.7, y + r * 0.7, x + r * 0.7, y - r * 0.7, k, t)
  } else if (card.kind === 'reverse') {
    const dy = r * 0.45
    const hd = r * 0.5
    c.line(x - r, y - dy, x + r, y - dy, k, t)
    c.line(x + r, y - dy, x + r - hd, y - dy - hd, k, t)
    c.line(x - r, y + dy, x + r, y + dy, k, t)
    c.line(x - r, y + dy, x - r + hd, y + dy + hd, k, t)
  } else if (card.kind === 'draw2' || card.kind === 'wild4') {
    const s = Math.max(3, w / 14)
    c.line(x - 6 - s, y, x - 6 + s, y, k, t)
    c.line(x - 6, y - s, x - 6, y + s, k, t)
    c.text(card.kind === 'draw2' ? '2' : '4', x + 6, y, k)
  } else if (card.kind === 'wild') {
    // 点阵字没有 W，画成折线
    const hw = r * 0.9
    const hh = r * 0.6
    c.line(x - hw, y - hh, x - hw / 2, y + hh, k, t)
    c.line(x - hw / 2, y + hh, x, y - hh * 0.2, k, t)
    c.line(x, y - hh * 0.2, x + hw / 2, y + hh, k, t)
    c.line(x + hw / 2, y + hh, x + hw, y - hh, k, t)
  } else {
    c.text(String(card.text || '').replace(/[^0-9A-Za-z]/g, ''), x, y, k)
  }
}

/** 牌身已画好后，画 UNO 牌面：手里的万能牌是米色底 + 四色轮；打出的万能牌按所选颜色，左上角留小四色轮。 */
function unoDecor(c, card, cx, cy, w, h) {
  const tone = TONE[card.tone] || ''
  if (card.wild && !tone) {
    unoGlyph(c, card, cx, cy - h * 0.2, w, INK)
    wheel(c, cx, cy + h * 0.17, w * 0.26)
    return
  }
  if (card.wild) wheel(c, cx - w * 0.28, cy - h * 0.33, Math.max(4, w * 0.12))
  unoGlyph(c, card, cx, cy, w, card.tone === 'y' ? INK : CREAM)
}

/** 斗地主：点数在上、花色在下；王只写 JOKER（分两行，点阵宽度放不下一行）。 */
function ddzDecor(c, card, cx, cy, w, h) {
  const k = card.color === 'red' ? RED : INK
  if (card.pip === 'J') {
    c.text('JO', cx, cy - h * 0.2, k)
    c.text('KER', cx, cy - h * 0.2 + 14, k)
    c.circle(cx, cy + h * 0.22, Math.max(3, w * 0.13), k)
    return
  }
  c.text(String(card.text || '').replace(/[^0-9A-Za-z]/g, ''), cx, cy - h * 0.2, k)
  pip(c, card.pip, cx, cy + h * 0.15, w / 64)
}


const WIDTH = 760
const HEIGHT = 560
const ROOM = '#08281a'
const RIM = '#3b2a1a'
const SOFT = '#d7ecdf'
const LIGHT = '#f4efe4'

function ellipse(c, cx, cy, rx, ry, color) {
  const col = rgb(color)
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const dy = (y + 0.5 - cy) / ry
    if (Math.abs(dy) > 1) continue
    const half = rx * Math.sqrt(1 - dy * dy)
    const x0 = cx - half
    const x1 = cx + half
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const a = Math.min(1, Math.max(0, Math.min(x + 1 - x0, x1 - x)))
      if (a > 0) c.blend(x, y, col, a)
    }
  }
}

/** 以中心 (cx, cy)、角度 deg 画一张旋转的牌身（底色 + 描边；牌背加格纹）。 */
function rotCard(c, cx, cy, w, h, deg, fill, edge, back) {
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const ex = Math.abs(w / 2 * cos) + Math.abs(h / 2 * sin) + 1
  const ey = Math.abs(w / 2 * sin) + Math.abs(h / 2 * cos) + 1
  const f = rgb(fill)
  const e = rgb(edge)
  const g = rgb(GOLD, 0.55)
  for (let y = Math.floor(cy - ey); y <= Math.ceil(cy + ey); y++) {
    for (let x = Math.floor(cx - ex); x <= Math.ceil(cx + ex); x++) {
      const px = x + 0.5 - cx
      const py = y + 0.5 - cy
      const u = px * cos + py * sin
      const v = -px * sin + py * cos
      const inside = Math.min(w / 2 - Math.abs(u), h / 2 - Math.abs(v))
      const cover = Math.min(1, Math.max(0, inside + 0.5))
      if (cover <= 0) continue
      if (inside < 1.6) c.blend(x, y, e, cover)
      else if (back && inside > 4 && (Math.floor((u + w) / 5) + Math.floor((v + h) / 5)) % 2 === 0) c.blend(x, y, g, 1)
      else c.blend(x, y, f, cover)
    }
  }
}

function faceLabel(card) {
  if (card.suit) return String(card.code || '').replace(/[SHDC]$/, '')
  return String(card.text || card.code || '').replace(/[^0-9A-Za-z]/g, '')
}

/** 扇形里的一张牌：牌身随扇形旋转，点数文字保持正向，落在旋转后的牌面上半部。 */
function fanCard(c, cx, cy, w, h, deg, card) {
  if (!card || card.hidden === true) {
    rotCard(c, cx, cy, w, h, deg, BACK, GOLD, true)
    return
  }
  const tone = !card.suit && TONE[card.tone] ? TONE[card.tone] : ''
  rotCard(c, cx, cy, w, h, deg, tone || CREAM, INK, false)
  if (card.kind) {
    unoDecor(c, card, cx, cy, w, h)
    return
  }
  if (card.pip) {
    ddzDecor(c, card, cx, cy, w, h)
    return
  }
  const red = card.suit === 'H' || card.suit === 'D'
  const ink = tone ? CREAM : red ? RED : INK
  const a = (deg * Math.PI) / 180
  const off = -h * 0.22
  const tx = cx - Math.sin(a) * off
  const ty = cy + Math.cos(a) * off
  c.text(faceLabel(card), tx, ty, ink)
  if (card.suit) {
    const off2 = h * 0.14
    pip(c, card.suit, cx - Math.sin(a) * off2, cy + Math.cos(a) * off2, w / 64)
  }
}

/** 座位标签：左为座位代号，右为浅色底上的张数（或点数）。点阵没有空格字形，两段分开画。 */
function badge(c, label, value, cx, cy) {
  const lw = String(label).length * 10 + 10
  const vw = String(value).length * 10 + 10
  const left = cx - (lw + vw) / 2
  c.fillRect(left, cy - 10, lw + vw, 20, '#10241a')
  c.fillRect(left + lw, cy - 10, vw, 20, CREAM)
  c.text(String(label), left + lw / 2, cy, LIGHT)
  c.text(String(value), left + lw + vw / 2, cy, INK)
}

/** 队伍色（牌桌图固定深色底）：第 1 队蓝、第 2 队橙、第 3 队紫。 */
const TEAM = ['#2f6fd6', '#d9822b', '#8e5bd1']

/** 队伍标签：彩色底上写 T1 / T2 / T3，放在座位标签左侧。 */
function teamTag(c, team, rightX, cy) {
  if (typeof team !== 'number') return
  const text = `T${team + 1}`
  const w = text.length * 10 + 10
  c.fillRect(rightX - w - 4, cy - 10, w, 20, TEAM[team % TEAM.length])
  c.text(text, rightX - 4 - w / 2, cy, LIGHT)
}

function badgeLeft(label, value, cx) {
  const lw = String(label).length * 10 + 10
  const vw = String(value).length * 10 + 10
  return cx - (lw + vw) / 2
}

function seatFan(c, seat, cx, cy) {
  const backs = seat.cards.length ? seat.cards : Array.from({ length: Math.min(seat.count || 0, 12) }, () => ({ hidden: true }))
  const shown = backs.slice(0, 20)
  const faces = shown.some((card) => card && card.hidden !== true)
  const w = faces ? 34 : 22
  const h = Math.round(w * 1.4)
  const fan = fanLayout(shown.length, faces ? 150 : 120, w, faces ? 30 : 8, faces ? 24 : 50, 8)
  fan.forEach((p, i) => fanCard(c, cx - (faces ? 75 : 60) + p.x + w / 2, cy + p.y, w, h, p.rot, shown[i]))
  const value = seat.score !== '' && seat.score !== undefined ? seat.score : seat.count
  badge(c, seat.label, value, cx, cy - h / 2 - 16)
  teamTag(c, seat.team, badgeLeft(seat.label, value, cx), cy - h / 2 - 16)
}

function renderSeats(view) {
  const layout = cardTableLayout(view)
  const c = new Canvas(WIDTH, HEIGHT, ROOM)
  const cx = WIDTH / 2
  const cy = 222
  const rx = 330
  const ry = 180
  ellipse(c, cx, cy, rx + 10, ry + 10, RIM)
  ellipse(c, cx, cy, rx, ry, FELT)
  c.text(view.mark || (view.game === 'blackjack' ? '21' : 'CARD'), cx, 24, LIGHT)

  // 对手：沿椭圆内侧顺时针排布
  for (const seat of layout.opponents) {
    const sx = Math.max(76, Math.min(WIDTH - 76, cx + seat.x * (rx - 78)))
    const sy = Math.max(68, cy + seat.y * (ry - 52))
    seatFan(c, seat, sx, sy)
  }

  // 桌心：当前牌 / 公共牌 / 底牌
  const groups = layout.center.filter((g) => g.cards.length)
  if (groups.length) {
    const cw = 44
    const ch = Math.round(cw * 1.4)
    const widths = groups.map((g) => g.cards.length * (cw + 6) - 6)
    const total = widths.reduce((s, x) => s + x, 0) + 24 * (groups.length - 1)
    let x = cx - total / 2
    groups.forEach((g, gi) => {
      c.text(g.label, x + widths[gi] / 2, cy - ch / 2 - 14, SOFT)
      g.cards.forEach((card, i) => paintCard(c, x + i * (cw + 6), cy - ch / 2 + 6, cw, ch, card))
      x += widths[gi] + 24
    })
  }

  // 玩家手牌：最下方扇形
  const hand = layout.me.cards.slice(0, 40)
  const hw = 52
  const hh = Math.round(hw * 1.4)
  const fan = fanLayout(hand.length, WIDTH - 60, hw, 42, 40, 16)
  const base = HEIGHT - hh / 2 - 26
  fan.forEach((p, i) => fanCard(c, 30 + p.x + hw / 2, base + p.y, hw, hh, p.rot, hand[i]))
  const meValue = layout.me.score !== '' ? layout.me.score : hand.length
  badge(c, layout.me.label, meValue, cx, base - hh / 2 - 18)
  teamTag(c, layout.me.team, badgeLeft(layout.me.label, meValue, cx), base - hh / 2 - 18)
  return { png: c.toPng(), width: WIDTH, height: HEIGHT }
}

export function renderTable(view) {
  return renderSeats(view || {})
}
