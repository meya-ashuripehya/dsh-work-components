/**
 * 辅助引擎进程：每个棋种一个长驻子进程，按 stdin/stdout 文本协议通信。
 * 任何错误（起不来、崩溃、超时、输出不对）都只让本次分析返回 null，并结束该进程；下次需要时再重启。
 */
import { spawn } from 'node:child_process'
import { availableParallelism, cpus } from 'node:os'
import { createRapfiCollector, createUciCollector, parseKatagoResponse, rapfiBestmove } from './protocols.mjs'

function threadCount() {
  let n = 2
  try { n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length } catch { /* ignore */ }
  return Math.max(1, Math.min(4, Math.floor(n / 2) || 1))
}

/** 子进程的按行读写。spawnImpl 可替换（测试用模拟进程）。 */
export class LineProcess {
  constructor(command, args, { cwd, spawnImpl = spawn } = {}) {
    this.dead = false
    this.waiters = new Set()
    this.listeners = new Set()
    this.partial = ''
    this.exited = new Promise((resolve) => { this.onExit = resolve })
    this.child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout?.on('data', (buf) => this.onData(buf))
    this.child.stderr?.on('data', () => { /* 引擎日志，忽略 */ })
    this.child.stdin?.on('error', () => this.markDead('stdin'))
    this.child.on('error', () => { this.markDead('error'); this.onExit() })
    this.child.on('exit', () => { this.markDead('exit'); this.onExit() })
    // 长驻引擎不拖住宿主退出：子进程与管道都 unref（搜索中的计时器仍会让事件循环等结果）
    try { this.child.unref?.() } catch { /* ignore */ }
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr]) { try { s?.unref?.() } catch { /* ignore */ } }
  }

  onData(buf) {
    const parts = (this.partial + buf.toString('utf8')).split(/\r?\n/)
    this.partial = parts.pop()
    for (const line of parts) {
      if (!line.trim()) continue
      for (const fn of [...this.listeners]) { try { fn(line) } catch { /* ignore */ } }
      for (const w of [...this.waiters]) {
        let hit = false
        try { hit = w.test(line) } catch { hit = false }
        if (hit) { this.waiters.delete(w); clearTimeout(w.timer); w.resolve(line) }
      }
    }
  }

  markDead(why) {
    if (this.dead) return
    this.dead = true
    for (const w of [...this.waiters]) { clearTimeout(w.timer); w.reject(new Error(`engine ${why}`)) }
    this.waiters.clear()
  }

  send(line) {
    if (this.dead) throw new Error('engine dead')
    this.child.stdin.write(line + '\n')
  }

  waitFor(test, timeoutMs) {
    if (this.dead) return Promise.reject(new Error('engine dead'))
    return new Promise((resolve, reject) => {
      const w = { test, resolve, reject, timer: null }
      w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error('engine timeout')) }, timeoutMs)
      this.waiters.add(w)
    })
  }

  onLine(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  kill() {
    this.markDead('killed')
    try { this.child.stdin?.end() } catch { /* ignore */ }
    try { this.child.kill() } catch { /* ignore */ }
  }
}

/** 串行队列：同一进程一次只做一件事。 */
function serial() {
  let tail = Promise.resolve()
  return (fn) => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => {})
    return next
  }
}

class BaseEngine {
  constructor(opts) {
    this.opts = opts
    this.proc = null
    this.ready = null
    this.queue = serial()
  }

  get alive() { return Boolean(this.proc && !this.proc.dead) }

  spawnProc(command, args, cwd) {
    return new LineProcess(command, args, { cwd, spawnImpl: this.opts.spawnImpl })
  }

  ensure() {
    if (this.proc && this.proc.dead) { this.proc = null; this.ready = null }
    if (!this.ready) {
      this.ready = this.start().catch((error) => { this.dispose(); throw error })
    }
    return this.ready
  }

  /** 分析一次；失败返回 null，不抛错。 */
  analyze(position, ms) {
    return this.queue(async () => {
      try {
        await this.ensure()
        return await this.search(position, ms)
      } catch {
        this.dispose()
        return null
      }
    })
  }

  /** 结束进程；返回的 Promise 在进程退出后（最多等 3 秒）完成。 */
  dispose() {
    const proc = this.proc
    this.proc = null
    this.ready = null
    if (!proc) return Promise.resolve()
    try { if (!proc.dead) this.quit(proc) } catch { /* ignore */ }
    proc.kill()
    return Promise.race([proc.exited, new Promise((r) => setTimeout(r, 3000))])
  }

