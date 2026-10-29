/**
 * 聊天室里的 Minecraft 成员工具。调用者只来自 exec.game.caller，不来自参数。
 */
import { defineTool } from '../../../vendor/dsh-tools/schema.js'
import { AGENT_ID, memberIdsFor, memberNamesFor, memberRequest } from './members.mjs'
import { createWorkRuntime, createWorkTools } from './minecraft-work/tools.mjs'

const OUTPUT = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export const MC_ACTIONS = [
  'say',
  'look_at',
  'move_to',
  'interact',
  'select_item',
  'use_item_on_block',
  'attack_block',
  'break_block',
  'place_block',
  'probe_blocks',
  'attack_entity',
  'drop_item',
  'use_item',
  'find_item',
]

function requireMember(exec, cfg) {
  const memberId = String(exec?.game?.caller?.memberId || '').trim()
  if (!memberId) throw new Error('仅限聊天室成员')
  if (!AGENT_ID.test(memberId)) throw new Error('席位 id 不能作为 Minecraft NPC id（只允许小写字母、数字、连字符，最长 32）')
  const seats = Array.isArray(cfg?.chatroomSeats) ? cfg.chatroomSeats : []
  const seat = seats.find((item) => item && item.id === memberId)
  if (!seat || seat.enabled === false) throw new Error('这个席位没有启用')
  if (!memberIdsFor(cfg).includes(memberId)) throw new Error('该成员没有已启用的 Minecraft AI（请在 GameBot · Minecraft 设置的「Minecraft AI」中添加或启用）')
  return memberId
}

function rejectForeign(value, memberId, label) {
  if (value == null || value === '') return
  if (String(value) !== memberId) throw new Error(`不能代其他成员操作（${label}）`)
}

function cleanParams(params, memberId) {
  const next = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {}
  rejectForeign(next.agent_id, memberId, 'agent_id')
  rejectForeign(next.member_id, memberId, 'member_id')
  delete next.agent_id
  delete next.member_id
  return next
}

export function createMembersTools({ getConfig, fetchImpl, control } = {}) {
  const cfgOf = () => getConfig?.() || {}
  const request = (cfg, path, options) => memberRequest(cfg, path, { ...options, fetchImpl })
  const held = (memberId) => control?.blocksMember?.(memberId) === true

  const connectTool = defineTool({
    name: 'mc_connect',
    description: 'Connect your own Minecraft NPC. Identity comes from your chatroom seat. Do not pass a member or agent id.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      const result = await request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/connect`, { method: 'POST', timeoutMs: 20000 })
      if (result && result.ok !== false && result.connected !== false) {
        try { await control?.onConnected?.(memberId) } catch { /* 控制会话没挂上时，NPC 连接仍然有效 */ }
      }
      return result
    },
  })

  const observeTool = defineTool({
    name: 'mc_observe',
    description: 'Look at your own Minecraft NPC: position, inventory, nearby blocks, and the last error.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      return request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/observe`, { timeoutMs: 10000 })
    },
  })

  const actTool = defineTool({
    name: 'mc_act',
    description: `Act as your own Minecraft NPC. Allowed actions: ${MC_ACTIONS.join(', ')}. say takes text, optional audience (public or private), target (required when private), and emote (chat text only, not a world action). The result is the server delivery receipt, not merely a queued send. run_command is not available. Do not pass agent_id or member_id. While the Minecraft control session holds this NPC, call mc_takeover before acting and mc_resume when done.`,
    parameters: {
      action: { type: 'string', required: true, description: 'One of the allowed actions.' },
      params: { type: 'object', additionalProperties: true, description: 'Action parameters. agent_id and member_id are rejected.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      const action = String(args?.action || '').trim()
      if (!MC_ACTIONS.includes(action)) throw new Error(`不允许的动作：${action || '(empty)'}`)
      if (held(memberId)) throw new Error('这个 NPC 正由 Minecraft 控制会话驱动。要临时自己操作，先调用 mc_takeover；做完后调用 mc_resume。')
      const result = await request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/actions`, {
        method: 'POST',
        body: { action, params: cleanParams(args?.params, memberId) },
        timeoutMs: 30000,
      })
      if (action === 'say') {
        try { await control?.onSay?.(memberId, result) } catch { /* 镜像失败不影响游戏内回执 */ }
      }
      return result
    },
  })

  const cancelTool = defineTool({
    name: 'mc_cancel',
    description: 'Cancel one of your own pending Minecraft actions by its request id.',
    parameters: {
      target_request_id: { type: 'string', required: true, description: 'request id returned for your own action.' },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      return request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/cancel`, {
        method: 'POST',
        body: { target_request_id: String(args?.target_request_id || '') },
        timeoutMs: 10000,
      })
    },
  })

  const statusTool = defineTool({
    name: 'mc_status',
    description: 'Connection status of your own Minecraft NPC.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      return request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/status`, { timeoutMs: 10000 })
    },
  })

  const disconnectTool = defineTool({
    name: 'mc_disconnect',
    description: 'Disconnect your own Minecraft NPC. Other members stay connected.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      const result = await request(cfg, `/v1/minecraft/members/${encodeURIComponent(memberId)}/disconnect`, { method: 'POST', timeoutMs: 10000 })
      try { control?.onDisconnected?.(memberId) } catch { /* 控制会话已停时仍返回断开结果 */ }
      return result
    },
  })

  const takeoverTool = defineTool({
    name: 'mc_takeover',
    description: 'Pause the Minecraft control session and drive this NPC yourself. Call mc_resume to hand it back.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      if (typeof control?.takeover !== 'function') return { ok: false, error: '控制会话还没挂上' }
      return control.takeover(memberId)
    },
  })

  const resumeTool = defineTool({
    name: 'mc_resume',
    description: 'Hand this NPC back to its Minecraft control session. The idle timer starts again.',
    parameters: {},
    output: OUTPUT,
    async execute(args, exec) {
      const cfg = cfgOf()
      const memberId = requireMember(exec, cfg)
      rejectForeign(args?.agent_id, memberId, 'agent_id')
      rejectForeign(args?.member_id, memberId, 'member_id')
      if (typeof control?.resume !== 'function') return { ok: false, error: '控制会话还没挂上' }
      return control.resume(memberId)
    },
  })

  return [connectTool, observeTool, actTool, cancelTool, statusTool, disconnectTool, takeoverTool, resumeTool]
}

