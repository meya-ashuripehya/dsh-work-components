/**
 * 每个已连接座位一个 Minecraft 控制会话。
 * 动作完成后持续安排下一轮；外部事件可提前唤醒。
 * 聊天室心跳和 end_round 不读、不写这里的计时。
 * 工具按当前模组实际声明的能力提供。
 * 每席回复队列见 mc-public-channel.mjs 的 createSeatQueues（本文件只提供单席 deadline / disarm）。
 */
import { randomUUID } from 'node:crypto'

export const IDLE_MS = 15000
export const SAY_TOOL = {
  name: 'say',
  description: 'Speak in the Minecraft chat box. audience defaults to public. private requires target. emote is chat text only.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say.' },
      audience: { type: 'string', description: 'public or private. Defaults to public.' },
      target: { type: 'string', description: 'Online player name. Required when audience is private.' },
      emote: { type: 'string', description: 'Short action text shown in the chat line. Not a world action.' },
    },
    required: ['text'],
  },
}

const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }
const movePoint = { ...point, properties: { ...point.properties,
  x: { type: 'number', description: 'Destination foot position X; prefer the center of a walkable block.' },
  y: { type: 'number', description: 'Destination FEET height, not supporting block height. A full solid block at pos.y has its walkable top at pos.y + 1. Never target inside that block. Use observation and prior navigation failures.' },
  z: { type: 'number', description: 'Destination foot position Z; choose a nearby reachable location.' },
} }
export function controlTools(observation) {
  const advertised = new Set(observation?.extras?.advertised || [])
  const taskTool = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', properties, required } })
  const interest = { type: 'string', description: 'Optional focus: block ID, #block_tag, or danger/functional/ore/unknown/terrain.' }
  const taskTools = [
    taskTool('navigate_to', 'Start persistent navigation. Acceptance is not arrival. Local route segments do not need further model calls.', { ...movePoint.properties, interest }, ['x', 'y', 'z']),
    taskTool('follow_entity', 'Continuously follow one player UUID or target AI seat, until cancelled. Speak without restarting this task.', { uuid: { type: 'string' }, target_agent_id: { type: 'string' }, distance: { type: 'number', minimum: 2, maximum: 8, default: 3 }, interest }),
    taskTool('explore_area', 'Explore visible unvisited nearby locations, then return. Runs without step-by-step model calls.', { center: point, radius: { type: 'number', minimum: 4, maximum: 64, default: 16 }, seconds: { type: 'integer', minimum: 10, maximum: 600, default: 120 }, return_to_start: { type: 'boolean', default: true }, interest }),
    taskTool('stop_task', 'Cancel the current navigation task and confirm that navigation stopped.', {}),
    taskTool('inspect_blocks', 'Read up to 32 currently visible block details, filtered by block_id, tag, or category. No hidden ore or container contents.', { block_id: { type: 'string' }, tag: { type: 'string' }, category: { type: 'string', enum: ['danger', 'functional', 'ore', 'unknown', 'terrain'] } }),
  ].filter((t) => advertised.has(`${t.name === 'inspect_blocks' ? 'minecraft.world' : 'minecraft.task'}.${t.name}`))
  return [
    ...(advertised.has('minecraft.chat.say') ? [SAY_TOOL] : []),
    ...taskTools,
    ...(advertised.has('minecraft.world.place_block') && advertised.has('minecraft.world.place_from_inventory') ? [taskTool('place_block', 'Place one block from any of your 36 inventory slots, at the final block coordinates. Stop active navigation first. face is FROM target TO support (ground = down). Approach a visible reachable support yourself. Confirm state and consumption.', { pos: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }, required: ['x','y','z'] }, block_id: { type: 'string' }, face: { type: 'string', enum: ['down','up','north','south','west','east'] } }, ['pos','block_id'])] : []),
    ...(advertised.has('minecraft.inventory.drop') && advertised.has('minecraft.inventory.drop_safe') ? [taskTool('drop_item', 'Throw an exact quantity from one inventory stack into the world. Searches all 36 slots. Own automatic pickup is deferred for this entity for 60 game seconds. Other players can pick it up. Does not directly transfer into another inventory.', { item_id: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64 }, additional_drop: { type: 'boolean', description: 'Default false: retries of the same completed drop do not drop again. Set true ONLY for a deliberately additional batch, never to retry or reconfirm a successful drop.' } }, ['item_id','count'])] : []),
    ...(advertised.has('minecraft.world.break_block') && advertised.has('minecraft.world.harvest_with_tools') ? [taskTool('break_block', 'Mine one visible, reachable block matching expected_block. Automatically selects a suitable tool from your 36-slot inventory; refuses if none can harvest it. Stops no active task automatically: call stop_task first. Vanilla survival drops, tool durability and enchantments apply. Destroyed is not acquired: check inventory and recent_pickups, approach nearby_items to collect.', { pos: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }, required: ['x', 'y', 'z'] }, expected_block: { type: 'string' }, face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'], description: 'A visible face of the target block.' } }, ['pos', 'expected_block', 'face'])] : []),
    ...['move_to', 'look_at'].filter((name) => !(name === 'move_to' && taskTools.length) && advertised.has(`minecraft.player.${name}`)).map((name) => ({ name, description: name === 'move_to' ? 'Move near reachable foot coordinates on top of supporting blocks. Default arrival radius is 1.5 blocks; prefer block centers (x + 0.5, z + 0.5). Completion requires a fresh position observation.' : 'Look at world coordinates.', parameters: name === 'move_to' ? movePoint : point })),
    { name: 'wait', description: 'Wait 5–30 seconds; new messages may wake you sooner.', parameters: { type: 'object', properties: { seconds: { type: 'number', minimum: 5, maximum: 30 } }, required: ['seconds'] } },
  ]
}

