/** 着法文字的识别与归一（Telegram 文字走子、board_play 共用）。 */
const CN_DIGITS = '一二三四五六七八九'
const RED = { car: '车', horse: '马', ele: '相', adv: '士', king: '帅', cannon: '炮', pawn: '兵' }
const BLACK = { car: '車', horse: '馬', ele: '象', adv: '仕', king: '将', cannon: '砲', pawn: '卒' }
const KIND = {
  车: 'car', 車: 'car', 俥: 'car', 马: 'horse', 馬: 'horse', 傌: 'horse', 相: 'ele', 象: 'ele',
  士: 'adv', 仕: 'adv', 帅: 'king', 帥: 'king', 将: 'king', 將: 'king', 炮: 'cannon', 砲: 'cannon', 包: 'cannon',
  兵: 'pawn', 卒: 'pawn',
}
const PIECE = '车車俥马馬傌相象士仕帅帥将將炮砲包兵卒'
const NUM = '1-9一二三四五六七八九'
const XQ_LABEL = new RegExp(`^(?:[前后中][${PIECE}]|[${PIECE}][${NUM}])[进退平][${NUM}]$`)

/** 只去掉首尾空白与开头的 @机器人 提及。 */
export function cleanMoveText(text) {
  return String(text ?? '').replace(/^\s*(@\w+\s*)+/, '').trim()
}

/** 文字看起来像不像这盘棋的一步（决定非法时是否回「这步不在合法着法里」，还是当普通聊天放过）。 */
export function looksLikeMove(game, text) {
  const t = cleanMoveText(text)
  if (!t || t.length > 12) return false
  if (game === 'chess') return /^[a-h][1-8]\s*-?\s*[a-h][1-8][qrbn]?$/i.test(t)
  if (game === 'gomoku') return /^[a-o](1[0-5]|[1-9])$/i.test(t)
  if (game === 'go') return /^([a-hj-z](1[0-9]|[1-9]|2[0-5])|pass|停着|停一手)$/i.test(t)
  if (game === 'xiangqi') return XQ_LABEL.test(t) || /^\d,\d-\d,\d$/.test(t)
  return false
}

const LEAD_SEP = '[\\s,，:：、]+'
const LEAD_MOVE = {
  chess: '[a-h][1-8]\\s*-?\\s*[a-h][1-8][qrbn]?',
  gomoku: '[a-o](?:1[0-5]|[1-9])',
  // 围棋混合消息里不认 pass / 停着，免得「pass 一下」之类被当成停一手。
  go: '[a-hj-z](?:2[0-5]|1[0-9]|[1-9])',
  xiangqi: `(?:[前后中][${PIECE}]|[${PIECE}][${NUM}])[进退平][${NUM}]|\\d,\\d-\\d,\\d`,
}

/**
 * 「着法 + 一句话」：只认开头的一步，后面必须用逗号 / 中文逗号 / 空格 / 冒号 / 顿号 / 换行隔开，且还有别的文字。
 * 例：「H9,Deepseek准备怎么下？」「炮二平五 你觉得呢」。返回 { move, rest } 或 null（整句就是一步时也返回 null）。
 */
export function splitLeadingMove(game, text) {
  const body = LEAD_MOVE[game]
  if (!body) return null
  const t = cleanMoveText(text)
  const m = t.match(new RegExp(`^(${body})${LEAD_SEP}(\\S[\\s\\S]*)$`, 'i'))
  if (!m) return null
  const move = m[1].trim()
  const rest = m[2].trim()
  if (!rest || !looksLikeMove(game, move)) return null
  return { move, rest }
}

/** 归一到引擎认的写法：象棋中文数字→阿拉伯数字、棋子字按行棋方换成引擎用字；国际象棋去掉连字符。 */
export function normalizeMove(game, text, turnSide) {
  let t = cleanMoveText(text)
  if (game === 'chess') return t.toLowerCase().replace(/[\s-]+/g, '')
  if (game === 'go' && /^(停着|停一手)$/.test(t)) return 'pass'
  if (game !== 'xiangqi') return t
  const set = turnSide === 'black' ? BLACK : RED
  t = t.replace(/[一二三四五六七八九]/g, (d) => String(CN_DIGITS.indexOf(d) + 1))
  return [...t].map((ch) => (KIND[ch] ? set[KIND[ch]] : ch)).join('')
}

/** 红方习惯用中文数字记谱（炮二平五），黑方用阿拉伯数字。 */
export function displayMove(game, label, side) {
  const s = String(label ?? '')
  if (game === 'go' && s.toLowerCase() === 'pass') return '停着'
  if (game === 'xiangqi' && side === 'red') return s.replace(/[1-9]/g, (d) => CN_DIGITS[Number(d) - 1])
  return s
}