/** Minecraft 卡片启用时挂上 mc_*；关闭时卸下。 */
export function createGamebotMembersFeature(ctx, getConfig) {
  const log = ctx.logger ?? console
  const state = { status: 'off', detail: '未启用', fork: null, gen: 0 }
  let bound = null
  const gate = {
    blocksMember: (id) => bound?.blocksMember?.(id),
    onConnected: (id) => bound?.onConnected?.(id),
    onDisconnected: (id) => bound?.onDisconnected?.(id),
    takeover(id) {
      if (typeof bound?.takeover !== 'function') return { ok: false, error: '控制会话还没挂上' }
      return bound.takeover(id)
    },
    resume(id) {
      if (typeof bound?.resume !== 'function') return { ok: false, error: '控制会话还没挂上' }
      return bound.resume(id)
    },
    onSay: (id, result) => bound?.onSay?.(id, result),
  }
  let disposed = false
  let snapshot = ''
  let work = null

  async function stop() {
    if (work) {
      work.dispose()
      work = null
    }
    const fork = state.fork
    state.fork = null
    if (fork) {
      try { await fork.dispose?.() } catch (error) {
        log.warn?.('dsh-workbench: minecraft members stop failed', error?.name || 'error')
      }
    }
  }

  async function sync() {
    if (disposed) return
    const cfg = getConfig() || {}
    const enabled = cfg['gamebot-minecraftEnabled'] === true
    const snap = enabled ? '1' : '0'
    if (snap === snapshot) return
    const gen = ++state.gen
    await stop()
    if (gen !== state.gen) return
    if (!enabled) {
      snapshot = snap
      state.status = 'off'
      state.detail = '未启用'
      return
    }
    if (typeof ctx.plugin !== 'function') {
      snapshot = ''
      state.status = 'error'
      state.detail = '宿主不支持挂载子插件（ctx.plugin）'
      return
    }
    try {
      state.fork = ctx.plugin({
        name: 'dsh-workbench-minecraft-members',
        apply(sub) {
          sub.inject(['tools'], (toolCtx) => {
            work = createWorkRuntime()
            for (const tool of createMembersTools({ getConfig, control: gate })) toolCtx.tools.register(tool)
            for (const tool of createWorkTools({ getConfig, runtime: work })) toolCtx.tools.register(tool)
          })
        },
      })
      if (gen !== state.gen) {
        await stop()
        return
      }
      snapshot = snap
      state.status = 'on'
      state.detail = '已启用'
    } catch (error) {
      snapshot = ''
      state.status = 'error'
      state.detail = 'Minecraft 成员工具挂载失败'
      log.warn?.('dsh-workbench: minecraft members start failed', error?.name || 'error')
    }
  }

  return {
    sync,
    bindControl(next) { bound = next || null },
    async dispose() {
      disposed = true
      state.gen++
      snapshot = ''
      await stop()
    },
    state() {
      return { status: state.status, detail: state.detail, mounted: state.fork != null }
    },
  }
}