export function controlSystemPrompt(presence, persona, focus, task) {
  const lines = [
    '你是这个席位的 Minecraft 控制会话。只有本会话驱动这个 NPC。',
    '你在游戏中自主陪玩。决定持续任务，由模组执行导航、跟随和探索。只使用本轮提供的工具；每轮最多一个任务/观察/朝向操作和一次 say，或显式 wait。',
    'navigate_to、follow_entity、explore_area 返回 accepted 只表示任务已接受，不代表抵达。以 observation.task 和 task_events 的 completed/failed/cancelled 为准。任务正常进行时不要重新下达相同任务；想说话只调用 say，原任务继续。普通自主决策约每60秒一次，任务分段不需要你指路。',
    '没有玩家指定地点时，自主闲逛优先使用 explore_area（默认120秒并返回），不要连续创建只走两三格的 navigate_to 任务。探索过程中由模组选择落点，无需你反复确认每一步。',
    '环境输入以 terrain_summary 和 points_of_interest 为主；只有眼部可见的暴露方块会被报告。last_seen 兴趣点只是历史记忆，可能已消失；inspect_blocks 可按需查询当前可见细节，结果在后续回合提供，不要猜测被遮挡的矿物或模组机器用途。',
    '普通文字用于记录当前目标，不会发到游戏；只有 say 才会发言。不要把动作意图当成已完成。遇到失败换目标，遵守返回的冷却。',
    '移动目标的 y 是落脚高度，应依据附近可站立方块的顶面选择；不要把当前高度机械复制到别处，尤其在坑里时。连续无法脱困时说明事实、请求玩家帮助或等待，不要声称已经抵达。房间约定不等于眼前真的存在某个建筑。',
    '优先从 observation.standable_goals 选择目标，直接使用其中 position 的 x/y/z；这些坐标已通过模组的支撑、身体碰撞和危险检查，但不保证路径可达。nearby_blocks.pos 是方块坐标，不能直接作为脚部坐标。目标需超出当前1.5格到达半径才能产生有意义的移动；失败时换其他落脚点或等待。',
    '绑定房间的记忆可用于交流和任务理解，但房间轮聊不驱动角色。私聊只在当前回合使用，禁止复述到公屏、目标或持久记忆。',
    'say 的 audience 默认 public。private 必须带 target（在线玩家名）。emote 只写进聊天框，不是世界动作。',
    '本席只有一条回复队列：公屏与私聊挨个处理，同一回合只回应队首，不要混进其他聊天意图。',
    '观察里的公屏全文和本席私聊只作上下文；可执行焦点是队首那一条。',
  ]
  if (focus?.id) {
    const audience = focus.audience || 'public'
    const speaker = focus.speaker || '(unknown)'
    const text = String(focus.text || '').slice(0, 500)
    lines.push(`本回合队首：audience=${audience}，发言者=${speaker}，内容=${text}`)
    if (audience === 'private') {
      lines.push(`私聊回复使用 audience=private，target=${speaker}；不要公开回复私聊。`)
    }
    // 玩家聊天（公/私）必须实质回复，禁止学观察里其他席的「保持安静 / 不主动发言」。
    if (focus.kind === 'bystander' || audience === 'private') {
      lines.push('队首是玩家发来的聊天：本回合必须用 say 给出一句实质回复（回答问题或接话），不要保持安静，不要说「没有待回复」「空闲唤醒」。')
    } else {
      lines.push('其他 AI 的公开发言可作上下文；未被点名时不必回应，可以继续行动。被点名时自然接话，避免全员抢答。')
    }
  } else {
    lines.push('当前没有待回复的聊天：继续自己的目标，观察与行动，或主动自然交流；无事可做时 wait。不要说「空闲唤醒」等调度元话语，不要编造对象。主动发言有20秒冷却。')
  }
  const extra = String(persona || '').trim()
  if (extra) lines.push(extra)
  if (presence?.lines?.length) lines.push(presence.lines.join('\n'))
  lines.push('游戏事实以当前 observation 和实际动作结果为准。人设、房间记忆、其他角色的想象性台词不是现场观察；未观测到的建筑、光源、物品只能作为猜测或想象表达，不能声称看到了或据此反复导航。移动失败后核对落脚高度与地形，换一个观察支持的目标或等待。')
  lines.push('本轮请显式调用所需工具。想交流必须调用 say，想改变位置优先启动持续任务；若原任务正常进行可只 say 或 wait。纯文本只可写一句内部目标，不可用动作描写代替执行。只有任务终态确认完成才能说已抵达。')
  lines.push('room.messages 是已经发生的交流历史，不是新的待回复队列；其中你自己已经说过的话表示已经回答过。只把本轮队首作为待处理消息，不要在普通自主回合再次回答旧问题或重复上一句。previous_execution.speech 的 duplicate_speech 表示重复发言已跳过，应继续任务或等待，不要改几个字重说。')
  lines.push('物品事实以 inventory.slots/counts 和 recent_pickups 为准；没有工具不能凭空生成。break_block 会从全部36格背包自动选可采收的工具，缺工具时不会破坏方块。没有工具要求的泥土、木头等可徒手采集；需要合适工具的矿物不可硬挖。先 inspect_blocks 找可见目标，再停下当前任务、靠近并挖掘。方块被破坏不等于物品入包：掉落类型取决于原版及模组规则（如石头可能掉圆石），看 nearby_items 并走近，让自动拾取执行，再核对 inventory 与 recent_pickups。背包满、拾取延迟或其他限制时不得声称已经拿到。玩家可右键NPC查看或放入工具。')
  if (!focus && !['accepted', 'running'].includes(task?.state)) {
    lines.push('本轮没有待回复消息，也没有正在执行的任务。请先选择一个可用的持续任务（无特定目标时优先 explore_area），或显式 wait 并等待合适时机；不要只调用 say 后继续站着。发言是可选的附加交流，不能代替任务选择。不要凭空生成不受观察支持的坐标。')
  }
  lines.push('place_block 的 pos 是最终占用的方块格，不是支撑格或脚部高度；face 指从目标格到支撑格，地面支撑用 down。先停导航，必要时靠近再放置，不允许凭空材料。drop_item 丢出指定数量，不代表对方已经收到。正常丢出后不要立刻捡回，也不要因回执不确定而重复丢物。')
  lines.push('兴趣点和 inspect_blocks 的 state 是本次可见方块的实际属性：例如蜡烛 lit 表示是否点燃，门 open 表示是否打开；powered 需按具体方块解释，作物 age 需结合该作物的成熟规则，不要仅凭非零就说成熟。相同 block_id 的不同 state 是不同状态。last_seen 只是上次看到的状态，交互结果应以新的可见观察为准；属性缺失表示未知，不要补造。')
  return lines.join('\n')
}
function blank(id) {
  return {
    id,
    connected: false,
    generation: 0,
    owner: 'control',
    busy: false,
    deadline: null,
    seen: new Set(),
    self: new Set(),
    abort: null,
  }
}

