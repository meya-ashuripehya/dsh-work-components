/**
 * 主持人：房间是唯一的事实来源，所有消息（用户、各 AI、工具输出）先写进房间，再转发 Telegram。
 *   - 用户新消息 = 新任务；主答默认 DeepSeek，@ 某 AI 则由它主答。主答后其余 AI 依次轮询是否补充（可静默 PASS），
 *     AI 可交棒（[[NEXT: X]] / 「交给 X」），见 ./scheduler.mjs。同一房间任何时刻只有一个槽位在生成。
 *   - 预算：每任务合计 budget 个 AI 回合；用尽 → 主答汇报（进度、未决问题、各 AI 还需回合数），
 *     所有者回复「批准 +N」后继续。
 *   - 过时：每次生成记下基于的房间消息 seq；写入前若有新消息：只有 AI / 工具消息 → 让该 AI 选择 SEND / REVISE / DROP；
 *     有新用户消息 → 丢弃草稿，转向最新消息（新任务）。
 *   - cursor_handoff：领队（GPT）提交任务书 → 房间记录 + 待执行；所有者回复「执行」后运行 cursor-agent，结果 JSON 写回房间。
 * 依赖全部注入，不碰 UI、设置结构与网络细节。
 */
import { buildPrompt } from './transcript.mjs'
import { PASS_TOKEN, isPass, stripSelfPrefix, parseHandoff, parseMention, parseOwnerCommand, parseCursorDirective, parseStaleDecision, findSeat } from './directives.mjs'
import { createTask, nextSpeaker, recordTurn, extendBudget, setMain, staleness } from './scheduler.mjs'
import { CURSOR_TOOL, CURSOR_TOOL_NAME, normalizeHandoffArgs, jsonSafe, toolSummaryLine, cursorDeeplink } from './cursor.mjs'

const noopTg = { typing: () => () => {}, relay: async () => [] }

