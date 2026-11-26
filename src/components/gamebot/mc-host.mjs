/** Independent per-seat Minecraft control. Room history is context, never a scheduler. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ensureClaimKey } from './minecraft-work/store.mjs'
import { signClaim } from './minecraft-work/sign.mjs'
import { callSeat } from '../../chatroom/providers.mjs'
import { createDshCatalog } from '../../dsh-catalog.mjs'
import { readRoomMemory } from '../../chatroom/read-context.mjs'
import { applyDecision, controlArguments, controlSystemPrompt, controlTools, createMcControl } from './mc-control.mjs'
import { classifyChat, createMirror, stripRolePrefix } from './mc-mirror.mjs'
import { createSeatQueues } from './mc-public-channel.mjs'
import { boundedCall, compactControlHistory, createWorldMemory, observationContext } from './mc-memory.mjs'
import { verifyWorldAction } from './mc-action-verification.mjs'
import { activeTask, presentTask, updateFreshness, taskEvent } from './mc-runtime-state.mjs'
import { modelForSeat } from './mc-profile.mjs'
import { ensureControlSession, mountControlGuards, resolveControlSession, writeControlTurn } from './mc-session.mjs'
import { memberIdsFor, memberNamesFor, memberRequest, reconcileMembers } from './members.mjs'

export function createMcControlHost({ ctx, getConfig, store, roomId, dataRoot, llm, log,
  now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  fetchImpl, callModel = callSeat, taskDecisionIntervalMs = 60000 } = {}) {
  const taskInterval = Math.max(15000, Number(taskDecisionIntervalMs) || 60000)
  const claimKey = dataRoot?.() ? ensureClaimKey(join(dataRoot(), 'minecraft-work')) : null
  const sessionIds = new Set(), handles = new Map(), states = new Map()
  const seatQueues = createSeatQueues(), memory = createWorldMemory(dataRoot)
  const catalog = createDshCatalog(ctx)
  let timer, unmountGuards, polling = false, reconciling = false, nextReconcile = 0, epoch = 0
  const file = () => join(dataRoot?.() || '', 'minecraft-control-sessions.json')
  let sessions = {}
  try { sessions = JSON.parse(readFileSync(file(), 'utf8')).sessions || {} } catch {}
  const stateOf = (id) => { if (!states.has(id)) states.set(id, { world: null, joined: false, lastSpoke: -Infinity, failures: new Map() }); return states.get(id) }
  function trace(event, fields = {}) {
    const row = { ts: new Date(now()).toISOString(), event, ...fields }
    try { log?.info?.(`dsh-workbench: mc-control ${event}`, fields) } catch {}
    try {
      if (dataRoot?.()) { mkdirSync(dataRoot(), { recursive: true }); writeFileSync(join(dataRoot(), 'minecraft-control-trace.jsonl'), JSON.stringify(row) + '\n', { flag: 'a' }) }
    } catch {}
  }
  const mirror = createMirror({ now, cooldownMs: 0, append: async (item) => {
    const id = String(roomId?.() || '').trim()
    if (!id || !store?.append) return
    await store.append(id, {
      kind: item.kind === 'bystander' ? 'user' : 'seat',
      speaker: { id: item.kind === 'bystander' ? 'user' : item.memberId, name: item.name || item.player || item.memberId || '玩家' },
      ...(item.kind === 'bystander' ? { owner: true } : { provider: '', model: '' }),
      source: 'minecraft', via: 'mc-mirror', mcMessageId: item.id, text: stripRolePrefix(item.text || ''),
    })
  } })
  function scoped(item, world) { return { ...item, id: `${world}:${item.memberId || item.player || ''}:${item.id}` } }
  function publish(id) {
    const state = stateOf(id), view = control.view(id)
    if (!state.world || !view) return
    void memberRequest(getConfig(), `/v1/minecraft/members/${encodeURIComponent(id)}/autonomy`, { fetchImpl, method: 'POST', timeoutMs: 3000,
      body: { world_id: state.world, state: view.busy ? (state.phase || 'thinking') : view.state, lastDecisionAt: view.lastDecisionAt, deadline: view.deadline,
        lastAction: state.lastAction || null, lastResult: state.lastResult || null, lastError: view.lastError || (state.lastError ? '成员控制异常，请查看工作台' : null),
        task: presentTask(state.task, state.stalled) || null, observationStalled: !!state.stalled, lastSnapshotAt: state.lastAdvanceAt ?? null, modelCalls: state.modelCalls || 0 },
    }).catch(() => {})
  }
  function directed(item, id) {
    const name = memberNamesFor(getConfig?.() || {})[id] || id
    return item.audience === 'private' || item.target === id || item.target === name || [id, name].some((s) => s && item.text?.toLowerCase().includes(s.toLowerCase()))
  }
  function enqueue(item, world, onlyId) {
    const event = scoped(item, world)
    for (const sid of onlyId ? [onlyId] : control.connectedIds()) {
      if (stateOf(sid).world !== world || item.memberId === sid) continue
      if (!seatQueues.enqueue(sid, { ...event, priority: directed(item, sid) })) continue
      if (directed(item, sid)) control.note(sid, { id: event.id }, { delayMs: 0 })
    }
  }
  const control = createMcControl({ now, async runTurn(turn) {
    const cfg = getConfig?.() || {}, id = turn.memberId, state = stateOf(id), world = state.world
    const started = now()
    let focus, applied, stage = 'observe'
    const path = `/v1/minecraft/members/${encodeURIComponent(id)}`
    const request = (suffix, options = {}) => memberRequest(cfg, path + suffix, { fetchImpl, signal: turn.signal, ...options })
    const current = () => turn.current() && !state.stalled && state.world === world && state.joined && getConfig?.()?.['gamebot-minecraftEnabled'] === true && memberIdsFor(getConfig()).includes(id)
    try {
      const model = await modelForSeat(cfg, id, dataRoot?.())
      if (model.error) throw new Error(model.error)
      const preset = cfg.chatroomSeats?.find((s) => s.id === id)?.preset
      if (preset) model.persona = [await catalog.presetPersona(preset), model.persona].filter(Boolean).join('\n')
      const obs = await request('/observe', { timeoutMs: 8000 })
      if (!updateFreshness(state, obs, now())) { control.suspendWorld(id); return { stale: true } }
      if (!current()) return { stale: true }
      if (!world || obs.extras?.world_id !== world || !obs.extras?.joined || !obs.connected) throw new Error('世界或成员状态已改变，等待重新连接')
      const tools = controlTools(obs)
      trace('observe.done', { memberId: id, world_id: world, elapsedMs: now() - started })
      focus = seatQueues.activateNext(id)
      if (focus) focus.processing = true
      const privateTurn = focus?.audience === 'private'
      const room = await readRoomMemory(store, String(roomId?.() || '')).catch(() => ({ summary: '', messages: [] }))
      const pending = seatQueues.view(id)?.pending || []
      const gameMessages = [focus, ...pending].filter((m) => m && m.audience !== 'private').slice(0, 24)
      const eventIds = new Set(gameMessages.map((m) => m.id))
      if (focus) eventIds.add(focus.id)
      room.messages = room.messages.filter((m) => !eventIds.has(m.id))
      const history = compactControlHistory(memory.get(world, id))
      const lastSeen = memory.perceive(world, id, obs.extras?.minecraft?.player?.dimension, obs.extras?.minecraft?.points_of_interest)
      const taskEvents = [...(state.pendingTaskEvents || [])]
      const inspection = state.inspection || null
      const cooldowns = [...state.failures.entries()].filter(([, v]) => v.until > now()).map(([key, v]) => ({ action: key, until: v.until }))
      trace('runTurn.start', { memberId: id, world_id: world, private: !!privateTurn, reason: turn.reason })
      state.phase = 'thinking'; publish(id)
      const modelStarted = now()
      state.modelCalls = (state.modelCalls || 0) + 1
      stage = 'model'
      const decision = await boundedCall((signal) => callModel({
        seat: { name: model.name || id, provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) },
        prompt: { system: controlSystemPrompt(null, model.persona, focus, state.task).replace('普通自主决策约每60秒一次', `普通自主决策约每${taskInterval / 1000}秒一次`), messages: [{ role: 'user', content: JSON.stringify({
          observation: observationContext(obs), memory: history, room, cooldowns, game_messages: gameMessages,
          task_events: taskEvents, last_seen_points: lastSeen, inspection,
          spontaneous_speech_ready: now() - state.lastSpoke >= 20000,
          previous_execution: state.executionFeedback || null,
        }) }] }, tools, llm: typeof llm === 'function' ? llm() : llm, signal,
      }), turn.signal)
      trace('model.done', { memberId: id, world_id: world, elapsedMs: now() - modelStarted,
        usage: decision.usage, modelCalls: state.modelCalls, task_id: state.task?.task_id,
        toolsOffered: tools.map((tool) => tool.name), toolsRequested: (decision.toolCalls || []).map((call) => tools.some((tool) => tool.name === call.name) ? call.name : 'unsupported') })
      if (!current()) return { stale: true }
      const fresh = await request('/observe', { timeoutMs: 4000 })
      if (!updateFreshness(state, fresh, now()) || fresh.extras?.world_id !== world || fresh.extras?.minecraft?.player?.dimension !== obs.extras?.minecraft?.player?.dimension) {
        control.suspendWorld(id); return { stale: true }
      }
      stage = 'execute'
      applied = await applyDecision(decision, {
        tools, current, markSelf: turn.markSelf,
        act: async (params, action) => {
          if (!current()) return { ok: false, stale: true }
          if (action === 'say') {
            if (privateTurn) params = { ...params, audience: 'private', target: focus.speaker || focus.player || focus.name }
            const response = focus && (focus.kind === 'bystander' || directed(focus, id))
            const fingerprint = createHash('sha256').update(JSON.stringify([params.audience || 'public', params.target || '', stripRolePrefix(params.text || '').normalize('NFKC').replace(/\s+/g, '').trim()])).digest('hex')
            const previous = state.lastSpeech
            const freshPlayerMessage = focus && (focus.kind === 'bystander' || focus.audience === 'private') && previous?.focusId !== focus.id
            if (previous?.fingerprint === fingerprint && now() - previous.at < 60000 && !freshPlayerMessage) {
              trace('speech.suppressed', { memberId: id, world_id: world, reason: 'duplicate_speech' })
              return { ok: true, suppressed: true, reason: 'duplicate_speech' }
            }
            if (!response && now() - state.lastSpoke < 20000) return { ok: false, error: '主动发言冷却中' }
          }
          const key = JSON.stringify([action, params.x ?? params.pos?.x, params.y ?? params.pos?.y, params.z ?? params.pos?.z, params.uuid || params.target_agent_id, params.center?.x, params.center?.y, params.center?.z, params.radius, params.item_id, params.count, params.block_id || params.expected_block])
          const roomTaskId = room.messages.filter((message) => message.source !== 'minecraft').at(-1)?.id || ''
          const dropKey = JSON.stringify([params.item_id, params.count, roomTaskId])
          if (action === 'drop_item') {
            const previous = state.completedDrops?.get(dropKey)
            const newPlayerRequest = focus && (focus.kind === 'bystander' || focus.audience === 'private') && focus.id !== previous?.focusId
            if (previous && !newPlayerRequest && params.additional_drop !== true) {
              trace('action.suppressed', { memberId: id, world_id: world, action, reason: 'drop_already_completed' })
              return { ok: true, verified: true, alreadyCompleted: true, verification: { reason: 'drop_already_completed' } }
            }
          }
          const failed = state.failures.get(key)
          if (action !== 'say' && failed?.until > now()) return { ok: false, error: '相同目标动作冷却60秒，请换目标或等待' }
          if (action === 'move_to') params = { ...params, arrival_tolerance: 1.5 }
          if (['break_block', 'place_block'].includes(action)) {
            if (activeTask(state.task)) return { ok: false, error: '请先 stop_task，再执行方块操作' }
            if (action === 'place_block') params = { ...params, auto_move: false }
            if (!claimKey || !['x', 'y', 'z'].every((key) => Number.isInteger(params.pos?.[key]))) return { ok: false, error: '挖掘需要有效方块坐标及宿主签名' }
            params = { ...params, claim: signClaim({ mid: id, pid: `autonomy:${world}`, tid: randomUUID(), bv: 0,
              gen: turn.generation + 1, exp: Math.floor(now() / 1000) + 45, act: [action === 'break_block' ? 'break' : 'place'], cells: [params.pos] }, claimKey) }
          }
          const before = observationContext(obs)
          const actionStarted = now()
          state.phase = 'executing'; publish(id)
          const result = await request('/actions', { method: 'POST', body: { action, params: { ...params, world_id: world, dimension: before.dimension } }, timeoutMs: 35000 })
            .catch(() => ({ ok: false, error: '动作请求失败或结果不明，请重新观察', extras: { effect: 'unknown' } }))
          if (!current()) return { ok: false, stale: true }
          if (action === 'say') {
            if (result.ok) state.lastSpoke = now()
            await mirror.fromAction(id, result, model.name, world)
            if (result.ok && params.audience !== 'private') enqueue({ id: result.extras?.message_id || result.extras?.say_id || params.say_id, memberId: id, player: model.name, kind: 'say', audience: 'public', text: params.text }, world)
          } else if (['navigate_to', 'follow_entity', 'explore_area', 'stop_task', 'inspect_blocks'].includes(action)) {
            const evidence = result.extras?.evidence || {}
            if (evidence.task) state.task = evidence.task
            result.accepted = !!result.ok && !evidence.already_at_goal && ['navigate_to', 'follow_entity', 'explore_area'].includes(action)
            result.alreadyAtGoal = !!evidence.already_at_goal
            result.verified = action === 'stop_task' ? !!(result.ok && evidence.stopped) : result.ok ? null : false
            if (action === 'inspect_blocks' && result.ok) state.inspection = (evidence.visible_blocks || []).slice(0, 32)
            result.after = { task: state.task }
          } else {
            const verification = await verifyWorldAction({ action, params, before: obs, receipt: result, current,
              observe: () => request('/observe', { timeoutMs: 4000 }) })
            if (!current()) return { ok: false, stale: true }
            result.verified = verification.verified
            result.verification = { reason: verification.reason, distance: verification.distance }
            result.after = observationContext(verification.after)
            if (result.ok && !result.verified) { result.ok = false; result.error = `动作回执后尚未观察到确认结果：${verification.reason}` }
          }
          if (action !== 'say') {
            const count = result.ok ? 0 : (failed?.count || 0) + 1
            state.failures.set(key, { count, until: count >= 3 ? now() + 60000 : 0 })
          }
          if (action === 'drop_item' && result.ok && result.verified) {
            state.completedDrops ||= new Map(); state.completedDrops.set(dropKey, { focusId: focus?.id || null })
            while (state.completedDrops.size > 64) state.completedDrops.delete(state.completedDrops.keys().next().value)
          }
          if (action === 'say' && result.ok) state.lastSpeech = { fingerprint: createHash('sha256').update(JSON.stringify([params.audience || 'public', params.target || '', stripRolePrefix(params.text || '').normalize('NFKC').replace(/\s+/g, '').trim()])).digest('hex'), at: now(), focusId: focus?.id || null }
          trace('action.done', { memberId: id, world_id: world, action, ok: !!result.ok, verified: result.verified ?? null, verification: result.verification, elapsedMs: now() - actionStarted })
          return result
        },
      })
      if (!current()) return { stale: true }
      stage = 'finalize'
      state.lastError = null
      state.lastAction = applied.actions.at(-1)?.action || (applied.spoken.length ? 'say' : applied.waitMs != null ? 'wait' : 'idle')
      state.lastResult = { ok: [...applied.actions.map((a) => a.result), ...applied.spoken].every((r) => r.ok), verified: applied.actions.at(-1)?.result?.verified ?? null,
        speechSuppressed: applied.spoken.some((r) => r.suppressed),
        alreadyCompleted: applied.actions.at(-1)?.result?.alreadyCompleted || false,
        accepted: applied.actions.at(-1)?.result?.accepted || false, task: state.task || null,
        ...(state.lastAction === 'idle' ? { detail: '本轮未提交游戏操作，普通文本未发言或移动；默认间隔后重新观察' } : {}) }
      // Feedback contains no message text, target names or private arguments.
      state.executionFeedback = {
        action: state.lastAction, ok: state.lastResult.ok, accepted: state.lastResult.accepted,
        rejected_tools: applied.rejected.map((name) => tools.some((tool) => name === tool.name || name === `${tool.name}:invalid_arguments`) ? name : 'unsupported'),
        world_actions: applied.actions.map(({ action, params, result }) => ({ action, item_id: params.item_id, count: params.count, pos: params.pos, block_id: params.block_id,
          ok: !!result.ok, verified: result.verified === true, already_completed: !!result.alreadyCompleted, reason: result.verification?.reason })),
        speech: applied.spoken.map((result) => ({ ok: !!result.ok, reason: result.suppressed ? 'duplicate_speech' : result.ok ? null : result.error === '主动发言冷却中' ? 'spontaneous_speech_cooldown' : 'speech_failed' })),
        idle_without_task: !activeTask(state.task) && !applied.actions.length && applied.waitMs == null,
      }
      const containsPrivate = privateTurn || decision.toolCalls?.some((c) => c.name === 'say' && controlArguments(c.arguments)?.audience === 'private')
      if (!containsPrivate) memory.record(world, id, compactControlHistory({ history: [{ at: now(), goal: String(decision.text || '').slice(0, 1000), actions: applied.actions.map((a) => ({ action: a.action, params: a.params, ok: a.result.ok, accepted: a.result.accepted || false, error: a.result.error, after: a.result.after })), spoke: applied.spoken.some((r) => r.ok && !r.suppressed) }] }).history[0])
      const session = resolveControlSession(handles.get(id))
      if (session) {
        try { writeControlTurn(session, `${privateTurn ? '私聊回合（内容不记录）' : '自主回合'}：${state.lastAction}，${state.lastResult.alreadyCompleted ? '此前已完成，未重复执行' : state.lastResult.accepted ? '任务已接受，尚未完成' : state.lastResult.ok ? '操作完成' : '失败或未确认'}`) }
        catch { trace('session.write.error', { memberId: id, private: !!privateTurn }) }
      }
      if (focus) seatQueues.finish(id, 'done', gameMessages.map((m) => m.id))
      state.pendingTaskEvents = (state.pendingTaskEvents || []).filter((e) => !taskEvents.some((handled) => handled.id === e.id))
      if (state.inspection === inspection) state.inspection = null
      applied.nextDelayMs = activeTask(state.task) ? taskInterval : applied.waitMs ?? 15000
      if (seatQueues.view(id)?.pending?.some((m) => m.priority)) applied.nextDelayMs = 2000
      const error = applied.actions.find((a) => !a.result.ok)?.result?.error || applied.spoken.find((r) => !r.ok)?.error
      return { ...applied, ...(error ? { error } : {}) }
    } catch (error) {
      if (current()) state.lastError = focus?.audience === 'private' ? '私聊回合失败' : String(error?.message || error)
      if (focus) {
        const delivered = applied?.spoken?.some((r) => r.ok) || applied?.actions?.some((a) => a.result?.ok)
        if (delivered) seatQueues.finish(id, 'done')
        else { focus.processing = false; seatQueues.releaseActive(id) }
      }
      trace('runTurn.error', { memberId: id, world_id: world, private: focus?.audience === 'private', stage, errorType: error?.name || 'Error' })
      return { error: '决策或执行失败，请查看成员状态' }
    } finally { trace('runTurn.end', { memberId: id, world_id: world, elapsedMs: now() - started }) }
  } })
  async function onConnected(id, observation) {
    const cfg = getConfig?.() || {}
    if (!memberIdsFor(cfg).includes(id)) return
    const obs = observation || await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/observe`, { fetchImpl, timeoutMs: 4000 })
    const state = stateOf(id), world = obs.extras?.world_id
    if (!world) { state.lastError = '请更新 Minaret 模组：缺少世界 UUID'; return }
    if (!obs.connected || !obs.extras?.joined) return
    if (!obs.extras?.advertised?.includes('minecraft.task.navigate_to')) {
      if (control.view(id)?.connected) disconnect(id)
      state.lastError = '请更新 Minaret 模组：持续任务能力不可用，不启动小步高频决策'
      return
    }
    if (!controlTools(obs).some((tool) => tool.name !== 'wait')) {
      if (control.view(id)?.connected) disconnect(id)
      state.world = world; state.joined = true
      state.lastError = '等待模组声明游戏工具；暂不调用模型，请检查模组握手或重新连接'
      return
    }
    if (control.view(id)?.connected && state.world === world) return
    seatQueues.clear(id)
    state.world = world; state.joined = true; state.lastError = null; state.failures.clear(); state.lastSpoke = -Infinity
    state.lastSeq = null; state.lastGameTime = null; state.lastAdvanceAt = null; state.stalled = false; state.task = obs.extras?.minecraft?.task || null
    state.bridgeGeneration = null; state.recovering = false
    state.pendingTaskEvents = []; state.inspection = null; state.executionFeedback = null; state.lastSpeech = null; state.completedDrops = new Map()
    control.connect(id)
    try {
      const made = await ensureControlSession({ agents: ctx?.get?.('agents') || ctx?.agents, presets: ctx?.get?.('agentPresets') || ctx?.agentPresets, titles: ctx?.get?.('sessionTitle') || ctx?.sessionTitle, memberId: id, name: memberNamesFor(cfg)[id] || id, remembered: sessions, sessions: sessionIds })
      if (made.sessionId) {
        sessions[id] = made.sessionId
        if (dataRoot?.()) { mkdirSync(dataRoot(), { recursive: true }); writeFileSync(file(), JSON.stringify({ sessions })) }
        if (made.handle) handles.set(id, made.handle)
      }
    } catch {}
  }
  function disconnect(id) { control.disconnect(id); seatQueues.clear(id); stateOf(id).joined = false }
  async function poll() {
    if (polling || getConfig?.()?.['gamebot-minecraftEnabled'] !== true) return
    polling = true
    const version = epoch
    try {
      const cfg = getConfig?.() || {}, eligible = memberIdsFor(cfg)
      for (const id of control.connectedIds()) if (!eligible.includes(id)) disconnect(id)
      if (!reconciling && now() >= nextReconcile) {
        nextReconcile = now() + 5000
        reconciling = true
        void reconcileMembers(cfg, { fetchImpl }).catch(() => {}).finally(() => { reconciling = false })
      }
      const rows = await Promise.all(eligible.map(async (id) => {
        try { return { id, obs: await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/observe`, { fetchImpl, timeoutMs: 4000 }) } } catch { return { id, obs: null } }
      }))
      if (version !== epoch || getConfig?.()?.['gamebot-minecraftEnabled'] !== true) return
      for (const { id, obs } of rows) {
        const state = stateOf(id), world = obs?.extras?.world_id
        if (!obs?.connected || !obs?.extras?.joined || !world) {
          disconnect(id)
          if (obs?.connected && !world) state.lastError = '请更新 Minaret 模组：缺少世界 UUID'
          continue
        }
        if (state.world && state.world !== world) disconnect(id)
        await onConnected(id, obs)
        if (!control.view(id)?.connected) continue
        const running = updateFreshness(state, obs, now())
        state.task = obs.extras?.minecraft?.task || null
        if (running) control.resumeWorld(id)
        else control.suspendWorld(id)
        const terminal = taskEvent(state, state.task, world, obs.extras?.minecraft?.player?.dimension)
        if (terminal) { trace('task.terminal', { memberId: id, world_id: world, task: state.task }); (state.pendingTaskEvents ||= []).push(terminal); control.note(id, terminal, { delayMs: 0 }) }
        const taskTraceKey = JSON.stringify([state.task?.task_id, state.task?.state, state.task?.phase, state.task?.segments, state.task?.replans])
        if (taskTraceKey !== state.taskTraceKey) { state.taskTraceKey = taskTraceKey; trace('task.progress', { memberId: id, world_id: world, task: state.task, position: obs.position }) }
        for (const event of obs.recent_events || []) {
          const item = classifyChat(event)
          if (!item) continue
          await mirror.take(scoped(item, world)).catch(() => {})
          if (item.memberId === id) continue
          if (item.audience === 'private') enqueue(item, world, id)
          else enqueue(item, world)
        }
      }
      if (version === epoch) control.tick(now())
      for (const id of control.connectedIds()) publish(id)
    } finally { polling = false }
  }
  async function stop() {
    epoch++
    if (timer) clearIntervalImpl(timer)
    timer = null; nextReconcile = 0; seatQueues.clear(); control.stopAll()
    for (const state of states.values()) state.joined = false
  }
  return {
    async sync() {
      if (getConfig?.()?.['gamebot-minecraftEnabled'] !== true) return stop()
      if (!unmountGuards) unmountGuards = mountControlGuards(ctx, sessionIds)
      if (!timer) { timer = setIntervalImpl(() => { void poll().catch(() => trace('poll.error')) }, 1000); void poll().catch(() => {}) }
    }, poll, onConnected, onDisconnected: disconnect,
    async dispose() { await stop(); unmountGuards?.(); unmountGuards = null },
    blocksMember: (id) => control.blocksMember(id),
    async takeover(id) {
      const result = control.takeover(id)
      if (result.ok) await memberRequest(getConfig(), `/v1/minecraft/members/${encodeURIComponent(id)}/cancel`, { fetchImpl, method: 'POST', body: { target_request_id: '*', world_id: stateOf(id).world }, timeoutMs: 4000 })
      return result
    }, resume: (id) => control.resume(id),
    onSay: (id, result) => mirror.fromAction(id, result, memberNamesFor(getConfig?.() || {})[id] || id, stateOf(id).world),
    view: (id) => { const s = states.get(id), view = control.view(id); return { ...view, ...(view?.busy ? { state: s?.phase || 'thinking' } : {}), joined: s?.joined || false, world_id: s?.world || null, lastAction: s?.lastAction || null, lastResult: s?.lastResult || null, task: presentTask(s?.task, s?.stalled) || null, observationStalled: !!s?.stalled, lastSnapshotAt: s?.lastAdvanceAt ?? null, modelCalls: s?.modelCalls || 0, detail: s?.stalled ? '世界观察停滞，等待两份推进的新快照' : s?.lastError || null } },
    publicView: () => seatQueues.view(), seatQueueView: (id) => seatQueues.view(id),
  }
}