  quit() {}
}

/** UCI：Pikafish / Stockfish。position 为 FEN。 */
export class UciEngine extends BaseEngine {
  async start() {
    const { command, args = [], cwd, options = {} } = this.opts
    this.proc = this.spawnProc(command, args, cwd)
    const p = this.proc
    p.send('uci')
    await p.waitFor((l) => l.trim() === 'uciok', 15000)
    const all = { Threads: threadCount(), Hash: 64, MultiPV: 3, UCI_ShowWDL: 'true', ...options }
    for (const [k, v] of Object.entries(all)) p.send(`setoption name ${k} value ${v}`)
    p.send('isready')
    await p.waitFor((l) => l.trim() === 'readyok', 30000)
  }

  async search(fen, ms) {
    const p = this.proc
    const col = createUciCollector()
    const off = p.onLine((l) => col.push(l))
    try {
      p.send(`position fen ${fen}`)
      p.send(`go movetime ${Math.max(50, ms | 0)}`)
      const best = await p.waitFor((l) => /^bestmove\s/.test(l), ms + 10000)
      if (/^bestmove\s+\(none\)/.test(best)) return []
      return col.top(3)
    } finally { off() }
  }

  quit(p) { p.send('quit') }
}

/** Rapfi：piskvork / Gomocup 协议，配合 YXBOARD + YXNBEST 取前几名。position = { size, rule, stones: [{x,y}]（按落子顺序） }。 */
export class RapfiEngine extends BaseEngine {
  async start() {
    const { command, args = [], cwd } = this.opts
    this.proc = this.spawnProc(command, args, cwd)
    const p = this.proc
    p.send(`START ${this.opts.size || 15}`)
    const ok = await p.waitFor((l) => /^(OK|ERROR)\b/i.test(l.trim()), 30000)
    if (!/^OK/i.test(ok.trim())) throw new Error('rapfi start failed')
    p.send(`INFO rule ${this.opts.rule ?? 0}`)
    p.send(`INFO thread_num ${threadCount()}`)
  }

  async search(position, ms) {
    const p = this.proc
    const col = createRapfiCollector()
    const off = p.onLine((l) => col.push(l))
    try {
      p.send(`INFO timeout_turn ${Math.max(50, ms | 0)}`)
      p.send('YXBOARD')
      const stones = position.stones || []
      stones.forEach((s, i) => {
        // 最后一手所属方 = 对方；与轮到走棋的一方同色记 1，否则 2
        const own = (stones.length - i) % 2 === 0
        p.send(`${s.x},${s.y},${own ? 1 : 2}`)
      })
      p.send('DONE')
      p.send('YXNBEST 3')
      const best = await p.waitFor((l) => rapfiBestmove(l) != null || /^ERROR\b/i.test(l.trim()), ms + 10000)
      if (/^ERROR/i.test(best.trim())) return null
      const top = col.top(3)
      if (!top.length) return [{ move: rapfiBestmove(best), pv: [], winrate: null }]
      return top
    } finally { off() }
  }

  quit(p) { p.send('END') }
}

/** KataGo analysis engine：一行 JSON 查询、一行 JSON 回应。position = 查询对象（不含 id）。 */
export class KatagoEngine extends BaseEngine {
  constructor(opts) {
    super(opts)
    this.seq = 0
  }

  async start() {
    const { command, args = [], cwd } = this.opts
    this.proc = this.spawnProc(command, args, cwd)
    // 先发一个空查询确认模型已加载（Eigen 首次加载可能要十几秒）
    const id = `warm${++this.seq}`
    this.proc.send(JSON.stringify({ id, moves: [], rules: 'chinese', komi: 7.5, boardXSize: 9, boardYSize: 9, maxVisits: 1 }))
    await this.proc.waitFor((l) => l.includes(`"${id}"`), 90000)
  }

  async search(query, ms) {
    const p = this.proc
    const id = `q${++this.seq}`
    const body = { ...query, id, maxVisits: 1000000, overrideSettings: { ...(query.overrideSettings || {}), maxTime: Math.max(0.05, ms / 1000) } }
    p.send(JSON.stringify(body))
    const line = await p.waitFor((l) => {
      const r = parseKatagoResponse(l, id)
      return r != null
    }, ms + 15000)
    const res = parseKatagoResponse(line, id)
    if (!res || res.error) return null
    return res.moves.slice(0, 3).map((m) => ({ ...m, rootWinrate: res.root?.winrate ?? null }))
  }
}
