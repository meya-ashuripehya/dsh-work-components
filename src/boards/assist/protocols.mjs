/**
 * 引擎输出解析（纯函数，便于用模拟进程测试）。
 * 胜率一律为「轮到走棋的一方」视角，0–100。
 */

/** UCI `info ... multipv k score cp|mate n [wdl w d l] ... pv m1 m2 ...`。不是这类行时返回 null。 */
export function parseUciInfo(line) {
  const s = String(line || '').trim()
  if (!s.startsWith('info ') || !/\spv\s/.test(s) || /\scurrmove\s/.test(s)) return null
  const tok = s.split(/\s+/)
  const out = { multipv: 1, depth: 0, cp: null, mate: null, wdl: null, bound: null, pv: [] }
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i]
    if (t === 'depth') out.depth = Number(tok[++i]) || 0
    else if (t === 'multipv') out.multipv = Number(tok[++i]) || 1
    else if (t === 'score') {
      const kind = tok[++i]
      const val = Number(tok[++i])
      if (kind === 'cp') out.cp = val
      else if (kind === 'mate') out.mate = val
      if (tok[i + 1] === 'lowerbound' || tok[i + 1] === 'upperbound') out.bound = tok[++i]
    } else if (t === 'wdl') {
      out.wdl = { win: Number(tok[i + 1]), draw: Number(tok[i + 2]), loss: Number(tok[i + 3]) }
      i += 3
    } else if (t === 'pv') {
      out.pv = tok.slice(i + 1)
      break
    }
  }
  if (!out.pv.length) return null
  return out
}

/** UCI 一行信息的胜率（含和棋一半）：优先 WDL，其次 mate，再按 cp 近似。 */
export function uciWinrate(info) {
  if (info.wdl && [info.wdl.win, info.wdl.draw, info.wdl.loss].every(Number.isFinite)) {
    const total = info.wdl.win + info.wdl.draw + info.wdl.loss || 1000
    return round1(((info.wdl.win + info.wdl.draw / 2) / total) * 100)
  }
  if (info.mate != null) return info.mate > 0 ? 100 : 0
  if (info.cp != null) return round1(100 / (1 + Math.exp(-info.cp / 250)))
  return null
}

/** 收集一次搜索的 multipv 结果：每个序号保留最新且最深的一行。 */
export function createUciCollector() {
  const lines = new Map()
  return {
    push(line) {
      const info = parseUciInfo(line)
      if (!info) return false
      const prev = lines.get(info.multipv)
      if (!prev || info.depth >= prev.depth) lines.set(info.multipv, info)
      return true
    },
    top(n = 3) {
      return [...lines.values()].sort((a, b) => a.multipv - b.multipv).slice(0, n).map((info) => ({
        move: info.pv[0],
        pv: info.pv.slice(0, 8),
        depth: info.depth,
        winrate: uciWinrate(info),
        ...(info.cp != null ? { cp: info.cp } : {}),
        ...(info.mate != null ? { mate: info.mate } : {}),
        ...(info.wdl ? { wdl: info.wdl } : {}),
      }))
    },
  }
}

// ---- Rapfi（piskvork / Gomocup 协议，message_mode = "ucilike"） ----

const RAPFI_MATE = 19000

/** `MESSAGE depth 13-21 multipv 3 ev 416 n 27K ... pv J7 J8 ...`。ev 也可能是 +M5 / -M4 之类。 */
export function parseRapfiMessage(line) {
  const s = String(line || '').trim()
  if (!/^MESSAGE\s/i.test(s)) return null
  const m = /\bdepth\s+(\d+)(?:-\d+)?\b(?:.*?\bmultipv\s+(\d+)\b)?.*?\bev\s+([+-]?M?\d+)\b.*?\bpv\s+(.+)$/i.exec(s)
  if (!m) return null
  const pv = m[4].trim().split(/\s+/).filter((t) => /^[A-Z]\d{1,2}$/i.test(t))
  if (!pv.length) return null
  return { depth: Number(m[1]), multipv: Number(m[2] || 1), ev: m[3], pv }
}

/** Rapfi 评估值 → 胜率：mate 记 100/0，其余按 Rapfi 默认 ScalingFactor 200 的 logistic。 */
export function rapfiWinrate(ev) {
  const s = String(ev)
  const mate = /^([+-]?)M(\d+)$/i.exec(s)
  if (mate) return mate[1] === '-' ? 0 : 100
  const v = Number(s)
  if (!Number.isFinite(v)) return null
  if (v >= RAPFI_MATE) return 100
  if (v <= -RAPFI_MATE) return 0
  return round1(100 / (1 + Math.exp(-v / 200)))
}

/** Rapfi 坐标（字母 = x 列，数字 = y + 1）就是本插件五子棋的 H8 写法（列字母 + 行号）。 */
export function rapfiBestmove(line) {
  const m = /^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/.exec(String(line || ''))
  if (!m) return null
  return String.fromCharCode(65 + Number(m[1])) + String(Number(m[2]) + 1)
}

export function createRapfiCollector() {
  const lines = new Map()
  return {
    push(line) {
      const info = parseRapfiMessage(line)
      if (!info) return false
      const prev = lines.get(info.multipv)
      if (!prev || info.depth >= prev.depth) lines.set(info.multipv, info)
      return true
    },
    top(n = 3) {
      return [...lines.values()].sort((a, b) => a.multipv - b.multipv).slice(0, n).map((info) => ({
        move: info.pv[0].toUpperCase(),
        pv: info.pv.slice(0, 8).map((t) => t.toUpperCase()),
        depth: info.depth,
        winrate: rapfiWinrate(info.ev),
        eval: info.ev,
      }))
    },
  }
}

// ---- KataGo analysis engine（一行一个 JSON） ----

/** 解析一行 KataGo 回应；不是该 id 的结果（或报错 / 警告）时返回 null 或 { error }。 */
export function parseKatagoResponse(line, id) {
  let data
  try { data = JSON.parse(String(line || '')) } catch { return null }
  if (!data || typeof data !== 'object') return null
  if (id && data.id !== id) return null
  if (data.error) return { error: String(data.error) }
  if (!Array.isArray(data.moveInfos)) return null
  if (data.isDuringSearch) return null
  const infos = data.moveInfos.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return {
    root: data.rootInfo ? { winrate: pct(data.rootInfo.winrate), scoreLead: round1(data.rootInfo.scoreLead), visits: data.rootInfo.visits } : null,
    moves: infos.map((m) => ({
      move: String(m.move || ''),
      pv: Array.isArray(m.pv) ? m.pv.slice(0, 8) : [],
      visits: m.visits,
      winrate: pct(m.winrate),
      scoreLead: round1(m.scoreLead),
    })),
  }
}

function pct(v) {
  return Number.isFinite(v) ? round1(v * 100) : null
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null
}
