/**
 * 把控制会话、发言镜像和世界重连探活接到工作台。
 * 聊天室心跳 / end_round 不调用这里。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callSeat } from '../../chatroom/providers.mjs'
import { applyDecision, controlSystemPrompt, createMcControl, IDLE_MS, SAY_TOOL } from './mc-control.mjs'
import { classifyChat, createMirror, stripRolePrefix } from './mc-mirror.mjs'
import { createSeatQueues } from './mc-public-channel.mjs'
import { modelForSeat } from './mc-profile.mjs'
import { bridgePort, probePort, shouldReconcile } from './mc-reconnect.mjs'
import { ensureControlSession, mountControlGuards, resolveControlSession, writeControlTurn } from './mc-session.mjs'
import { settingKey } from './fields.mjs'
import { memberIdsFor, memberNamesFor, memberRequest, reconcileMembers, seatMcPresence } from './members.mjs'

function loadMemory(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { sessions: data?.sessions && typeof data.sessions === 'object' ? data.sessions : {} }
  } catch {
    return { sessions: {} }
  }
}

function mcTrace(dataRoot, log, event, extra = {}) {
  const row = { ts: new Date().toISOString(), event, ...extra }
  try { log?.info?.(`dsh-workbench: mc-control ${event}`, extra) } catch { /* ignore */ }
  try {
    const root = dataRoot?.() || ''
    if (!root) return
    const file = join(root, 'minecraft-control-trace.jsonl')
    mkdirSync(root, { recursive: true })
    writeFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* ignore */ }
}

