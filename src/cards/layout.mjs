/**
 * 牌桌座位布局：页面与 Telegram 牌桌图共用。
 * 玩家固定在下方，对手从左侧经上方到右侧按顺时针均匀排布（1–9 名）。
 * 只整理公开局面：暗牌只保留 hidden（与公开的 count / name），不读取点数、花色或编码。
 * 本函数会以 toString() 原样内联进牌桌页面脚本，须保持自包含、仅用 ES5 语法。
 */
export function cardTableLayout(view) {
  function clean(card) {
    if (!card || card.hidden === true) {
      var back = { hidden: true }
      if (card && typeof card.count === 'number') back.count = card.count
      if (card && typeof card.name === 'string') back.name = card.name
      if (card && typeof card.team === 'number') back.team = card.team
      if (card && typeof card.seat === 'number') back.seat = card.seat
      return back
    }
    return card
  }
  function list(cards) { return (cards || []).map(clean) }
  view = view || {}
  var rows
  if (view.game === 'blackjack' || (!view.rows && (view.dealer || view.player))) {
    rows = [
      { title: '庄家', label: 'D', cards: view.dealer || [], score: view.dealerScore },
      { title: '玩家', label: 'P', cards: view.player || [], score: view.playerScore },
    ]
  } else {
    rows = view.rows || []
  }
  var me = null
  var opponents = []
  var center = []
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r] || {}
    var cards = list(row.cards)
    var label = String(row.label || '')
    var score = row.score === undefined || row.score === null ? '' : String(row.score)
    if ((label === 'H' || label === 'P') && !me) {
      me = { title: row.title || '你', label: label, cards: cards, score: score }
      if (typeof row.team === 'number') me.team = row.team
      continue
    }
    if (label === 'T' || label === 'BD') {
      center.push({ title: row.title || '', label: label, cards: cards })
      continue
    }
    var counted = cards.length > 0
    for (var k = 0; k < cards.length; k++) if (!(cards[k].hidden && typeof cards[k].count === 'number')) counted = false
    if (counted) {
      // 多人 UNO：一张牌背代表一名对手，只带张数与座位名
      for (var s = 0; s < cards.length; s++) {
        var seatNo = typeof cards[s].seat === 'number' ? cards[s].seat : s + 1
        var opp = { title: cards[s].name || ('对手 ' + seatNo), label: 'A' + seatNo, count: cards[s].count, cards: [], score: '' }
        if (typeof cards[s].team === 'number') opp.team = cards[s].team
        opponents.push(opp)
      }
    } else {
      var other = { title: row.title || '对手', label: label || 'A', count: cards.length, cards: cards, score: score }
      if (typeof row.team === 'number') other.team = row.team
      opponents.push(other)
    }
  }
  if (!me) me = { title: '你', label: 'H', cards: [], score: '' }
  var n = opponents.length
  for (var i = 0; i < n; i++) {
    // 屏幕坐标 y 向下：90° 为正下方（玩家），角度递增即左 → 上 → 右，视觉上为顺时针。
    var deg = 90 + (i + 1) * 360 / (n + 1)
    var rad = deg * Math.PI / 180
    opponents[i].angle = deg
    opponents[i].x = Math.round(Math.cos(rad) * 1000) / 1000
    opponents[i].y = Math.round(Math.sin(rad) * 1000) / 1000
  }
  return { me: me, opponents: opponents, center: center }
}

/**
 * 扇形排布：n 张宽 cardW 的牌放进 width 宽度内。返回每张的左上 x、弧形下沉 y 与旋转角（度）。
 * 间距不超过 maxStep，放不下时自动收紧，总宽不超过 width。
 */
export function fanLayout(n, width, cardW, maxStep, maxSpread, depth) {
  var out = []
  if (n <= 0) return out
  var step = n > 1 ? Math.min(maxStep, Math.max(1, (width - cardW) / (n - 1))) : 0
  var total = step * (n - 1) + cardW
  var spread = Math.min(maxSpread, n * 5)
  var sink = Math.min(depth, depth * (total / Math.max(width, 1)) + 2)
  for (var i = 0; i < n; i++) {
    var t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0
    out.push({ x: (width - total) / 2 + i * step, y: t * t * sink, rot: t * spread / 2 })
  }
  return out
}