export function controlArguments(value) {
  try {
    const args = typeof value === 'string' ? JSON.parse(value) : value ?? {}
    return args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : null
  } catch { return null }
}

/** 每轮至多执行一个已声明的世界动作和一次发言。 */
export async function applyDecision(decision, ctx) {
  const calls = Array.isArray(decision?.toolCalls) ? decision.toolCalls : []
  const rejected = []
  const spoken = []
  const actions = []
  let worldUsed = false
  let waitMs = null
  const allowed = new Set(ctx.tools?.map((t) => t.name) || ['say'])
  let used = false
  const speak = async (params) => {
    if (!ctx.current()) return { stale: true, spoken, rejected }
    const sayId = randomUUID()
    ctx.markSelf(sayId)
    const result = await ctx.act({ ...params, say_id: sayId }, 'say')
    if (!ctx.current()) return { stale: true, spoken, rejected, dropped: result }
    spoken.push(result)
    return null
  }
  for (const call of calls) {
    const name = String(call?.name || '')
    if (!allowed.has(name) || (name === 'say' ? used : worldUsed)) {
      rejected.push(name || '(empty)')
      continue
    }
    // DSH's LlmRuntime supplies JSON text; native acceptance adapters may
    // supply an already parsed object. Decode only explicit tool arguments.
    const params = controlArguments(call?.arguments)
    if (!params) {
      rejected.push(`${name}:invalid_arguments`)
      continue
    }
    delete params.say_id
    delete params.agent_id
    delete params.member_id
    if (name === 'say') {
      used = true
      const stopped = await speak(params)
      if (stopped) return { ...stopped, actions }
    } else {
      worldUsed = true
      if (name === 'wait') waitMs = Math.min(30, Math.max(5, Number(params.seconds) || 10)) * 1000
      else {
        if (!ctx.current()) return { stale: true, spoken, actions, rejected }
        const result = await ctx.act(params, name)
        if (!ctx.current()) return { stale: true, spoken, actions, rejected }
        actions.push({ action: name, params, result })
      }
    }
  }
  return { stale: false, spoken, actions, rejected, waitMs, nextDelayMs: waitMs ?? (actions.length ? 2000 : IDLE_MS) }
}