export function createModerator({ store, getRoomConfig, resolvePersona = () => '', call, emit = () => {}, tg = noopTg, runCursor, now = () => Date.now() }) {
  const runs = new Map() // roomId → { controller, seatId, promise, pendingUser }
  const tasks = new Map() // roomId → task
  const cursorRuns = new Map() // roomId → { controller, briefId }
  let taskSeq = 0

  function status(roomId) {
    const r = runs.get(roomId)
    const t = tasks.get(roomId)
    const c = cursorRuns.get(roomId)
    return {
      running: !!r, seatId: r?.seatId || null,
      task: t ? { id: t.id, main: t.main, used: t.used, budget: t.budget, state: t.state, turns: t.turns } : null,
      cursor: c ? { briefId: c.briefId } : null,
    }
  }

  async function appendAndEmit(roomId, msg, { relay = true, relaySeat, prefixName } = {}) {
    const saved = await store.append(roomId, msg)
    emit(roomId, { type: 'message', message: saved })
    if (relay) {
      const text = saved.kind === 'tool' ? toolSummaryLine(saved) : saved.text
      void Promise.resolve(tg.relay(relaySeat || null, roomId, text, { prefixName: prefixName || saved.speaker?.name })).catch(() => {})
    }
    return saved
  }
  const system = (roomId, text, extra = {}) => appendAndEmit(roomId, { kind: 'system', speaker: { id: 'system', name: '聊天室' }, text, ...extra }, { relay: extra.relay !== false, prefixName: '聊天室' })

  async function promptFor(roomId, seat, cfg, task, extraUser) {
    let presetPersona = ''
    if (seat.preset) presetPersona = String(await resolvePersona(seat) || '')
    const main = cfg.seats.find((s) => s.id === task?.main)
    const turnInfo = task ? `Task turn budget: ${task.used}/${task.budget} AI turns used.` : ''
    return buildPrompt({ seat: { ...seat, presetPersona }, seats: cfg.seats, userName: cfg.userName, rules: cfg.rules, messages: await store.readMessages(roomId), maxHistory: cfg.maxHistory || 0, mainName: main?.name, turnInfo, extraUser })
  }

  async function generate(roomId, seat, cfg, controller, task, { extraUser, tools, maxTokens } = {}) {
    const prompt = await promptFor(roomId, seat, cfg, task, extraUser)
    const stopTyping = tg.typing(seat, roomId)
    try {
      return await call({ seat, prompt, maxTokens: maxTokens || cfg.maxTokens || 1024, signal: controller.signal, tools, onDelta: (text) => emit(roomId, { type: 'delta', seatId: seat.id, text }) })
    } finally { try { stopTyping() } catch {} }
  }

  /** 把 cursor_handoff 调用（原生或回退写法）变成待执行的任务书。 */
  async function submitBrief(roomId, seat, rawArgs, cfg) {
    const h = normalizeHandoffArgs(rawArgs, { defaultRepo: cfg.cursorRepo })
    if (h.error) {
      return appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: seat.id, name: seat.name }, text: 'invalid cursor_handoff call', data: jsonSafe({ ok: false, status: 'invalid', error: h.error }), status: 'ok' }, { relay: false })
    }
    const briefId = 'b' + now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4)
    await store.patchMeta(roomId, (m) => { m.briefs = { ...(m.briefs || {}), [briefId]: { ...h, status: 'awaiting_owner', by: seat.id, at: new Date(now()).toISOString() } }; m.pendingBrief = briefId })
    await appendAndEmit(roomId, { kind: 'brief', briefId, briefStatus: 'awaiting_owner', action: h.action, repo: h.repo, title: h.title, speaker: { id: seat.id, name: seat.name }, text: h.brief, deeplink: cursorDeeplink(h.brief) }, { relay: false })
    return appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: seat.id, name: seat.name }, text: `任务书 #${briefId} 已提交，等待 ${cfg.userName} 回复「执行」`, data: jsonSafe({ ok: true, status: 'awaiting_owner', briefId, action: h.action, title: h.title, repo: h.repo }), status: 'ok' }, { relaySeat: seat })
  }

  /** 一个 AI 回合。返回 { outcome: 'spoke'|'pass'|'error'|'dropped'|'redirect'|'stopped', handoffTo?, counted } */
  async function speak(roomId, seat, cfg, controller, task) {
    const run = runs.get(roomId)
    if (run) run.seatId = seat.id
    emit(roomId, { type: 'turn', seatId: seat.id, name: seat.name, model: seat.model, task: task.id })
    const base = { kind: 'seat', speaker: { id: seat.id, name: seat.name }, provider: seat.provider, model: seat.model, task: task.id }
    const basedOn = await store.lastSeq(roomId)
    let out
    try {
      out = await generate(roomId, seat, cfg, controller, task, { tools: seat.leader && runCursor ? [CURSOR_TOOL] : undefined })
    } catch (e) {
      if (controller.signal.aborted || e?.aborted) {
        const partial = String(e?.partial?.text || '').trim()
        await appendAndEmit(roomId, { ...base, text: partial, status: 'stopped', basedOn, usage: e?.partial?.usage }, { relay: false })
        return { outcome: 'stopped' }
      }
      await appendAndEmit(roomId, { ...base, text: '', status: 'error', basedOn, error: String(e?.message || e) }, { relay: false })
      return { outcome: 'error' }
    }
    let text = stripSelfPrefix(String(out.text || ''), seat.name).trim()
    const directive = parseCursorDirective(text)
    const toolCalls = (out.toolCalls || []).filter((c) => c.name === CURSOR_TOOL_NAME)
    if (directive) text = directive.text
    // 过时检查
    const fresh = staleness(basedOn, await store.readMessages(roomId), seat.id)
    if (fresh.verdict === 'redirect' || (run && run.pendingUser)) {
      await appendAndEmit(roomId, { ...base, text, status: 'dropped', basedOn, reason: 'new user message', usage: out.usage }, { relay: false })
      return { outcome: 'redirect', counted: false }
    }
    if (fresh.verdict === 'review' && (text && !isPass(text))) {
      const ask = `New messages arrived in the room after you started drafting (shown above). Your unsent draft was:\n<<<\n${text}\n>>>\nReply with exactly one of: SEND (post the draft as is), DROP (discard it), or REVISE: <new message>.`
      try {
        const r = await generate(roomId, seat, cfg, controller, task, { extraUser: ask, maxTokens: Math.min(cfg.maxTokens || 1024, 1024) })
        const d = parseStaleDecision(r.text)
        if (d.action === 'drop') { await appendAndEmit(roomId, { ...base, text, status: 'dropped', basedOn, reason: 'stale, dropped by speaker' }, { relay: false }); return { outcome: 'dropped' } }
        if (d.action === 'revise') text = stripSelfPrefix(d.text, seat.name).trim()
      } catch (e) {
        if (controller.signal.aborted || e?.aborted) return { outcome: 'stopped' }
      }
    }
    if (isPass(text) && !toolCalls.length && !directive?.args) {
      await appendAndEmit(roomId, { ...base, text: PASS_TOKEN, status: 'pass', basedOn, usage: out.usage }, { relay: false })
      return { outcome: 'pass' }
    }
    const handoff = parseHandoff(text, cfg.seats.filter((s) => s.enabled !== false), seat.id)
    text = handoff.text
    if (text && !isPass(text)) await appendAndEmit(roomId, { ...base, text, status: 'ok', basedOn, usage: out.usage, ...(handoff.seat ? { handoffTo: handoff.seat.id } : {}) }, { relaySeat: seat })
    for (const tc of toolCalls) await submitBrief(roomId, seat, tc.arguments, cfg)
    if (directive?.args) await submitBrief(roomId, seat, directive.args, cfg)
    else if (directive && directive.error) await submitBrief(roomId, seat, '{bad', cfg)
    return { outcome: 'spoke', handoffTo: handoff.seat?.id }
  }

  async function budgetReport(roomId, cfg, controller, task) {
    const seat = cfg.seats.find((s) => s.id === task.main)
    if (!seat) return
    const ask = `The task's turn budget is used up (${task.used}/${task.budget} AI turns). As the main answerer, write a short report to ${cfg.userName}: 1) progress so far, 2) open questions, 3) estimated additional turns needed per AI (e.g. "GPT 2, Claude 1"). End by asking ${cfg.userName} to reply 「批准 +N」 to continue. Do not PASS.`
    try {
      const out = await generate(roomId, seat, cfg, controller, task, { extraUser: ask })
      const text = stripSelfPrefix(String(out.text || ''), seat.name).trim() || '本任务的回合预算已用完。'
      await appendAndEmit(roomId, { kind: 'seat', speaker: { id: seat.id, name: seat.name }, provider: seat.provider, model: seat.model, task: task.id, text, status: 'ok', budgetReport: true, usage: out.usage }, { relaySeat: seat })
    } catch (e) {
      if (!(controller.signal.aborted || e?.aborted)) await system(roomId, `回合预算已用完（${task.used}/${task.budget}）。回复「批准 +N」可继续。`)
    }
  }

  function newTask(cfg, message) {
    const enabled = cfg.seats.filter((s) => s.enabled !== false)
    const mention = parseMention(message.text, enabled)
    const def = findSeat(enabled, cfg.defaultMain) || enabled.find((s) => /deepseek/i.test(s.provider + s.name + s.id)) || enabled[0]
    return createTask({ id: `t${++taskSeq}-${message.seq}`, seats: enabled, mainId: (mention || def)?.id, budget: cfg.budget || 10, basedOn: message.seq })
  }

  /** 房间循环：一次只跑一个槽位，直到任务完成 / 等预算 / 停止。 */
  function ensureLoop(roomId) {
    if (runs.has(roomId)) return runs.get(roomId).promise
    const controller = new AbortController()
    const run = { controller, seatId: null, promise: null, pendingUser: null }
    runs.set(roomId, run)
    run.promise = (async () => {
      let reason = 'done'
      emit(roomId, { type: 'run', running: true })
      try {
        await store.getRoom(roomId)
        for (;;) {
          if (controller.signal.aborted) { reason = 'stopped'; break }
          const cfg = await getRoomConfig()
          if (run.pendingUser) {
            const msg = run.pendingUser
            run.pendingUser = null
            const prev = tasks.get(roomId)
            if (prev && prev.state === 'running') prev.state = 'superseded'
            const t = newTask(cfg, msg)
            tasks.set(roomId, t)
            emit(roomId, { type: 'task', task: status(roomId).task })
          }
          const task = tasks.get(roomId)
          if (!task) { reason = 'idle'; break }
          const id = nextSpeaker(task)
          if (!id) {
            if (task.state === 'budget' && !task.reported) { task.reported = true; await budgetReport(roomId, cfg, controller, task); reason = 'budget' }
            else reason = task.state
            if (!run.pendingUser) break
            continue
          }
          const seat = cfg.seats.find((s) => s.id === id)
          if (!seat) { recordTurn(task, id, 'error', { counted: false }); continue }
          let got
          try { got = await speak(roomId, seat, cfg, controller, task) } catch (e) {
            await appendAndEmit(roomId, { kind: 'seat', speaker: { id: seat.id, name: seat.name }, text: '', status: 'error', error: String(e?.message || e) }, { relay: false })
            got = { outcome: 'error' }
          }
          if (got.outcome === 'stopped') { reason = 'stopped'; break }
          if (got.outcome === 'redirect') continue
          recordTurn(task, id, got.outcome, { handoffTo: got.handoffTo, counted: got.counted !== false })
          emit(roomId, { type: 'task', task: status(roomId).task })
        }
      } catch (e) {
        reason = 'error'
        emit(roomId, { type: 'error', error: String(e?.message || e) })
      } finally {
        runs.delete(roomId)
        emit(roomId, { type: 'run', running: false, reason })
      }
      return reason
    })()
    return run.promise
  }

  /**
   * 用户发言。owner：是否为所有者（本机桌面端，或 Telegram 用户 ID 等于设置里的所有者 ID）。
   * source：'local' | 'telegram'。本地消息同时经接收机器人转发到绑定群。
   */
  async function post(roomId, text, { userName, owner = false, source = 'local', fromId, run = true } = {}) {
    const t = String(text || '').trim()
    if (!t) throw Object.assign(new Error('消息不能为空'), { status: 400 })
    const cfg = await getRoomConfig()
    const message = await appendAndEmit(roomId, { kind: 'user', speaker: { id: source === 'telegram' ? `tg:${fromId}` : 'user', name: userName || cfg.userName }, owner: !!owner, source, text: t.slice(0, 20000) }, { relay: source === 'local', prefixName: userName || cfg.userName })
    const cmd = parseOwnerCommand(t)
    if (cmd) {
      if (!owner) { await system(roomId, `只有 ${cfg.userName} 可以${cmd.kind === 'approve' ? '批准追加回合' : '执行 Cursor 任务'}。`); return { message, started: false } }
      if (cmd.kind === 'approve') {
        const task = tasks.get(roomId)
        if (!task || (task.state !== 'budget' && task.state !== 'running')) { await system(roomId, '当前没有等待追加回合的任务。'); return { message, started: false } }
        extendBudget(task, cmd.n)
        task.reported = false
        await system(roomId, `已追加 ${cmd.n} 个回合（${task.used}/${task.budget}）。`)
        const p = run ? ensureLoop(roomId) : null
        return { message, started: !!p, promise: p }
      }
      if (cmd.kind === 'execute') { const p = executeBrief(roomId, cmd.briefId); return { message, started: false, cursor: p } }
      if (cmd.kind === 'cancel') { const ok = await cancelBrief(roomId); return { message, started: false, cancelled: ok } }
    }
    if (!run) return { message, started: false }
    const r = runs.get(roomId)
    if (r) {
      // @ 中途改主答：只改身份并插队，流程继续；否则作为新任务（进行中的草稿会被丢弃并转向）
      const task = tasks.get(roomId)
      r.pendingUser = message
      return { message, started: false, redirected: !!task, promise: r.promise }
    }
    const p = ensureLoop(roomId) // 循环的第一步在下一个微任务之后才读 pendingUser
    runs.get(roomId).pendingUser = message
    return { message, started: true, promise: p }
  }

  /** 让指定成员 / 继续当前任务（界面「继续」）。 */
  function start(roomId, { seatIds } = {}) {
    if (runs.has(roomId)) return false
    const task = tasks.get(roomId)
    if (seatIds?.length && task) { setMain(task, seatIds[0]); if (task.state !== 'running') { task.state = 'running'; if (task.used >= task.budget) task.budget = task.used + 1 } }
    if (!task) return false
    if (task.state === 'done') { task.state = 'running' }
    return ensureLoop(roomId)
  }

  async function cancelBrief(roomId) {
    const meta = await store.getRoom(roomId)
    const id = meta.pendingBrief
    if (!id) { await system(roomId, '没有待执行的任务书。'); return false }
    await store.patchMeta(roomId, (m) => { if (m.briefs?.[id]) m.briefs[id].status = 'cancelled'; m.pendingBrief = undefined })
    await system(roomId, `任务书 #${id} 已取消。`)
    return true
  }

  /** 所有者「执行」：运行最新（或指定）的待执行任务书。 */
  async function executeBrief(roomId, briefId) {
    const cfg = await getRoomConfig()
    if (!runCursor) { await system(roomId, '当前环境不支持运行 Cursor。'); return null }
    if (cursorRuns.has(roomId)) { await system(roomId, `Cursor 任务 #${cursorRuns.get(roomId).briefId} 仍在运行。`); return null }
    const meta = await store.getRoom(roomId)
    const id = briefId || meta.pendingBrief
    const b = id ? meta.briefs?.[id] : null
    if (!b || b.status !== 'awaiting_owner') { await system(roomId, id ? `任务书 #${id} 不在待执行状态。` : '没有待执行的任务书。'); return null }
    const controller = new AbortController()
    cursorRuns.set(roomId, { controller, briefId: id })
    await store.patchMeta(roomId, (m) => { m.briefs[id].status = 'running'; m.pendingBrief = undefined })
    const leader = cfg.seats.find((s) => s.id === b.by) || null
    await appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: 'cursor', name: 'Cursor' }, text: `开始执行任务书 #${id}`, data: jsonSafe({ ok: true, status: 'running', briefId: id, title: b.title, repo: b.repo, action: b.action }), status: 'ok' }, { relaySeat: leader })
    emit(roomId, { type: 'cursor', running: true, briefId: id })
    let lastRelay = 0
    const pending = []
    const result = await runCursor(b, {
      signal: controller.signal,
      onProgress: (p) => {
        emit(roomId, { type: 'cursor-progress', briefId: id, ...p })
        if (p.kind !== 'tool') return
        pending.push(p.text)
        if (now() - lastRelay > 20000) { lastRelay = now(); const line = `⏳ Cursor #${id}：${pending.splice(0).slice(-3).join('；')}`.slice(0, 300); void Promise.resolve(tg.relay(leader, roomId, line, { prefixName: 'Cursor' })).catch(() => {}) }
      },
    }).catch((e) => ({ ok: false, status: 'error', error: String(e?.message || e) }))
    cursorRuns.delete(roomId)
    const data = jsonSafe({ ...result, briefId: id })
    await store.patchMeta(roomId, (m) => { m.briefs[id].status = data.status; m.briefs[id].sessionId = data.sessionId || ''; m.lastCursorSession = data.sessionId || m.lastCursorSession })
    const msg = await appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: 'cursor', name: 'Cursor' }, text: `任务书 #${id} ${data.status === 'success' ? '执行完成' : '执行结束：' + data.status}`, data, status: 'ok' }, { relaySeat: leader })
    emit(roomId, { type: 'cursor', running: false, briefId: id, status: data.status })
    return msg
  }

  function stop(roomId) {
    let any = false
    const r = runs.get(roomId)
    if (r) { r.controller.abort(); any = true }
    const c = cursorRuns.get(roomId)
    if (c) { c.controller.abort(); any = true }
    return any
  }

  async function stopAll() {
    const ps = [...runs.values()].map((r) => { r.controller.abort(); return r.promise })
    for (const c of cursorRuns.values()) c.controller.abort()
    await Promise.allSettled(ps)
  }

  return { post, start, stop, stopAll, status, executeBrief, cancelBrief, tasks }
}
