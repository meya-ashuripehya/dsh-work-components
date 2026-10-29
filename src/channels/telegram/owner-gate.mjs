/**
 * 授权用户闸门：只有授权用户（默认是「所有者用户 ID」）触发的回合才能用会改动本机的工具。
 *
 * 机制（不改 vendor 补丁文件，与 place.mjs / calendar.mjs 一样挂原型）：
 *   - ReplyContextStore.prototype.register：channel-harness 在每条入站消息 followup 之前调用，
 *     参数里的 senderId 来自 Telegram 适配器解析出的 from.id（或 sender_chat.id），不来自正文、
 *     元数据前缀、转发或引用内容，因此无法靠消息文字冒充。
 *   - ctx.tools.guard()：dsh-tools 的单调拒绝闸门，在 tools/pre-execute 之后、派发之前同步执行，
 *     任何监听都不能把拒绝改回允许。注册在插件上下文上 = 对所有 agent 生效，这里只拦本通道见过的会话。
 *
 * 判定按「当前这一轮」：会话从空闲到再次空闲之间收到的所有入站消息的发送者都必须是授权用户；
 * 其间只要有一条来自非授权用户（含插队消息），整轮的改动类工具都拒绝；
 * 本轮发送者未知同样拒绝（失败即关闭）。闸门只管「由 Telegram 入站消息触发的回合」：会话当前没有进行中的
 * Telegram 回合时（桌面 / 本地界面在已绑定的会话里发话、其他通道、从未投递过的会话），不介入。
 */

export const DENY_MESSAGE = '该请求来自非授权用户，无法使用会更改电脑的工具。'

/**
 * 任何人触发的回合都可以用的工具：不读写本机文件、不执行命令、不操控桌面、不代发消息。
 * 不在此表中的工具（含所有 MCP 工具、子智能体、run_code、读本机文件 / 截图）一律视为改动类，仅授权用户可用。
 * GPT Image 2 生图的 image_generate / image_edit 有意不列入：前者消耗 API 额度并写入数据目录，后者会读取本机任意图片并上传到第三方。
 */
export const OPEN_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'search_history',
  'search_pre_compaction',
  'get_time',
  'get_weather',
  'todo_write',
  'ask_user_question',
  'get_goal',
  'group_memory',
  'read_channel_attachment',
  'mm_send_image',
  'sticker_search',
  'sticker_send',
  // Cross-session memory (pull only). OPEN_TOOLS naming alone is not enough — tools also require
  // an owner-authorized turn + Memory Circle (see createOwnerGate.isAuthorizedTurn).
  'cross_session_list',
  'cross_session_search',
  // 棋类、牌类的看局面和出牌按座位校验，不在这里放行。开局、结束、重开会下载或写存档，仅所有者可用。
])

/**
 * 无论 OPEN_TOOLS 怎么改都只给所有者的工具前缀（会在服务器 / 本机上执行命令或改文件）。
 * Termalin：SSH 执行命令、读写远程文件。
 * KiCad：write / manufacturing 模式会改工程文件、出生产文件；只读模式按「MCP 工具仅所有者」的常规规则，同样只给所有者。
 * Fusion / FreeCAD / MATLAB / ESP-IDF / 串口 / Rhino / Altium：改设计、运行代码、烧录或写真实设备。
 */
export const OWNER_ONLY_PREFIXES = Object.freeze(['mcp__termalin__', 'mcp__kicad__', 'mcp__fusion__', 'mcp__freecad__', 'mcp__matlab__', 'mcp__espidf__', 'mcp__serial__', 'mcp__rhino__', 'mcp__altium__', 'mcp__windows__'])

export function isOwnerOnlyTool(name) {
  const n = String(name ?? '')
  return OWNER_ONLY_PREFIXES.some((p) => n.startsWith(p))
}

/** 按前缀对所有人开放的只读工具（DeepSlate 渲染：只读结构文件、生成预览图）。 */
export const OPEN_PREFIXES = Object.freeze(['mcp__deepslate__'])

export function isOpenTool(name) {
  const n = String(name ?? '')
  return !isOwnerOnlyTool(n) && (OPEN_TOOLS.has(n) || OPEN_PREFIXES.some((p) => n.startsWith(p)))
}