export function createMcControlHost({
  ctx,
  getConfig,
  store,
  roomId,
  dataRoot,
  llm,
  log,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  probe = (port) => probePort(port),
  fetchImpl,
  callModel = callSeat,
} = {}) {
  const sessionIds = new Set()
  const handles = new Map()
  const memoryFile = () => join(dataRoot?.() || '', 'minecraft-control-sessions.json')
  const memory = loadMemory(memoryFile())
  let worldState = null
  let timer = null
  let unmountGuards = null
  let polling = false

  const mirror = createMirror({
    now,
    append: async (item) => {
      const id = String(roomId?.() || '').trim()
      if (!id || typeof store?.append !== 'function') return
      if (item.kind === 'bystander') {
        // 玩家公聊按用户自己的消息进房（非 system 虚线气泡），并去掉模组盖的 <角色名>。
        const who = String(item.player || item.name || '玩家').trim() || '玩家'
        await store.append(id, {
          kind: 'user',
          speaker: { id: 'user', name: who },
          owner: true,
          source: 'minecraft',
          via: 'mc-mirror',
          mcMessageId: item.id,
          text: stripRolePrefix(item.text || ''),
        })
        return
      }
      await store.append(id, {
        kind: 'seat',
        speaker: { id: item.memberId || 'minecraft', name: item.name || item.memberId || 'Minecraft' },
        provider: '',
        model: '',
        via: 'mc-mirror',
        mcMessageId: item.id,
        text: stripRolePrefix(item.text || ''),
      })
    },
  })

  const seatQueues = createSeatQueues()

  /** 席位空闲且尚无 active 时，升队首并武装（聊天入队 delayMs:0；连接空闲唤醒仍用 IDLE_MS）。 */
  function tryArmSeat(memberId, { delayMs = IDLE_MS } = {}) {
    const id = String(memberId || '').trim()
    if (!id) return false
    const view = control.view(id)
    if (!view?.connected || view.owner !== 'control' || view.busy) return false
    if (seatQueues.active(id)) return false
    const head = seatQueues.activateNext(id)
    if (!head) return false
    const base = seatQueues.armId(id, head) || `queue:${id}`
    const armId = `${base}:${now()}`
    const armed = control.note(id, { id: armId, self: false }, { delayMs })
    if (!armed) {
      // note 失败时退回队首，避免 active 卡死导致后续公聊永久不武装。
      seatQueues.releaseActive(id)
      mcTrace(dataRoot, log, 'tryArmSeat.fail', { memberId: id, armId, delayMs })
    } else {
      mcTrace(dataRoot, log, 'tryArmSeat.ok', { memberId: id, armId, delayMs, focusId: head.id })
    }
    return armed
  }

  /** 回合结束：出队首，若还有下一条则以 delayMs:0 武装。 */
  function finishSeatTurn(memberId, outcome) {
    const next = seatQueues.finish(memberId, outcome)
    if (next) {
      const id = String(memberId || '').trim()
      const base = seatQueues.armId(id, next) || `queue:${id}`
      const armId = `${base}:${now()}`
      control.note(id, { id: armId, self: false }, { delayMs: 0 })
    }
    return next
  }
  function saveMemory() {
    try {
      const file = memoryFile()
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify({ sessions: memory.sessions }) + '\n', 'utf8')
    } catch (error) {
      log?.warn?.('dsh-workbench: minecraft control session file', error?.message || error)
    }
  }

  const control = createMcControl({
    now,
    async runTurn(ctxTurn) {
      const cfg = getConfig?.() || {}
      // 连接/空闲 tick 常在无队首时醒来；若回合前已有 pending（或刚入队），先升队首再跑 LLM。
      // 仍无队首也要跑 LLM：空闲唤醒的目的就是防止 AI 角色干坐；聊天安静靠提示词约束，不跳过模型。
      let focus = seatQueues.active(ctxTurn.memberId)
      if (!focus) {
        focus = seatQueues.activateNext(ctxTurn.memberId)
        if (focus) {
          mcTrace(dataRoot, log, 'runTurn.promote', {
            memberId: ctxTurn.memberId,
            focusId: focus.id,
            focusText: String(focus.text || '').slice(0, 80),
          })
        }
      }
      mcTrace(dataRoot, log, 'runTurn.start', { memberId: ctxTurn.memberId, focusId: focus?.id || null, focusText: String(focus?.text || '').slice(0, 80) })
      let outcome = 'silent'
      let applied = null
      try {
        const model = await modelForSeat(cfg, ctxTurn.memberId, dataRoot?.())
        if (model.error) {
          outcome = 'error'
          mcTrace(dataRoot, log, 'runTurn.model.error', { memberId: ctxTurn.memberId, error: model.error })
          const session = resolveControlSession(handles.get(ctxTurn.memberId))
          if (session) writeControlTurn(session, `模型未就绪：${model.error}`)
          return { error: model.error }
        }
        if (!ctxTurn.current()) { outcome = 'stale'; return { stale: true } }
        const presence = await seatMcPresence(cfg, ctxTurn.memberId, { fetchImpl })
        let obs = null
        try {
          obs = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(ctxTurn.memberId)}/observe`, { fetchImpl, timeoutMs: 8000 })
        } catch (error) {
          obs = { last_error: String(error?.message || error) }
        }
        if (!ctxTurn.current()) { outcome = 'stale'; return { stale: true } }
        const runtime = typeof llm === 'function' ? llm() : llm
        let decision
        try {
          decision = await callModel({
            seat: {
              name: model.name || ctxTurn.memberId,
              provider: model.provider,
              model: model.model,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
            },
            prompt: {
              system: controlSystemPrompt(presence, model.persona, focus),
              messages: [{ role: 'user', content: `观察：${JSON.stringify(obs).slice(0, 4000)}` }],
            },
            llm: runtime,
            tools: [SAY_TOOL],
            signal: ctxTurn.signal,
          })
        } catch (error) {
          if (ctxTurn.signal?.aborted || !ctxTurn.current()) { outcome = 'stale'; return { stale: true } }
          outcome = 'error'
          const errMsg = String(error?.message || error)
          mcTrace(dataRoot, log, 'runTurn.call.error', { memberId: ctxTurn.memberId, error: errMsg })
          const session = resolveControlSession(handles.get(ctxTurn.memberId))
          if (session) writeControlTurn(session, `调用失败：${errMsg}`)
          return { error: errMsg }
        }
        if (!ctxTurn.current()) { outcome = 'stale'; return { stale: true } }
        applied = await applyDecision(decision, {
          current: ctxTurn.current,
          markSelf: ctxTurn.markSelf,
          act: async (params) => {
            if (!ctxTurn.current()) return { ok: false, stale: true }
            const result = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(ctxTurn.memberId)}/actions`, {
              method: 'POST',
              body: { action: 'say', params },
              fetchImpl,
              timeoutMs: 10000,
            })
            if (!ctxTurn.current()) return { ...(result || {}), ok: false, stale: true }
            try {
              await mirror.fromAction(ctxTurn.memberId, result, model.name)
              // AI 公聊不 fan-out note；本席队列在回合结束后自行升下一条。
            } catch (error) {
              log?.warn?.('dsh-workbench: minecraft mirror', error?.message || error)
            }
            return result
          },
        })
        const session = resolveControlSession(handles.get(ctxTurn.memberId))
        if (session && ctxTurn.current()) {
          const said = (applied.spoken || []).map((item) => item?.sent || '').filter(Boolean).join(' ')
          writeControlTurn(session, said || applied.error || '这一轮没有发言')
        }
        if ((applied.spoken || []).some((item) => item?.ok)) outcome = 'spoke'
        else if (applied.error) outcome = 'error'
        else outcome = 'silent'
        return applied
      } finally {
        // 成功出队；error/stale/玩家公聊 silent 退回 pending 并可再次武装（最多 3 次），避免一次失败或空回永久吞掉公聊。
        mcTrace(dataRoot, log, 'runTurn.finally', { memberId: ctxTurn.memberId, outcome, focusId: focus?.id || null })
        if (focus && seatQueues.active(ctxTurn.memberId)?.id === focus.id) {
          const playerChat = focus.kind === 'bystander'
          const retryable = outcome === 'error' || outcome === 'stale' || (outcome === 'silent' && playerChat)
          if (retryable && (Number(focus.attempts) || 0) < 3) {
            focus.attempts = (Number(focus.attempts) || 0) + 1
            seatQueues.releaseActive(ctxTurn.memberId)
            seatQueues.forget(ctxTurn.memberId, focus.id)
            const delayMs = outcome === 'error' ? 1500 : 0
            tryArmSeat(ctxTurn.memberId, { delayMs })
            mcTrace(dataRoot, log, 'runTurn.retry', {
              memberId: ctxTurn.memberId,
              focusId: focus.id,
              outcome,
              attempts: focus.attempts,
              delayMs,
            })
          } else {
            finishSeatTurn(ctxTurn.memberId, outcome)
          }
        } else if (!focus && ctxTurn.current()) {
          // 连接 / 空闲唤醒（无队首仍跑了 LLM）：若回合中已入队，结束后立刻武装队首。
          tryArmSeat(ctxTurn.memberId, { delayMs: 0 })
        }
      }
    },
  })


  /** 启用后自动挂上控制会话：GameBot 已连接的席位不必再手动 mc_connect。已在控制表里的不重复 connect（避免每秒重置 15s 空闲计时）。 */
  async function armConnectedSeats(cfg, members) {
    const armed = new Set(control.connectedIds())
    const ids = []
    if (Array.isArray(members) && members.length) {
      for (const item of members) {
        const id = String(item?.member_id || '').trim()
        if (id && item?.connected && !armed.has(id)) ids.push(id)
      }
    } else {
      for (const id of memberIdsFor(cfg)) {
        if (armed.has(id)) continue
        try {
          const data = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/status`, {
            fetchImpl,
            timeoutMs: 4000,
          })
          if (data?.connected) ids.push(id)
        } catch {
          /* 状态暂时不可用时下轮再试 */
        }
      }
    }
    for (const id of ids) {
      if (control.connectedIds().includes(id)) continue
      try {
        await onConnected(id)
      } catch (error) {
        log?.warn?.('dsh-workbench: minecraft auto-arm', error?.message || error)
      }
    }
    return ids
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      const cfg = getConfig?.() || {}
      if (cfg['gamebot-minecraftEnabled'] !== true) {
        mcTrace(dataRoot, log, 'poll.disabled')
        return
      }
      control.tick(now())
      const seatIds = control.connectedIds()
      const observations = await Promise.all(seatIds.map(async (id) => {
        try {
          const obs = await memberRequest(cfg, `/v1/minecraft/members/${encodeURIComponent(id)}/observe`, { fetchImpl, timeoutMs: 4000 })
          return { id, obs }
        } catch {
          return { id, obs: null, error: true }
        }
      }))
      for (const row of observations) {
        const { id, obs, error } = row
        if (error || !obs) continue
        if (obs.connected === false) {
          seatQueues.clear(id)
          control.disconnect(id)
          continue
        }
        const events = Array.isArray(obs?.recent_events) ? obs.recent_events : []
        for (const event of events) {
          try { await mirror.consider(event) } catch { /* 房间暂时写不进时，下一条再试 */ }
          const item = classifyChat(event)
          if (!item) continue
          // AI 公聊回声：不入队、不 fan-out 武装。
          if (item.kind === 'say' && item.audience !== 'private') continue
          // 本席自己的 say 回声（含私聊回执）不入队。
          if (item.kind === 'say' && String(item.memberId || '') === id) continue

          if (item.audience === 'private') {
            seatQueues.enqueuePrivate(id, item)
            tryArmSeat(id, { delayMs: 0 })
            continue
          }

          if (item.kind === 'bystander') {
            // 玩家公聊：每个已连接席位各自入队，各席自行串行处理。
            const seats = control.connectedIds()
            const hit = seatQueues.enqueuePublic(item, seats)
            mcTrace(dataRoot, log, 'enqueuePublic', { id: item.id, speaker: item.player || item.name, hit, seats: seats.length, via: id })
            for (const sid of seats) tryArmSeat(sid, { delayMs: 0 })
          }
        }
      }

      // 进世界自动连接固定为开：世界从不可连变为可连时再 reconcile 一次。
      {
        const open = await probe(bridgePort(cfg[settingKey('minecraft', 'NEOFORGE_WS_URL')]))
        const step = shouldReconcile('1', worldState, open)
        worldState = step.state
        if (step.reconcile) {
          try {
            const summary = await reconcileMembers(cfg, { fetchImpl })
            await armConnectedSeats(cfg, summary?.members)
          } catch (error) {
            log?.warn?.('dsh-workbench: minecraft reconnect', error?.message || error)
          }
        }
      }
      // 启用 / 自动连接后补挂控制会话与空闲唤醒（不依赖聊天室 mc_connect）。
      try { await armConnectedSeats(cfg) } catch (error) {
        log?.warn?.('dsh-workbench: minecraft auto-arm', error?.message || error)
      }
      // delayMs:0 武装在本轮 tick 之后才写入 deadline：收尾再 tick 一次，避免干等下一秒（其间 enable 被关掉会吞回合）。
      control.tick(now())
    } finally {
      polling = false
    }
  }

  async function onConnected(memberId) {
    control.connect(memberId)
    const cfg = getConfig?.() || {}
    const name = memberNamesFor(cfg)[memberId] || memberId
    const agents = ctx?.get?.('agents') || ctx?.agents
    const presets = ctx?.get?.('agentPresets') || ctx?.agentPresets
    const titles = ctx?.get?.('sessionTitle') || ctx?.sessionTitle
    try {
      const made = await ensureControlSession({
        agents, presets, titles, memberId, name, remembered: memory.sessions, sessions: sessionIds,
      })
      if (made.sessionId) {
        memory.sessions[memberId] = made.sessionId
        saveMemory()
        if (made.handle) handles.set(memberId, made.handle)
      }
    } catch (error) {
      log?.warn?.('dsh-workbench: minecraft control session', error?.message || error)
    }
  }

  async function sync() {
    const cfg = getConfig?.() || {}
    if (cfg['gamebot-minecraftEnabled'] !== true) {
      await stop()
      return
    }
    const live = new Set(memberIdsFor(cfg))
    for (const id of control.connectedIds()) {
      if (!live.has(id)) control.disconnect(id)
    }
    if (!unmountGuards) unmountGuards = mountControlGuards(ctx, sessionIds)
    if (!timer) timer = setIntervalImpl(() => { void poll() }, 1000)
    // 刚启用时立刻挂控制会话，不等下一秒 poll。
    void armConnectedSeats(cfg).catch((error) => {
      log?.warn?.('dsh-workbench: minecraft auto-arm', error?.message || error)
    })
  }

  async function stop() {
    if (timer) clearIntervalImpl(timer)
    timer = null
    seatQueues.clear()
    control.stopAll()
    worldState = null
  }

  return {
    sync,
    poll,
    async dispose() {
      await stop()
      try { unmountGuards?.() } catch { /* 已卸 */ }
      unmountGuards = null
    },
    blocksMember: (id) => control.blocksMember(id),
    onConnected,
    onDisconnected: (id) => { seatQueues.clear(id); control.disconnect(id) },
    takeover: (id) => control.takeover(id),
    resume: (id) => control.resume(id),
    onSay: async (id, result) => {
      // 聊天室手动 say：只镜像；不 fan-out 武装其他控制会话。
      return mirror.fromAction(id, result, memberNamesFor(getConfig?.() || {})[id] || id)
    },
    view: (id) => control.view(id),
    publicView: () => seatQueues.view(),
    seatQueueView: (id) => seatQueues.view(id),
  }
}