export function createMcControl({ now = Date.now, runTurn } = {}) {
  const seats = new Map()

  function seatOf(memberId) {
    const id = String(memberId || '').trim()
    let seat = seats.get(id)
    if (!seat) {
      seat = blank(id)
      seats.set(id, seat)
    }
    return seat
  }

  function remember(seat, id) {
    if (!id || seat.seen.has(id)) return false
    seat.seen.add(id)
    if (seat.seen.size > 500) {
      seat.seen.clear()
      for (const self of seat.self) seat.seen.add(self)
      seat.seen.add(id)
    }
    return true
  }

  return {
    connect(memberId) {
      const seat = seatOf(memberId)
      seat.abort?.abort()
      seat.connected = true
      seat.generation += 1
      seat.owner = 'control'
      seat.busy = false
      seat.deadline = null
      seat.seen = new Set()
      seat.self = new Set()
      seat.abort = null
      seat.failures = 0
      seat.suspended = false
      this.note(memberId, { id: `connect:${seat.generation}`, self: false }, { delayMs: 0 })
      return { ok: true, generation: seat.generation, owner: seat.owner }
    },
    disconnect(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat) return { ok: true }
      seat.abort?.abort()
      seat.connected = false
      seat.generation += 1
      seat.busy = false
      seat.deadline = null
      seat.abort = null
      seat.self = new Set()
      return { ok: true, generation: seat.generation }
    },
    takeover(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected) return { ok: false, error: 'NPC 还没连接' }
      seat.abort?.abort()
      seat.owner = 'manual'
      seat.generation += 1
      seat.busy = false
      seat.deadline = null
      seat.abort = null
      return { ok: true, owner: 'manual', hint: '你现在可以自己用 mc_act。做完后调用 mc_resume，控制会话会重新接管。' }
    },
    resume(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected) return { ok: false, error: 'NPC 还没连接' }
      seat.abort?.abort()
      seat.owner = 'control'
      seat.busy = false
      seat.abort = null
      seat.generation += 1
      this.note(memberId, { id: `resume:${seat.generation}`, self: false }, { delayMs: 0 })
      return { ok: true, owner: 'control', generation: seat.generation }
    },
    suspendWorld(memberId) {
      const seat = seats.get(memberId)
      if (!seat || seat.suspended) return
      seat.suspended = true; seat.abort?.abort(); seat.generation++; seat.busy = false; seat.abort = null
      seat.deadline ??= now()
    },
    resumeWorld(memberId) {
      const seat = seats.get(memberId)
      if (seat) seat.suspended = false
    },
    blocksMember(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      return !!(seat?.connected && seat.owner === 'control')
    },
    /**
     * 外部事件武装空闲计时。
     * delayMs 默认 IDLE_MS；公屏通道换下一位时可传 0，下一 tick 即醒，避免 N×15s。
     */
    note(memberId, event, { delayMs = IDLE_MS } = {}) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat?.connected || seat.owner !== 'control') return false
      const id = String(event?.id || '')
      if (!id || event?.self || seat.self.has(id)) return false
      if (!remember(seat, id)) return false
      const wait = Number.isFinite(delayMs) ? Math.max(0, Number(delayMs)) : IDLE_MS
      seat.deadline = Math.min(seat.deadline ?? Infinity, now() + wait)
      seat.wakeReason = event?.task_id ? 'task_terminal' : id.startsWith('connect:') ? 'joined' : id.startsWith('resume:') ? 'manual_resume' : 'message'
      return true
    },
    /** 清掉尚未到期的空闲武装（不打断 busy 回合）。 */
    disarm(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat || seat.busy) return false
      seat.deadline = null
      return true
    },
    disarmAllExcept(keepId) {
      const keep = String(keepId || '').trim()
      for (const [id, seat] of seats) {
        if (id === keep || seat.busy) continue
        seat.deadline = null
      }
    },
    markSelf(memberId, id) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat || !id) return
      seat.self.add(String(id))
    },
    tick(at = now()) {
      for (const [memberId, seat] of seats) {
        if (!seat.connected || seat.owner !== 'control' || seat.suspended || seat.busy || seat.deadline == null) continue
        if (at < seat.deadline) continue
        seat.deadline = null
        seat.busy = true
        const generation = seat.generation
        const abort = new AbortController()
        seat.abort = abort
        const current = () => seat.connected && seat.owner === 'control' && seat.generation === generation && !abort.signal.aborted
        seat.lastDecisionAt = at
        const reason = seat.wakeReason || 'periodic'; seat.wakeReason = null
        let result
        Promise.resolve().then(() => runTurn?.({
          memberId,
          reason,
          generation,
          signal: abort.signal,
          current,
          markSelf: (id) => { if (id) { seat.self.add(String(id)); if (seat.self.size > 500) seat.self.delete(seat.self.values().next().value) } },
        })).then((value) => { result = value }).catch((error) => { result = { error: String(error?.message || error) } }).finally(() => {
          if (seat.generation !== generation) return
          seat.busy = false
          if (seat.abort === abort) seat.abort = null
          if (!current()) return
          seat.lastError = result?.error || null
          seat.failures = result?.error ? (seat.failures || 0) + 1 : 0
          const delay = seat.failures ? [5000, 15000, 30000][Math.min(2, seat.failures - 1)] : Math.max(2000, result?.nextDelayMs ?? IDLE_MS)
          seat.deadline = seat.failures ? now() + delay : Math.max(now() + 2000, Math.min(seat.deadline ?? Infinity, now() + delay))
        })
      }
    },
    stopAll() {
      for (const id of [...seats.keys()]) this.disconnect(id)
    },
    connectedIds() {
      return [...seats.entries()].filter(([, seat]) => seat.connected).map(([id]) => id)
    },
    view(memberId) {
      const seat = seats.get(String(memberId || '').trim())
      if (!seat) return null
      return {
        connected: seat.connected,
        generation: seat.generation,
        owner: seat.owner,
        busy: seat.busy,
        deadline: seat.deadline,
        state: !seat.connected ? 'disconnected' : seat.owner === 'manual' ? 'manual' : seat.suspended ? 'paused' : seat.busy ? 'thinking' : seat.lastError ? 'error' : 'waiting',
        lastDecisionAt: seat.lastDecisionAt ?? null,
        lastError: seat.lastError ?? null,
      }
    },
  }
}