function idOf(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/**
 * @param {{ authorized: Iterable<string>, getAgent?: (sessionId: string) => any }} options
 */
export function createOwnerGate({ authorized, getAgent } = {}) {
  const allow = new Set([...(authorized ?? [])].map(idOf).filter(Boolean))
  const sessions = new Map()

  function watchIdle(sessionId, st, epoch) {
    queueMicrotask(async () => {
      let agent
      try { agent = getAgent?.(sessionId) } catch { agent = undefined }
      if (!agent || typeof agent.whenIdle !== 'function') return
      try { await agent.whenIdle() } catch { /* still end the turn */ }
      if (st.epoch === epoch) {
        st.active = false
        st.senders.clear()
        st.csCalls = 0
      }
    })
  }

  return {
    authorized: allow,
    /** 记录一条将要 followup 的入站消息（register 时调用）。 */
    noteTurn(sessionId, senderId) {
      const sid = idOf(sessionId)
      if (!sid) return
      let st = sessions.get(sid)
      if (!st) { st = { epoch: 0, active: false, senders: new Set() }; sessions.set(sid, st) }
      if (!st.active) { st.senders.clear(); st.active = true; st.csCalls = 0 }
      // 未知发送者记成空串：不在授权集合里，整轮拒绝。
      st.senders.add(idOf(senderId))
      const epoch = ++st.epoch
      watchIdle(sid, st, epoch)
    },
    /** tools.guard 回调：返回字符串即拒绝。 */
    check(exec) {
      const sid = idOf(exec?.agent?.id)
      if (!sid) return undefined
      const st = sessions.get(sid)
      if (!st) return undefined
      if (isOpenTool(exec?.name)) return undefined
      // No Telegram turn in progress: this turn was not triggered by a Telegram message (e.g. desktop UI
      // typing into a channel-bound session, scheduled wake) -- not this gate's business.
      if (!st.active) return undefined
      if (st.senders.size === 0) return DENY_MESSAGE
      for (const sender of st.senders) if (!sender || !allow.has(sender)) return DENY_MESSAGE
      return undefined
    },
    tracked(sessionId) { return sessions.has(idOf(sessionId)) },
    /**
     * True when this session has no in-progress channel turn, or every sender on the
     * active turn is authorized. Used by cross_session_* (OPEN_TOOLS alone is insufficient).
     */
    isAuthorizedTurn(sessionId) {
      const sid = idOf(sessionId)
      if (!sid) return false
      const st = sessions.get(sid)
      if (!st || !st.active) return true
      if (st.senders.size === 0) return false
      for (const sender of st.senders) if (!sender || !allow.has(sender)) return false
      return true
    },
    /** Per-turn call counter for cross_session_* budget (maxCallsPerTurn). */
    bumpCrossSessionCall(sessionId) {
      const sid = idOf(sessionId)
      if (!sid) return 1
      let st = sessions.get(sid)
      if (!st) {
        st = { epoch: 0, active: false, senders: new Set(), csCalls: 0 }
        sessions.set(sid, st)
      }
      if (typeof st.csCalls !== 'number') st.csCalls = 0
      st.csCalls += 1
      return st.csCalls
    },
  }
}

let activeGate = null

export function setActiveGate(gate) { activeGate = gate }
export function clearActiveGate(gate) { if (activeGate === gate) activeGate = null }
export function getActiveGate() { return activeGate }

/** 挂到 ReplyContextStore 原型（只挂一次）；之后由 setActiveGate 切换当前闸门。 */
export function installOwnerGate(ReplyContextStore) {
  const proto = ReplyContextStore?.prototype
  if (!proto || proto.__dshOwnerGate) return
  const original = proto.register
  proto.register = function register(messageId, pending) {
    try { activeGate?.noteTurn(pending?.sessionId, pending?.context?.senderId) } catch { /* never block delivery */ }
    return original.call(this, messageId, pending)
  }
  Object.defineProperty(proto, '__dshOwnerGate', { value: true })
}

/** 解析「授权用户 ID」：填写的列表优先，留空时回退到所有者用户 ID。 */
export function resolveAuthorizedIds(authorizedRaw, ownerId) {
  const list = String(authorizedRaw ?? '').split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
  for (const id of list) if (!/^-?\d{1,20}$/.test(id)) throw new Error(`授权用户 ID「${id}」不是 Telegram 数字用户 ID`)
  if (list.length) return [...new Set(list)]
  const owner = String(ownerId ?? '').trim()
  return owner ? [owner] : []
}