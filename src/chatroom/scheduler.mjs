import { hiddenFromAi } from './card-bin.mjs'
/**
 * 任务调度（纯状态机，不做 I/O）：
 *   - 用户的一条新消息 = 一个任务。主答：消息里最先提到的成员（@ 或直接写名字），否则默认主答（DeepSeek）。
 *   - 主答发言后，其余 AI 依次轮询是否补充（可 [PASS]）；一整圈全部 PASS 即结束。
 *     有人补充时再轮一圈（主答也在圈里，但不会连续两次发言）。
 *   - 交棒：某 AI 指定下一位 → 下一位插到队首；当前圈其余顺序不变。
 *   - 预算：每个任务共 budget（默认 10）个 AI 发言回合，PASS 也算一回合（它占用一次生成）。
 *     用尽 → 状态 'budget'（只给所有者一条系统提示，AI 看不到预算）；所有者「批准 +N」后 budget += N 并继续。
 *   - 任何时刻只有一个槽位在生成（next() 只在上一个 record() 之后给出下一位）。
 */
export const DEFAULT_BUDGET = 10

export function createTask({ id, seats, mainId, budget = DEFAULT_BUDGET, basedOn = 0 }) {
  const order = seats.filter((s) => s.enabled !== false).map((s) => s.id)
  const main = order.includes(mainId) ? mainId : order[0]
  return {
    id, main, order, budget: Math.max(1, budget), used: 0, state: order.length ? 'running' : 'done',
    queue: main ? [main] : [], phase: 'main', roundSpoke: false, roundSeen: [], last: null, basedOn,
    turns: {}, // seatId → 次数
  }
}

function others(task) {
  const i = task.order.indexOf(task.main)
  const rot = [...task.order.slice(i + 1), ...task.order.slice(0, i)]
  return rot
}

/** 下一位发言者 seatId；无 → null（任务结束 / 等待预算）。 */
export function nextSpeaker(task) {
  if (task.state !== 'running') return null
  if (task.used >= task.budget) { task.state = 'budget'; return null }
  while (task.queue.length && !task.order.includes(task.queue[0])) task.queue.shift()
  if (!task.queue.length) {
    if (task.phase === 'main') { task.phase = 'poll'; task.queue = others(task); task.roundSpoke = false; task.roundSeen = [] }
    else if (task.roundSpoke) {
      // 有人补充 → 再一圈（包括主答），但不让刚发言的人连续发言
      const next = [task.main, ...others(task)].filter((id) => id !== task.last)
      task.queue = next; task.roundSpoke = false; task.roundSeen = []
    } else { task.state = 'done'; return null }
    if (!task.queue.length) { task.state = 'done'; return null }
  }
  return task.queue[0]
}

/**
 * 记录一次发言结果。outcome: 'spoke' | 'pass' | 'error' | 'dropped'
 * handoffTo: 交棒目标 seatId（可选）。
 */
export function recordTurn(task, seatId, outcome, { handoffTo, counted = true } = {}) {
  if (task.queue[0] === seatId) task.queue.shift()
  else task.queue = task.queue.filter((x) => x !== seatId)
  if (counted) { task.used++; task.turns[seatId] = (task.turns[seatId] || 0) + 1 }
  if (outcome === 'spoke') { task.roundSpoke = true; task.last = seatId }
  task.roundSeen.push(seatId)
  if (handoffTo && handoffTo !== seatId && task.order.includes(handoffTo)) {
    if (task.phase === 'main') {
      // 主答交棒：被点名者先说，其余人照常轮询
      task.phase = 'poll'
      task.queue = [handoffTo, ...others(task).filter((x) => x !== handoffTo)]
      task.roundSpoke = false
      task.roundSeen = []
    } else {
      task.queue = [handoffTo, ...task.queue.filter((x) => x !== handoffTo)]
      task.roundSpoke = true
    }
  }
  if (task.used >= task.budget && task.state === 'running') task.state = 'budget'
  return task
}

/** 所有者批准 +N：追加预算并恢复。 */
export function extendBudget(task, n) {
  task.budget += Math.max(1, Number(n) || 0)
  if (task.state === 'budget') {
    task.state = 'running'
    if (!task.queue.length) { task.queue = [task.main, ...others(task)].filter((id) => id !== task.last); task.phase = 'poll'; task.roundSpoke = false }
  }
  return task
}

/** @ 提及改主答（任务中途 @ 不会打断，只改主答身份并让其插队）。 */
export function setMain(task, seatId) {
  if (!task.order.includes(seatId)) return task
  task.main = seatId
  task.queue = [seatId, ...task.queue.filter((x) => x !== seatId)]
  return task
}

/**
 * 过时判断：生成基于 basedOn（房间最后一条消息 seq），现在房间里新到的消息 fresh。
 * → 'fresh'（无新消息）| 'review'（只有 AI / 工具消息：让该 AI 选择发送 / 修改 / 撤回）| 'redirect'（有新用户消息：丢弃，转向最新）
 */
export function staleness(basedOn, messages, selfId) {
  const fresh = (messages || []).filter((m) => (m.seq || 0) > basedOn && !((m.kind === 'seat' || m.kind === 'tool') && m.speaker?.id === selfId))
  const visible = fresh.filter((m) => m.status !== 'pass' && m.status !== 'dropped' && m.kind !== 'system' && !hiddenFromAi(m))
  if (!visible.length) return { verdict: 'fresh', fresh: [] }
  if (visible.some((m) => m.kind === 'user')) return { verdict: 'redirect', fresh: visible }
  return { verdict: 'review', fresh: visible }
}
