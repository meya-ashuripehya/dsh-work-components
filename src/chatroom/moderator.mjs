/**
 * 主持人：房间是唯一的事实来源，所有消息（用户、各 AI、工具输出）先写进房间，再转发 Telegram。
 *   - 用户新消息 = 新任务；主答取设置中的主答成员，消息里提到某位成员（@名字 或直接写名字，多位取最先出现的）则由它主答本任务，
 *     主答后其余 AI 依次轮询是否补充（可静默 PASS），
 *     AI 可交棒（[[NEXT: X]] / 「交给 X」），见 ./scheduler.mjs。同一房间任何时刻只有一个槽位在生成。
 *   - 预算：每任务合计 budget 个 AI 回合，AI 完全看不到（提示词不提预算，没有追加预算的工具）；用尽 → 停止调度，
 *     只给界面 / Telegram 一条系统提示；所有者回复「批准 +N」/「批准」（程序解析，消息不进房间记录）后追加并继续。
 *   - 过时：每次生成记下基于的房间消息 seq；写入前若有新消息：只有 AI / 工具消息 → 让该 AI 选择 SEND / REVISE / DROP；
 *     有新用户消息 → 丢弃草稿，转向最新消息（新任务）。
 *   - cursor_handoff：领队（GPT）提交任务书 → 房间记录 + 待执行；所有者回复「执行」后运行 cursor-agent，结果 JSON 写回房间。
 *   - 插话熔断：任何人的新消息立即中止进行中的座位生成（棋局除外），并中止本房间正在跑的 Cursor 任务（卡片变为空白「已熔断」）；
 *     「执行」本身也算插话——先中止当前座位 / 作废旧任务，再启动 Cursor（不另开讨论轮）。
 *   - end_round：只结束当前讨论轮（不再请其他成员）；不中止 Cursor 交接——交卷唤醒照常。只有取消 / 插话熔断 / DSH 关闭（stopAll）才会空白 Cursor 卡。
 * 附件：用户消息可带 attachments（快照，见 ./attachments.mjs）；视觉成员（isVision(seat)）每次调用最多 9 张真图——
 *   历史中最新的图片 + 本回合 view_attachment 取回的图片合计不超过 9 张，取回的越多，历史里作为真图的越少（较早的变为占位）。
 *   send_attachment 的结果以该成员的消息（带附件）写进房间，并经其机器人发到绑定群（tg.relayAttachments）。
 * 失败的回合不入历史：一个回合内产生的房间消息（工具调用记录、重复调用拦截、墙钟收尾提示）先暂存（turn buffer），
 *   界面上以「进行中」显示（message 事件带 pending）；回合成功（含 PASS / 被新消息转向 / 过时丢弃）时按顺序写入房间并转发 Telegram，
 *   失败（服务商报错、异常、非用户发起的中断）时全部撤回（retract 事件），删除本回合新建的工具结果文件，
 *   只发一个不入库的 turn-failed 事件（界面提示）；任务来自 Telegram 时另由接收机器人在群里发一句不入库的说明。
 *   实时：已完成并返回结果的工具卡片（keep）在工具执行完时立即写入房间并转发 Telegram（不再等回合结束），正文仍在回合结束后追加；
 *   回合失败 / 被打断 / 被停止时这些卡片已在房间里，只补记 salvaged 标记。只有重复调用拦截与墙钟收尾提示仍暂存，失败时撤回。
 *   send_attachment（及内置的 mm_send_image / mm_send_file）在工具执行时立即发送到房间及绑定群（每次调用只发一次），投递结果写进工具结果；结果另留一张卡片（不转发 Telegram）。
 *   用户「停止」：保留已产生的内容（工具记录 + 已生成的部分文字，状态 stopped）。
 * 房间控制工具（./room-control.mjs：切换主答 / 领队）：回合内只预约，回合成功后才生效并写系统通知；
 *   失败或「停止」时取消，不生效、不留通知。主答 / 领队写入设置（saveRoomControl），并发 room-config 事件让界面刷新。
 * 依赖全部注入，不碰 UI、设置结构与网络细节。
 */
import { buildPrompt } from './transcript.mjs'
import { parseCompactCommand } from './directives.mjs'
import { PASS_TOKEN, isPass, stripSelfPrefix, parseHandoff, firstNamedSeat, parseOwnerCommand, parseCursorDirective, parseStaleDecision, findSeat } from './directives.mjs'
import { createTask, nextSpeaker, recordTurn, extendBudget, setMain, staleness } from './scheduler.mjs'
import { CURSOR_TOOL, CURSOR_TOOL_NAME, normalizeHandoffArgs, jsonSafe, toolSummaryLine, briefRelayLine, cursorDeeplink, cursorReport, cursorStepTracker, isBriefContinuable } from './cursor.mjs'
import { isOwnerMessage } from './tool-gate.mjs'
import { TOOL_DEFAULTS } from './tool-results.mjs'
import { IMAGE_WINDOW } from './attachments.mjs'
import { isNativeGeminiSeat } from './gemini-seat.mjs'
import { ROOM_CONTROL_TOOLS, ROOM_CONTROL_NAMES, SET_MAIN_NAME, SET_LEADER_NAME, END_ROUND_NAME, endRoundTool, canEndRound, endRoundNotice, resolveMember, controlState, checkSwitch, controlNotice } from './room-control.mjs'
import { CARD_BIN_TOOLS, CARD_BIN_NAMES, SWEEP_CARDS_NAME, LIST_BIN_NAME, binOf, binnedSet, planSweep, planRestore, listBinText, isCardMsg, cardRef, binNoteText } from './card-bin.mjs'
import { randomBytes } from 'node:crypto'
import { isRepeatExempt } from './repeat-guard.mjs'
import { isStreamDropFailure, hasStreamed } from './providers.mjs'
import { estimateTokens, estimateRequestTokens, effectiveThreshold, IMAGE_TOKENS } from './ctx-compress.mjs'

const noopTg = { typing: () => () => {}, relay: async () => [] }
const pendingId = () => 'msg-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')

/** 失败原因 → 简短、可读的一句（不含堆栈；长度受限）。 */
export function failureReason(e) {
  const s = String(e?.message || e || '未知错误').replace(/\s+/g, ' ').trim()
  return (s || '未知错误').slice(0, 300)
}

/** 上游中转冷却 / 额度不足时给用户看的一句（原始错误保留在 detail 与调用日志）。 */
export const UPSTREAM_UNAVAILABLE_TEXT = '上游服务暂时不可用（冷却或额度不足），请稍后重试或更换线路'
/** 上游长上下文计费门槛（tokens）：估计值低于其 90% 时，「long context」报错按冷却 / 额度处理。 */
export const LONG_CONTEXT_LIMIT = 200000
const COOLDOWN_RE = /downstream session is cooling down|cooling down|cool-?down|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|insufficient (?:quota|balance|credits?)|credit balance is too low|out of credits|usage limit (?:reached|exceeded)|额度不足|余额不足|冷却中/i
const LONG_CTX_RE = /extra usage is required for long context|long context requests? (?:require|are not)/i
export const isLongContextError = (e) => !!e && !e.aborted && LONG_CTX_RE.test(String(e?.message || '') + ' ' + String(e?.code || ''))
/**
 * 中转站（如 micuapi）偶发的笼统 400：「Invalid request. Please check the format and content of your request」
 * 常伴 type:<nil>（Go 网关 nil）与双重 request id；不是 Anthropic 原生的 invalid_request_error（那种会指出具体字段）。
 * 同一提示词随后又能成功 → 按上游瞬时故障处理（重试 + 归一文案），不当作本机请求体错误。
 */
const GATEWAY_INVALID_RE = /Invalid request\. Please check the format and content of your request/i
export function isGatewayBogusInvalidRequest(e) {
  if (!e || e.aborted) return false
  const s = String(e.message || '') + ' ' + String(e.code || '')
  if (!GATEWAY_INVALID_RE.test(s)) return false
  // 真·Anthropic 校验失败通常带字段路径（messages. / max_tokens / tools.）；有这些时不按网关假 400 处理
  if (/\b(?:messages|max_tokens|tools|system|temperature|top_p|thinking|output_config)\s*[.\[:]/i.test(s) && !/type\s*:\s*<nil>/.test(s)) return false
  return true
}
/** Wrap an upstream error under a Chinese message, keeping the original text in detail / cause. */
function wrapUpstream(e, text, code, extra = {}) {
  const out = new Error(text)
  try { Object.assign(out, { code, status: e.status, detail: String(e?.message || e || '').slice(0, 1000), cause: e, upstream: true, ...(e.hadImages ? { hadImages: true } : {}), ...(e.partial ? { partial: e.partial } : {}), ...extra }) } catch {}
  return out
}
/**
 * 中转报错归一：冷却 / 额度类、网关笼统 Invalid request 400，以及估计远低于长上下文门槛时的「Extra usage is required for long context」→ UPSTREAM_UNAVAILABLE_TEXT。
 * 估计确实超过门槛时返回原错误并标记 longContext（调用方压缩后重试一次）。其他错误原样返回。
 */
export function normalizeUpstreamError(e, { estimate = 0 } = {}) {
  if (!e || typeof e !== 'object' || e.aborted || e.upstream) return e
  const s = String(e.message || '') + ' ' + String(e.code || '')
  if (isLongContextError(e)) {
    if (estimate >= LONG_CONTEXT_LIMIT * 0.9) { try { e.longContext = true; e.requestTokens = estimate } catch {} return e }
    return wrapUpstream(e, UPSTREAM_UNAVAILABLE_TEXT, 'UPSTREAM_UNAVAILABLE')
  }
  if (isGatewayBogusInvalidRequest(e)) return wrapUpstream(e, UPSTREAM_UNAVAILABLE_TEXT, 'UPSTREAM_UNAVAILABLE')
  if (COOLDOWN_RE.test(s)) return wrapUpstream(e, UPSTREAM_UNAVAILABLE_TEXT, 'UPSTREAM_UNAVAILABLE')
  return e
}
/** 估计确实超过长上下文门槛、压缩不可用或无效时的报错。 */
export function longContextFailure(e) {
  const n = Math.round((Number(e?.requestTokens) || 0) / 1000)
  return wrapUpstream(e, `请求上下文过长（约 ${n}k tokens），超过上游长上下文限制；请在聊天室设置中选择摘要模型以启用自动压缩，或手动压缩上下文后重试。`, 'LONG_CONTEXT')
}

/** 每回合工具循环默认最多步数（cfg.tools.maxSteps 可覆盖）。 */
export const DEFAULT_TOOL_STEPS = 40
/** 每回合工具结果合计的估计 token 上限（cfg.tools.turnResultTokens 可覆盖）。 */
export const DEFAULT_TURN_RESULT_TOKENS = 60000
const shrunkResults = new WeakSet()
const resultTokens = (e) => estimateTokens(e?.toolResult?.text) + (Array.isArray(e?.toolResult?.images) ? e.toolResult.images.length * IMAGE_TOKENS : 0)
/**
 * Keep in-turn tool results under cap: when the total is over, shrink older results (index < keepFrom) to a short line,
 * oldest first. Returns { total, shrunk, over } (over = still above cap after shrinking).
 */
export function capToolResults(extra, { cap = DEFAULT_TURN_RESULT_TOKENS, names = new Map(), keepFrom } = {}) {
  const list = Array.isArray(extra) ? extra : []
  const end = keepFrom === undefined ? list.length : keepFrom
  let total = 0
  for (const e of list) if (e?.toolResult) total += resultTokens(e)
  let shrunk = 0
  for (let i = 0; i < end && total > cap; i++) {
    const e = list[i]
    if (!e?.toolResult || shrunkResults.has(e.toolResult)) continue
    const tr = e.toolResult
    const before = resultTokens(e)
    const first = (String(tr.text || '').split('\n').find((l) => l.trim()) || '').trim()
    const name = names.get(tr.toolCallId) || 'tool'
    tr.text = `[${name}] ${first.slice(0, 160)}${first.length > 160 ? '…' : ''}\n(Older tool result shortened to save context. Call the tool again if you really need the full result.)`
    if (tr.images) delete tr.images
    shrunkResults.add(tr)
    total -= before - resultTokens(e)
    shrunk++
  }
  return { total, shrunk, over: total > cap }
}

/** 服务商的临时故障（过载 / 限流 / 超时 / 网络）。曾用于「暂时离开」时长；现失败后仍保留席位，下轮照常安排。 */
export function isTransientFailure(e) {
  if (e?.aborted) return true
  const s = String(e?.code || '') + ' ' + String(e?.status || '') + ' ' + String(e?.message || e || '')
  return /UPSTREAM_UNAVAILABLE|cooling down|overload|concurren|gateway|capacity|try again|transport failed|terminated|other side closed|UND_ERR_SOCKET|\b(?:429|500|502|503|504|520|522|524|529)\b|rate.?limit|too many requests|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|temporarily|unavailable|busy|超时|繁忙|过载|限流|网络|中断/i.test(s)
}
/** 失败后在本房间跳过该成员的时长：临时故障 2 分钟，其他错误（凭据、配置等）5 分钟。 */
export const AWAY_TRANSIENT_MS = 2 * 60 * 1000
export const AWAY_OTHER_MS = 5 * 60 * 1000
/** 传输层断开后整步重新请求的次数与间隔（见 callLogged）。 */
export const STREAM_DROP_RETRIES = 1
export const STREAM_DROP_RETRY_MS = 1000
/** 中转笼统 Invalid request 400：整步重试次数与间隔（无输出、无副作用，与 stream drop 相同）。 */
export const GATEWAY_INVALID_RETRIES = 2
export const GATEWAY_INVALID_RETRY_MS = 1500
const abortableDelay = (ms, signal) => new Promise((resolve) => {
  if (!ms || signal?.aborted) return resolve()
  const t = setTimeout(done, ms)
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve() }
  signal?.addEventListener?.('abort', done, { once: true })
})

/** 回合上限提示（只给界面与 Telegram 群）。 */
export const budgetExhaustedText = (task) => `本轮已达回合上限（${task.used}/${task.budget}），回复「批准 +N」继续。`

/** 服务商因图片输入拒绝请求（dsh-llm UNSUPPORTED_CONTENT，或适配器的「does not support image input」）。 */
export function isImageRejection(e) {
  if (!e || e.aborted) return false
  if (e.code === 'UNSUPPORTED_CONTENT') return true
  return /does not support image|image input requires|cannot represent .*image|image content/i.test(String(e.message || ''))
}

/**
 * 服务商因内容政策拦截请求（如 Anthropic「blocked as it seems to violate … Terms of Service」「reverse engineering or duplicating
 * model outputs」、各类 content policy / safety 拒绝）。只在请求带图片时按「图片被拦截」处理（见 imagePolicyBlock）。
 */
export function isPolicyBlock(e) {
  if (!e || e.aborted) return false
  const s = String(e.message || '') + ' ' + String(e.code || '')
  return /blocked as it seems to violate|terms of service|reverse engineering or duplicating|usage polic(?:y|ies)|content[\s_-]*polic(?:y|ies)|policy[\s_-]*violation|violat\w* (?:our|the|its) (?:polic|guideline|terms)|safety (?:system|filter)|content (?:was )?(?:blocked|filtered|flagged)|data_inspection_failed|inappropriate content|sensitive content/i.test(s)
}
/** 带图片的请求被内容政策拦截（callLogged 会给错误标上 hadImages）。 */
export const imagePolicyBlock = (e) => !!(e && e.hadImages) && isPolicyBlock(e)
/** 图片被拦截后暂停向该路由发送真图的时长。 */
export const POLICY_PAUSE_MS = 45 * 60000
/** 图片被拦截、本轮改用文字描述时给用户的提示（不进 AI 的上下文）。 */
export const POLICY_FALLBACK_NOTICE = '图片被服务商拦截，已改用文字描述'
const countImages = (msgs) => (msgs || []).reduce((n, m) => n + (Array.isArray(m?.images) ? m.images.length : 0) + (Array.isArray(m?.toolResult?.images) ? m.toolResult.images.length : 0), 0)

export const GAME_STEP_MS = 120000

/** 看不到图的成员建提示词前，最多等这么久让入库后的图片描述生成完（避免拿到「no description yet」）。 */
export const DESCRIBE_WAIT_MS = 20000

const abortedError = () => Object.assign(new Error('已停止'), { aborted: true })
/** 等 p；signal 中止时立刻抛出（工具 / 请求本身可能不理会 signal，结果随后被忽略）。 */
export function untilAborted(p, signal) {
  if (!signal) return p
  if (signal.aborted) { Promise.resolve(p).catch(() => {}); return Promise.reject(abortedError()) }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(p).then((v) => { signal.removeEventListener('abort', onAbort); resolve(v) }, (e) => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}

/**
 * 一个回合自己的中止控制：房间循环的 controller（「停止」/ 棋局超时）中止时跟着中止；
 * 另外可以单独「打断」（interrupt）：用户发来新消息时立即中止进行中的请求与工具循环，回合按失败回滚，不入库、不提示 AI。
 * 棋局回合不打断（棋局进行中用户的聊天不改变调度，见 ensureLoop）。
 */
export function newTurnControl(parent, { gameTurn = false } = {}) {
  const ctl = new AbortController()
  const t = { ctl, gameTurn: !!gameTurn, interrupted: false }
  const onParent = () => { try { ctl.abort() } catch {} }
  if (parent?.signal?.aborted) ctl.abort()
  else parent?.signal?.addEventListener('abort', onParent, { once: true })
  t.interrupt = () => {
    if (t.gameTurn || ctl.signal.aborted) return false
    t.interrupted = true
    try { ctl.abort() } catch {}
    return true
  }
  t.dispose = () => { try { parent?.signal?.removeEventListener('abort', onParent) } catch {} }
  return t
}

/** 提供工具的步骤至少给这么多输出 token：上限太低时模型的工具调用会在 max-tokens 处被整个丢掉。不设上限（0）时不强制下限。 */
export const TOOL_STEP_MIN_TOKENS = 4096
export const toolStepTokens = (cfg) => {
  const cap = Number(cfg?.maxTokens) || 0
  if (cap <= 0) return 0
  return Math.max(cap, TOOL_STEP_MIN_TOKENS)
}

/** max-tokens 截断导致工具调用没有执行 / 回复为空时，给所有者看的一行（不进 AI 提示词）。 */
export function truncationNote(seat, out, maxTokens) {
  if (out?.finish !== 'max-tokens') return ''
  const dropped = Number(out.droppedToolCalls) || 0
  if (!dropped && String(out.text || '').trim()) return ''
  const cap = Number(maxTokens) || 0
  const capText = cap > 0 ? `${cap} tokens` : '服务商上限'
  return `${seat?.name || '成员'} 的输出达到长度上限（${capText}）被截断${dropped ? `，${dropped} 个工具调用未执行` : '，可能有工具调用未执行'}。如经常出现，可在聊天室设置中调高「单次输出上限」（0 或不填表示不设上限）。`
}

export function createModerator({ store, getRoomConfig, resolvePersona = () => '', call, emit = () => {}, tg = noopTg, runCursor, toolkit = null, isVision = async () => false, onVisionRejected = () => {}, saveRoomControl = null, games = null, logCall = null, pendingDescriptions = null, presetNames = null, now = () => Date.now(), streamRetryMs = STREAM_DROP_RETRY_MS, ensureContext = null, compactContext = null, contextWindowOf = null, resolveMcInfo = null }) {
  /** 调试日志（只记元数据）；失败不影响聊天。 */
  const logStep = (x) => { try { void Promise.resolve(logCall?.(x)).catch(() => {}) } catch {} }
  /** 调用一次模型并记日志；截断丢工具时写一条只给所有者看的系统提示。 */
  // 传输层断开（见 providers.isStreamDropFailure）时整步重新请求一次：这一步的工具还没执行、正文还没写入，重试不会重复任何副作用；
  // 已流出的部分正文 / 思考只在界面的临时行里，重试前发一个 turn 事件让界面清掉这一行重新开始。
  async function callLogged(roomId, seat, req, { step = 0, kind = 'turn' } = {}) {
    const images = countImages(req.prompt?.messages)
    let out
    let t0 = now()
    for (let attempt = 1; ; attempt++) {
      t0 = now()
      try { out = await call({ ...req, roomId }); break } catch (e) {
        if (images && e && typeof e === 'object') { try { e.hadImages = true } catch {} }
        const gatewayBad = isGatewayBogusInvalidRequest(e)
        const drop = isStreamDropFailure(e)
        const maxRetry = gatewayBad ? GATEWAY_INVALID_RETRIES : STREAM_DROP_RETRIES
        const retry = attempt <= maxRetry && !req.signal?.aborted && (drop || gatewayBad)
        logStep({ roomId, seat, step, kind, images, toolsOffered: req.tools?.length || 0, maxTokens: req.maxTokens, error: e, ms: now() - t0, at: now(), attempt, retrying: retry })
        if (!retry) throw normalizeUpstreamError(e, { estimate: estimateRequestTokens({ system: req.prompt?.system, messages: req.prompt?.messages, tools: req.tools }) })
        if (hasStreamed(e?.partial)) { try { emit(roomId, { type: 'turn', seatId: seat?.id || '', name: seat?.name || '', model: seat?.model || '', retry: attempt }) } catch {} }
        await abortableDelay(gatewayBad ? GATEWAY_INVALID_RETRY_MS : streamRetryMs, req.signal)
        if (req.signal?.aborted) throw e
      }
    }
    logStep({ roomId, seat, step, kind, images, toolsOffered: req.tools?.length || 0, maxTokens: req.maxTokens, out, ms: now() - t0, at: now() })
    const note = req.tools?.length ? truncationNote(seat, out, req.maxTokens) : ''
    if (note) { try { await system(roomId, note, { relay: false, notice: 'truncated' }) } catch {} }
    return out
  }
  /**
   * Before a member's request: estimate the real request (system/persona + room rules + tool schemas + built messages + summary)
   * and auto-compress when it exceeds min(threshold, 75% of the model's context window). Returns true if the context was compacted.
   */
  async function ensureForRequest(roomId, seat, cfg, req, signal) {
    if (typeof ensureContext !== 'function') return false
    let cw = 0
    if (typeof contextWindowOf === 'function') { try { cw = Number(await contextWindowOf(seat)) || 0 } catch { cw = 0 } }
    const threshold = effectiveThreshold(cfg?.contextTokenThreshold, cw)
    const requestTokens = estimateRequestTokens(req)
    if (requestTokens < threshold) return false
    let r
    try { r = await ensureContext(roomId, { signal, requestTokens, threshold }) } catch { return false }
    return !!(r && r.ok && !r.skipped)
  }
  /** 带图请求被内容政策拦截：记一条日志、给用户一条简短提示（relay:false，不发 Telegram；系统消息不进 AI 上下文）。 */
  async function notePolicyFallback(roomId, seat, step, e) {
    logStep({ roomId, seat, step, kind: 'policy-fallback', fallback: 'request with images blocked by provider policy; retrying with text descriptions only', error: e, ms: 0, at: now() })
    try { emit(roomId, { type: 'vision-blocked', seatId: seat.id }) } catch {}
    try { await system(roomId, POLICY_FALLBACK_NOTICE, { relay: false, notice: 'image-blocked' }) } catch {}
  }
  /** 「发送图片：仅最新消息」的成员：view_attachment 只对本轮已作为真图发送的图片给原图，其余给文字描述。 */
  function toolVision(seat, c, vision, prompt) {
    if (!vision || seat?.imageWindow !== 'latest' || c?.name !== 'view_attachment') return vision
    let a = c.arguments
    if (typeof a === 'string') { try { a = JSON.parse(a || '{}') } catch { a = {} } }
    const id = String(a?.id || '').trim().replace(/^#/, '')
    return (prompt?.realImages || []).includes(id)
  }
  const runs = new Map() // roomId → { controller, seatId, promise, pendingUser }
  const tasks = new Map() // roomId → task
  const cursorRuns = new Map() // roomId → { controller, briefId, cancelled, card, promise }
  // 失败后「暂时离开」机制已停用（仍保留 Map，避免旧路径引用）；失败仅提示，席位下轮照常
  const away = new Map() // roomId\0seatId → until
  const awayKey = (roomId, id) => roomId + '\u0000' + id
  const isAway = (roomId, id) => { const u = away.get(awayKey(roomId, id)); if (!u) return false; if (u > now()) return true; away.delete(awayKey(roomId, id)); return false }
  const back = (roomId, id) => away.delete(awayKey(roomId, id))
  function markAway(roomId, seat, e) {
    if (!seat?.id) return 0
    const until = now() + (isTransientFailure(e) ? AWAY_TRANSIENT_MS : AWAY_OTHER_MS)
    away.set(awayKey(roomId, seat.id), until)
    return until
  }
  // 点名主答也认成员预设的显示名：presetNames()（预设编号 → 显示名，可返回 Promise）在每条用户消息进来时刷新一次
  let knownPresets = {}
  async function refreshPresetNames() {
    if (typeof presetNames !== 'function') return
    try { const m = await presetNames(); if (m && typeof m === 'object') knownPresets = m } catch {}
  }
  const awayNames = (roomId, seats, selfId) => seats.filter((s) => s.id !== selfId && s.enabled !== false && isAway(roomId, s.id)).map((s) => s.name)
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
      if (Array.isArray(saved.attachments) && saved.attachments.length && typeof tg.relayAttachments === 'function') {
        void Promise.resolve(tg.relayAttachments(relaySeat || null, roomId, saved, { prefixName: prefixName || saved.speaker?.name })).catch(() => {})
      } else {
        const text = saved.kind === 'tool' ? toolSummaryLine(saved) : saved.kind === 'brief' ? briefRelayLine(saved) : saved.text
        void Promise.resolve(tg.relay(relaySeat || null, roomId, text, { prefixName: prefixName || saved.speaker?.name })).catch(() => {})
      }
    }
    return saved
  }
  /** 回合暂存：消息先只推给界面（pending），成功后 commitTurn 才写入房间。 */
  const newTurnBuffer = () => ({ items: [], posts: [], effects: [] })
  /** keep：工具已完成并返回结果（成功或空白）、且没有推迟的副作用——回合失败 / 被打断 / 被停止时这张卡片保留。 */
  async function stage(roomId, buf, msg, opts = {}, { keep = false } = {}) {
    const m = { id: pendingId(), ts: new Date(now()).toISOString(), status: 'ok', ...msg }
    if (keep) {
      // 实时：完成的工具卡片立即入库、推给界面并转发 Telegram（同一编号；回合结束不再重复写入）
      const { ts, ...rest } = m
      const saved = await appendAndEmit(roomId, rest, opts)
      buf.items.push({ msg: saved, opts, keep: true, persisted: true })
      return saved
    }
    buf.items.push({ msg: m, opts, keep: false })
    emit(roomId, { type: 'message', message: { ...m, pending: true }, pending: true })
    return m
  }
  /** 写入暂存的消息（保持编号，界面据此把「进行中」替换为正式记录）；deliver：是否执行推迟的 send_attachment。 */
  async function commitTurn(roomId, buf, seat, task, { deliver = true } = {}) {
    const items = buf.items.splice(0)
    const posts = buf.posts.splice(0)
    for (const it of items) {
      if (it.persisted) continue
      const { ts, ...m } = it.msg
      await appendAndEmit(roomId, m, it.opts)
    }
    if (deliver) for (const p of posts) await deliverPost(roomId, seat, task, p)
    const effects = buf.effects.splice(0)
    if (deliver) for (const ef of effects) await applyEffect(roomId, ef)
    else for (const ef of effects) ef.release()
  }
  /**
   * 回合失败 / 被打断 / 被停止：AI 的正文不写入；推迟的副作用全部撤销（排队的发送不发、回收站与房间控制不生效），
   * 它们的卡片、被拦下的重复调用和收尾提示一并撤回（删除本回合新建的结果文件；与之前结果相同而复用的不删）。
   * 已完成并返回结果的工具卡片（成功或空白）照常写入房间，署名该成员，之后所有人（包括其重试）都能 open_card；
   * 保留的卡片不转发 Telegram。返回保留的张数。
   */
  async function rollbackTurn(roomId, buf) {
    const items = buf.items.splice(0)
    buf.posts.length = 0
    for (const ef of buf.effects.splice(0)) ef.release()
    const keep = items.filter((it) => it.keep)
    const drop = items.filter((it) => !it.keep)
    const keptFiles = new Set(keep.map((it) => it.msg.data?.resultId).filter(Boolean))
    for (const it of drop) {
      const d = it.msg.data
      if (d?.resultId && !d.dedupeOf && !keptFiles.has(d.resultId) && typeof toolkit?.results?.remove === 'function') {
        try { await toolkit.results.remove(roomId, d.resultId) } catch {}
      }
    }
    if (drop.length) emit(roomId, { type: 'retract', ids: drop.map((x) => x.msg.id) })
    for (const it of keep) {
      if (it.persisted) {
        // 已实时写入：只补记 salvaged（不重复写入、不再转发）
        let m = null
        if (typeof store.updateMessage === 'function') { try { m = await store.updateMessage(roomId, it.msg.id, (x) => ({ ...x, salvaged: true })) } catch {} }
        if (m) emit(roomId, { type: 'message-update', message: m })
        continue
      }
      const { ts, ...m } = it.msg
      await appendAndEmit(roomId, { ...m, salvaged: true }, { ...it.opts, relay: false })
    }
    return keep.length
  }
  /** 失败提示：不入库。界面收到 turn-failed（提示 + 临时行）；任务来自 Telegram 时由接收机器人在群里说一句（同样不入库）。
   * 默认不「暂时离开」：席位保持可用，下一轮到其发言时照常继续。 */
  function announceFailure(roomId, seat, task, e, { away: doAway = false } = {}) {
    const reason = failureReason(e)
    const until = doAway ? markAway(roomId, seat, e) : 0
    const mins = until ? Math.round((until - now()) / 60000) : 0
    emit(roomId, { type: 'turn-failed', seatId: seat?.id || '', name: seat?.name || '', model: seat?.model || '', reason, ...(e?.detail ? { detail: String(e.detail).slice(0, 1000) } : {}), ...(until ? { awayUntil: new Date(until).toISOString(), awayMinutes: mins } : {}), at: new Date(now()).toISOString() })
    if (task?.source === 'telegram') {
      const line = `${seat?.name || '成员'} 本轮回复失败：${reason.slice(0, 200)}。本轮未计入聊天记录${mins ? `，接下来 ${mins} 分钟内暂不安排其发言` : ''}。`
      void Promise.resolve(tg.relay(null, roomId, line, { prefixName: '聊天室' })).catch(() => {})
    }
  }

  const system = (roomId, text, extra = {}) => appendAndEmit(roomId, { kind: 'system', speaker: { id: 'system', name: '聊天室' }, text, ...extra }, { relay: extra.relay !== false, prefixName: '聊天室' })

  /** 看不到图的成员：房间正在为刚入库的图片生成描述时，最多等 DESCRIBE_WAIT_MS（被停止 / 打断时立即放弃）。 */
  async function awaitDescriptions(roomId, signal) {
    if (typeof pendingDescriptions !== 'function') return
    let ps
    try { ps = pendingDescriptions(roomId) } catch { return }
    if (!Array.isArray(ps) || !ps.length || signal?.aborted) return
    let timer
    let onAbort
    await Promise.race([
      Promise.allSettled(ps),
      new Promise((r) => { timer = setTimeout(r, DESCRIBE_WAIT_MS); timer.unref?.() }),
      new Promise((r) => { if (signal) { onAbort = r; signal.addEventListener('abort', r, { once: true }) } }),
    ])
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }

  async function promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow = IMAGE_WINDOW, messages, signal } = {}) {
    let presetPersona = ''
    if (seat.preset) presetPersona = String(await resolvePersona(seat) || '')
    const main = cfg.seats.find((s) => s.id === task?.main)
    const tc = toolCfg(cfg)
    const toolsInfo = toolsOn(cfg) ? { owner: task?.owner !== false, finder: tc.enabled !== false, attachments: attachOn(cfg), ...(canEndRound(seat, task) ? { endRound: true } : {}) } : null
    if (vision === undefined) vision = await visionOf(seat)
    const history = messages || await store.readMessages(roomId)
    const binned = await binnedOf(roomId, history)
    let contextSummary = ''
    let contextUntilSeq = 0
    try {
      const meta = await store.getRoom(roomId)
      const cs = meta?.contextSummary
      if (cs && typeof cs === 'object') {
        contextSummary = String(cs.text || '').trim()
        contextUntilSeq = Math.max(0, Math.floor(Number(cs.untilSeq) || 0))
      }
    } catch {}
    const visionRelay = !!vision && /-vision$/i.test(String(seat.provider || ''))
    // 图片：看不到图的成员等描述；视频：所有成员都等「内容描述」（上限同为 DESCRIBE_WAIT_MS）
    const wantsImages = (!vision || visionRelay) && history.some((m) => Array.isArray(m.attachments) && m.attachments.some((a) => a?.kind === 'image'))
    const wantsVideos = history.some((m) => [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.videoLinks) ? m.videoLinks : [])].some((a) => a?.kind === 'video'))
    if (attachOn(cfg) && (wantsImages || wantsVideos)) await awaitDescriptions(roomId, signal)
    const videoInput = seat.video === true && isNativeGeminiSeat(seat) && attachOn(cfg) && cfg.attachments?.video !== false
    let attachmentMeta
    // 只有房间里确有附件时才读附件索引（描述 / 转写在入库后补上）
    if (attachOn(cfg) && history.some((m) => (Array.isArray(m.attachments) && m.attachments.length) || (Array.isArray(m.videoLinks) && m.videoLinks.length))) { try { attachmentMeta = await toolkit.attachments.list(roomId) } catch { attachmentMeta = undefined } }
    let mcInfo = null
    if (typeof resolveMcInfo === 'function') {
      try { mcInfo = await resolveMcInfo(seat) } catch { mcInfo = null }
    }
    return buildPrompt({ seat: { ...seat, presetPersona }, seats: cfg.seats, userName: cfg.userName, rules: cfg.rules, messages: history, maxHistory: cfg.maxHistory || 0, mainName: main?.name, away: awayNames(roomId, cfg.seats, seat.id), extraUser, toolsInfo, vision: !!vision && cfg.attachments?.enabled !== false, visionRelay, imageWindow, attachmentMeta, binned, videoInput, contextSummary, contextUntilSeq, mcInfo })
  }

  /** 房间回收站里（且确实存在）的卡片消息 id。 */
  async function binnedOf(roomId, history) {
    try { return binnedSet(history, binOf(await store.getRoom(roomId))) } catch { return new Set() }
  }
  /** 本回合预约的收进 / 取回叠加到已存的回收站上（list_bin / 重复收取时用）。 */
  function effectiveBin(bin, buf) {
    const out = { ...bin }
    for (const ef of buf.effects) if (ef.kind === 'bin') for (const id of ef.ids) { if (ef.op === 'sweep') out[id] = { by: ef.by.name }; else delete out[id] }
    return out
  }

  /**
   * 回收站工具：list_bin 立即返回；sweep_cards / restore_cards 预约（buf.effects），回合成功提交时 applyBin 生效，失败 / 打断时随回合撤销。
   * 返回 { text, isError }（text 英文，给模型）。不产生卡片：生效时 applyBin 只写一行界面提示。
   */
  async function cardBinTool(roomId, seat, task, buf, call) {
    let args = call.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}') } catch { return { isError: true, text: 'Arguments are not valid JSON.' } } }
    args = args && typeof args === 'object' ? args : {}
    if (typeof store.patchMeta !== 'function') return { isError: true, text: 'The recycle bin is not available in this environment.' }
    const messages = await store.readMessages(roomId)
    let meta = {}
    try { meta = await store.getRoom(roomId) } catch {}
    const bin = effectiveBin(binOf(meta), buf)
    if (call.name === LIST_BIN_NAME) return { text: listBinText(messages, bin, args) }
    const turnRefs = new Set(buf.items.map((it) => it.msg?.data?.resultId).filter(Boolean))
    if (call.name === SWEEP_CARDS_NAME) {
      const roundSeq = Number(task?.basedOn) > 0 ? Number(task.basedOn) : 0
      const p = planSweep(messages, bin, { ids: args.ids, before: args.before, roundSeq, turnRefs })
      const notes = []
      if (p.current.length) notes.push(`#${p.current.join(', #')} came from your current turn and stays on the table.`)
      if (p.unknown.length) notes.push(`No card #${p.unknown.join(', #')} in this room.`)
      if (p.already) notes.push(`${p.already} already in the bin.`)
      if (!p.ids.length) return { isError: !!(p.unknown.length || p.current.length), text: ['Nothing to sweep.', ...notes].join(' ') }
      buf.effects.push({ tool: call.name, kind: 'bin', op: 'sweep', ids: p.ids, by: seat, task, release() {} })
      const n = p.ids.length
      return {
        text: [`OK: ${n} card${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} into the recycle bin when your turn ends (${p.refs.slice(0, 12).map((r) => '#' + r).join(', ')}${p.refs.length > 12 ? ', …' : ''}). They stay readable with open_card.`, ...notes].join(' '),
      }
    }
    const p = planRestore(messages, bin, { ids: args.ids })
    const notes = []
    if (p.unknown.length) notes.push(`No card #${p.unknown.join(', #')} in this room.`)
    if (p.notBinned.length) notes.push(`#${p.notBinned.join(', #')} ${p.notBinned.length === 1 ? 'is' : 'are'} not in the bin.`)
    if (!p.ids.length) return { isError: true, text: ['Nothing to restore.', ...notes].join(' ') }
    buf.effects.push({ tool: call.name, kind: 'bin', op: 'restore', ids: p.ids, by: seat, task, release() {} })
    const n = p.ids.length
    return {
      text: [`OK: ${n} card${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} back on the table when your turn ends.`, ...notes].join(' '),
    }
  }

  /**
   * 改写回收站（串行写 meta.json）：op = 'sweep' | 'restore'；顺带清掉指向已不存在消息的条目。
   * 有变化时推送 card-bin 事件并写一条只给界面看的系统提示（不发 Telegram，不进提示词，不算新消息），写明卡片名；
   * 房间最后一条正是同一人同一操作的回收站提示时，合并进那一行（改写原消息）。返回变化的条数。
   */
  async function applyBin(roomId, { op, ids, byName, byUser = false }) {
    const messages = await store.readMessages(roomId)
    const cards = new Map(messages.filter(isCardMsg).map((m) => [m.id, m]))
    const changed = []
    const meta = await store.patchMeta(roomId, (m) => {
      const bin = { ...binOf(m) }
      for (const id of ids || []) {
        if (op === 'sweep') { if (cards.has(id) && !bin[id]) { bin[id] = { by: byName, at: new Date(now()).toISOString(), ref: cardRef(cards.get(id)) }; changed.push(id) } }
        else if (bin[id]) { delete bin[id]; changed.push(id) }
      }
      for (const id of Object.keys(bin)) if (!cards.has(id)) delete bin[id]
      m.cardBin = bin
      return m
    })
    if (changed.length) {
      emit(roomId, { type: 'card-bin', bin: binOf(meta) })
      const who = byUser ? '您' : byName + ' '
      const tools = changed.map((id) => String(cards.get(id)?.tool || 'card'))
      const last = messages[messages.length - 1]
      const prev = last && last.kind === 'system' && last.notice === 'card-bin' && last.binNote && last.binNote.op === op &&
        last.binNote.by === byName && !!last.binNote.byUser === !!byUser && Array.isArray(last.binNote.tools) ? last : null
      let merged = null
      if (prev) {
        const all = [...prev.binNote.tools, ...tools]
        try { merged = await updateCard(roomId, prev.id, (m) => ({ ...m, text: binNoteText({ op, who, tools: all }), binNote: { ...m.binNote, tools: all } })) } catch { merged = null }
      }
      if (!merged) await system(roomId, binNoteText({ op, who, tools }), { relay: false, notice: 'card-bin', binNote: { op, by: byName, byUser: !!byUser, tools } })
    }
    return changed.length
  }
  /** 用户在界面里收进 / 移出回收站（立即生效，一条只给界面看的系统提示「您把 N 张卡片…」）。op = 'sweep' | 'restore'。 */
  async function userBin(roomId, op, ids) {
    const cfg = await getRoomConfig()
    const n = await applyBin(roomId, { op: op === 'sweep' ? 'sweep' : 'restore', ids: (Array.isArray(ids) ? ids : []).map(String), byName: cfg.userName || '用户', byUser: true })
    let meta = {}
    try { meta = await store.getRoom(roomId) } catch {}
    return { changed: n, bin: binOf(meta) }
  }
  async function restoreCards(roomId, ids) {
    const r = await userBin(roomId, 'restore', ids)
    return { restored: r.changed, bin: r.bin }
  }

  const toolCfg = (cfg) => ({ ...TOOL_DEFAULTS, ...(cfg?.tools || {}) })
  const attachOn = (cfg) => !!toolkit?.attachments && cfg?.attachments?.enabled !== false
  const toolsOn = (cfg) => !!toolkit // 房间控制工具始终可用；find_tools / 附件工具按各自设置
  async function visionOf(seat) {
    try { return !!(await isVision(seat)) } catch { return false }
  }

  /**
   * 房间控制工具：校验 → 预约（buf.effects），回合成功后 applyEffect 生效。返回 { text, isError }（英文，给模型）。
   * 同一回合每种操作只能一次；计数在预约时占用，取消时归还。
   */
  async function roomControl(roomId, seat, task, buf, call) {
    let args = call.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}') } catch { return { isError: true, text: 'Arguments are not valid JSON.' } } }
    args = args && typeof args === 'object' ? args : {}
    if (!task) return { isError: true, text: 'There is no active task.' }
    if (buf.effects.some((ef) => ef.tool === call.name)) return { isError: true, text: `${call.name} was already called in this turn; it takes effect when your turn ends.` }
    const st = controlState(task)
    const reason = String(args.reason || '').slice(0, 200)
    if (call.name === END_ROUND_NAME) {
      // 结束本轮：预约，回合成功后由调度器在这一回合之后停下；卡片随回合撤销
      if (!canEndRound(seat, task)) return { isError: true, text: 'Only the main answerer and the leader can end the round.' }
      buf.effects.push({ tool: call.name, kind: 'end', by: seat, reason, task, release() {} })
      return {
        text: 'OK: the round ends right after your turn; nobody else speaks until the owner writes again. Finish your message now.',
        card: { text: '结束本轮', data: { ok: true, endRound: true, title: '结束本轮', ...(reason.trim() ? { reason: reason.trim() } : {}) } },
      }
    }
    if (call.name === SET_MAIN_NAME || call.name === SET_LEADER_NAME) {
      const kind = call.name === SET_MAIN_NAME ? 'main' : 'leader'
      if (typeof saveRoomControl !== 'function') return { isError: true, text: 'Room settings cannot be saved in this environment.' }
      const cfg = await getRoomConfig()
      const r = resolveMember(cfg.seats, args.member)
      if (r.error) return { isError: true, text: r.error }
      const current = kind === 'main' ? task.main : (cfg.seats.find((s) => s.leader)?.id || '')
      const err = checkSwitch(task, kind, r.seat, current)
      if (err) return { isError: true, text: err }
      const counter = kind === 'main' ? 'mainSwitches' : 'leaderSwitches'
      st[counter]++
      buf.effects.push({ tool: call.name, kind, by: seat, target: r.seat, reason, task, release: () => { st[counter]-- } })
      return { text: kind === 'main'
        ? `OK: after your turn ${r.seat.name} answers first (now and for later messages).`
        : `OK: after your turn ${r.seat.name} is the one who writes Cursor briefs.` }
    }
    return { isError: true, text: `Unknown room tool ${call.name}.` }
  }

  /** 回合成功后让房间控制生效：改任务 / 写设置 → 系统通知（入库并转发 Telegram）→ room-config / task 事件。 */
  async function applyEffect(roomId, ef) {
    if (ef.kind === 'end') {
      // 只做标记；通知与停下由调度循环在这一回合记账之后处理（通知排在该成员的回复之后）
      if (ef.task && ef.task.state === 'running' && !ef.task.endRound) ef.task.endRound = { by: ef.by.name, byId: ef.by.id, reason: ef.reason }
      return
    }
    if (ef.kind === 'bin') {
      try { await applyBin(roomId, { op: ef.op, ids: ef.ids, byName: ef.by.name }) } catch (e) {
        await system(roomId, `${ef.by.name} 的回收站操作未能生效：${failureReason(e).slice(0, 160)}`, { relay: false })
      }
      return
    }
    const task = ef.task
    const st = controlState(task)
    try {
      {
        const cfg = await getRoomConfig()
        const target = cfg.seats.find((s) => s.id === ef.target.id && s.enabled !== false)
        if (!target) throw new Error(`成员 ${ef.target.name} 已不可用`)
        if (ef.kind === 'main') {
          if (task.main !== target.id) { st.mainHistory.push(task.main); setMain(task, target.id) }
          const patch = await saveRoomControl({ defaultMain: target.name })
          emit(roomId, { type: 'room-config', patch: patch || { chatroomDefaultMain: target.name } })
        } else {
          const prev = cfg.seats.find((s) => s.leader)?.id
          if (prev) st.leaderHistory.push(prev)
          const patch = await saveRoomControl({ leader: target.id })
          emit(roomId, { type: 'room-config', patch: patch || {} })
        }
        await system(roomId, controlNotice(ef.kind, { by: ef.by.name, target: target.name, reason: ef.reason }))
      }
      emit(roomId, { type: 'task', task: status(roomId).task })
    } catch (e) {
      ef.release()
      await system(roomId, `${ef.by.name} 的${ef.kind === 'main' ? '主答切换' : '领队切换'}未能生效：${failureReason(e).slice(0, 160)}`, { relay: false })
    }
  }

  /** send_attachment：以成员身份把附件写进房间，并等待 Telegram 投递结果（写进工具结果文字）。 */
  async function deliverPost(roomId, seat, task, post) {
    const saved = await store.append(roomId, { kind: 'seat', speaker: { id: seat.id, name: seat.name }, provider: seat.provider, model: seat.model, task: task?.id, text: String(post.text || ''), attachments: post.attachments, status: 'ok', via: 'send_attachment' })
    emit(roomId, { type: 'message', message: saved })
    let results = []
    try { results = (typeof tg.relayAttachments === 'function' ? await tg.relayAttachments(seat, roomId, saved, { prefixName: seat.name }) : []) || [] } catch (e) { results = [{ ok: false, error: String(e?.message || e) }] }
    if (!results.length) return '已写入房间（本房间未绑定 Telegram 群，或没有可用的机器人）。'
    const ok = results.filter((r) => r.ok)
    const bad = results.filter((r) => !r.ok)
    return `已写入房间；Telegram：${ok.length} 个群发送成功${ok.some((r) => r.via === 'intake') ? '（经接收机器人代发）' : ''}${bad.length ? `，${bad.length} 个失败（${bad.map((r) => String(r.error || '').slice(0, 120)).join('；')}）` : ''}。`
  }

  /**
   * 多步工具循环（所有服务商通用，经 call → ctx.llm.stream）：模型调用工具 → 执行 → 结果作为 tool-result 回传 → 继续，
   * 直到模型不再调用工具。没有步数上限，只有安全护栏：同一调用（名称 + 参数）第 3 次起不执行并要求收尾；
   * 墙钟 wallClockMin 分钟后要求收尾；「停止」= 中止 controller。cursor_handoff 调用原样收集，循环结束后交给 submitBrief。
   * 工具结果写入房间（kind 'tool'，全文存文件，消息带预览），本循环内则以 tool-result 块回传给调用者本人。
   */
  async function toolLoop(roomId, seat, cfg, controller, task, buf = newTurnBuffer(), { gameTurn = false, extraUser } = {}) {
    const tc = toolCfg(cfg)
    const owner = task?.owner !== false
    const useTools = toolsOn(cfg)
    const cursorTools = seat.leader && runCursor ? [CURSOR_TOOL] : []
    if (!useTools) return generate(roomId, seat, cfg, controller, task, { extraUser, tools: cursorTools.length ? cursorTools : undefined, ensure: !gameTurn })
    let vision = await visionOf(seat)
    // 历史快照：循环中写进房间的工具消息已作为 tool-result 回传，重建提示词时不能再出现一次
    const snapshot = await store.readMessages(roomId)
    let imageWindow = IMAGE_WINDOW
    let prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow, messages: snapshot, signal: controller.signal })
    const viewed = [] // 本回合 view_attachment 取回真图的 tool-result 条目（按时间）
    const started = now()
    const wallMs = Math.max(1, Number(tc.wallClockMin) || 15) * 60000
    const seen = new Map()
    const extra = []
    const texts = []
    const thoughts = [] // 各步的思考过程（只给本机界面看）
    const cursorCalls = []
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const addUsage = (u) => { for (const k of Object.keys(usage)) usage[k] += Number(u?.[k]) || 0 }
    let finishing = ''
    const maxSteps = Math.max(1, Math.floor(Number(tc.maxSteps) || DEFAULT_TOOL_STEPS))
    const resultCap = Math.max(1000, Math.floor(Number(tc.turnResultTokens) || DEFAULT_TURN_RESULT_TOKENS))
    const callNames = new Map() // toolCallId → tool name (for shortened results)
    let longRetried = false
    for (let step = 0; ; step++) {
      if (controller.signal.aborted) throw Object.assign(new Error('已停止'), { aborted: true, partial: { text: texts.join('\n\n'), usage } })
      const schemas = [...cursorTools, ...ROOM_CONTROL_TOOLS, ...(!gameTurn && canEndRound(seat, task) ? [endRoundTool(cfg.userName)] : []), ...CARD_BIN_TOOLS, ...(await toolkit.schemas(roomId, { owner, gameTurn }))]
      // 滚动摘要：按该成员这次真正要发的请求估计（只在回合第一步检查）；压缩后按新摘要重建提示词
      if (step === 0 && !gameTurn && await ensureForRequest(roomId, seat, cfg, { system: prompt.system, messages: prompt.messages, tools: schemas }, controller.signal)) {
        prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow, messages: snapshot, signal: controller.signal })
      }
      const msgs = [...prompt.messages, ...extra]
      if (finishing) msgs.push({ role: 'user', content: finishing })
      let out
      const stopTyping = tg.typing(seat, roomId)
      try {
        const stepCap = toolStepTokens(cfg)
        out = await callLogged(roomId, seat, { seat, prompt: { system: prompt.system, messages: msgs }, ...(stepCap > 0 ? { maxTokens: stepCap } : {}), signal: controller.signal, tools: schemas, onDelta: (text) => emit(roomId, { type: 'delta', seatId: seat.id, text }), onReasoning: (text) => emit(roomId, { type: 'thinking-delta', seatId: seat.id, text }) }, { step, kind: gameTurn ? 'game' : 'turn' })
      } catch (e) {
        // 服务商拒收图片（模型信息或「识图：开」判断有误）：本回合改为只给文字描述，重试一次
        // 带图请求被服务商内容政策拦截：同样改为只给文字描述重试一次，并暂停向该路由发送真图（POLICY_PAUSE_MS）
        const policy = imagePolicyBlock(e)
        if (vision && !controller.signal.aborted && (isImageRejection(e) || policy)) {
          vision = false
          try { onVisionRejected(seat, e, { policy }) } catch {}
          if (policy) await notePolicyFallback(roomId, seat, step, e)
          for (const v of viewed) if (v.toolResult.images) { v.toolResult.text += policy ? '\n(The image could not be delivered this time. Use view_attachment again for a text description.)' : '\n(The image could not be delivered: your model does not accept image input. Use view_attachment again for a text description.)'; delete v.toolResult.images }
          viewed.length = 0
          imageWindow = IMAGE_WINDOW
          prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow, messages: snapshot, signal: controller.signal })
          step--
          continue
        }
        // 估计确实超过上游长上下文门槛：强制压缩一次后重试这一步；压缩不可用 / 无效时报清楚的原因
        if (e?.longContext && !controller.signal.aborted) {
          if (!longRetried && typeof compactContext === 'function') {
            longRetried = true
            let r = null
            try { r = await compactContext(roomId) } catch { r = null }
            if (r && r.ok && !r.skipped) {
              prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow, messages: snapshot, signal: controller.signal })
              step--
              continue
            }
          }
          e = longContextFailure(e)
        }
        if (e && typeof e === 'object') e.partial = { text: [...texts, String(e.partial?.text || '')].filter(Boolean).join('\n\n'), usage }
        throw e
      } finally { try { stopTyping() } catch {} }
      addUsage(out.usage)
      if (String(out.reasoning || '').trim()) thoughts.push(String(out.reasoning).trim())
      const calls = out.toolCalls || []
      const mine = calls.filter((c) => c.name !== CURSOR_TOOL_NAME)
      cursorCalls.push(...calls.filter((c) => c.name === CURSOR_TOOL_NAME))
      if (!mine.length || finishing) {
        if (String(out.text || '').trim()) texts.push(String(out.text).trim())
        return { text: texts.join('\n\n'), usage, toolCalls: cursorCalls, steps: step + 1, stoppedBy: finishing ? 'guard' : '', ...(thoughts.length ? { reasoning: thoughts.join('\n\n') } : {}) }
      }
      if (String(out.text || '').trim()) texts.push(String(out.text).trim())
      const blocks = Array.isArray(out.blocks) && out.blocks.some((b) => b?.type === 'tool-call')
        ? out.blocks
        : [...(out.text ? [{ type: 'text', text: out.text }] : []), ...calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) }))]
      extra.push({ role: 'assistant', blocks, ...(out.replayState !== undefined && blocks === out.blocks ? { replayState: out.replayState } : {}) })
      const stepStart = extra.length // 本步的工具结果从这里开始（缩减时只动更早的）
      let repeated = false
      for (const c of calls) {
        if (c?.id) callNames.set(c.id, c.name)
        if (c.name === CURSOR_TOOL_NAME) { extra.push({ role: 'user', toolResult: { toolCallId: c.id, text: '任务书已记录，回合结束后提交，等待所有者回复「执行」。' } }); continue }
        // 快照 / 截图类工具不拦也不计数（见 ./repeat-guard.mjs）
        const key = c.name + '\u0000' + (typeof c.arguments === 'string' ? c.arguments.trim() : JSON.stringify(c.arguments ?? {}))
        const n = isRepeatExempt(c.name) ? 0 : (seen.get(key) || 0) + 1
        if (n) seen.set(key, n)
        if (n >= 3) {
          repeated = true
          extra.push({ role: 'user', toolResult: { toolCallId: c.id, isError: true, text: `已阻止：同一调用（${c.name}，相同参数）已执行 ${n - 1} 次。请使用之前的结果。` } })
          await stage(roomId, buf, { kind: 'tool', tool: c.name, speaker: { id: seat.id, name: seat.name }, text: `已阻止重复调用（第 ${n} 次相同参数）`, data: { ok: false, blocked: 'repeat' }, status: 'ok', task: task?.id }, { relaySeat: seat })
          continue
        }
        if (CARD_BIN_NAMES.has(c.name)) {
          const rb = await cardBinTool(roomId, seat, task, buf, c)
          extra.push({ role: 'user', toolResult: { toolCallId: c.id, text: rb.text, isError: !!rb.isError } })
          // 不产生卡片：回合提交时 applyBin 写一行界面提示
          continue
        }
        if (ROOM_CONTROL_NAMES.has(c.name)) {
          const rc = await roomControl(roomId, seat, task, buf, c)
          extra.push({ role: 'user', toolResult: { toolCallId: c.id, text: rc.text, isError: !!rc.isError } })
          // 结束本轮的卡片存为 hidden：只在界面显示，AI 看不到（同失败回合）；调用者本回合仍拿到上面的工具结果
          if (rc.card) await stage(roomId, buf, { kind: 'tool', tool: c.name, ...rc.card, speaker: { id: seat.id, name: seat.name }, status: rc.card.data?.endRound ? 'hidden' : 'ok', task: task?.id }, { relaySeat: seat, relay: false })
          continue
        }
        let r
        try { r = await untilAborted(toolkit.run(roomId, c, { owner, seat, signal: controller.signal, vision: toolVision(seat, c, vision, prompt), gameTurn }), controller.signal) } catch (e) {
          if (controller.signal.aborted) throw Object.assign(abortedError(), { partial: { text: texts.join('\n\n'), usage } })
          throw e
        }
        const entry = { role: 'user', toolResult: { toolCallId: c.id, text: r.modelText, isError: !!r.isError } }
        if (Array.isArray(r.images) && r.images.length) {
          const already = r.images.every((img) => (prompt.realImages || []).includes(img.id) || viewed.some((v) => v.toolResult.images?.some((x) => x.id === img.id)))
          if (already) entry.toolResult.text += '\n(This image is already attached as a real image in your context; look at it there.)'
          else { entry.toolResult.images = r.images; viewed.push(entry) }
        }
        if (r.post) {
          // 立即投递（不等回合结束、更不等其他成员）；每次调用只投递一次
          let note
          try { note = await deliverPost(roomId, seat, task, r.post) } catch (e) { note = `发送失败：${failureReason(e).slice(0, 160)}` }
          entry.toolResult.text += '\n' + note
        }
        extra.push(entry)
        if (r.room) {
          const { relay: roomRelay, ...card } = r.room
          await stage(roomId, buf, { kind: 'tool', ...card, data: jsonSafe(card.data), speaker: { id: seat.id, name: seat.name }, status: 'ok', task: task?.id }, { relaySeat: seat, ...(roomRelay === false ? { relay: false } : {}) }, { keep: true })
        }
      }
      // 9 张真图上限：取回的图片优先（最新的 9 张），历史中作为真图的数量相应减少
      if (viewed.length) {
        let kept = 0
        for (let i = viewed.length - 1; i >= 0; i--) {
          const tr = viewed[i].toolResult
          if (!tr.images?.length) continue
          if (kept + tr.images.length <= IMAGE_WINDOW) { kept += tr.images.length; continue }
          tr.text += `\n(The image #${tr.images.map((x) => x.id).join(', #')} is no longer attached because of the ${IMAGE_WINDOW}-image limit; call view_attachment again if needed.)`
          delete tr.images
        }
        const next = Math.max(0, IMAGE_WINDOW - kept)
        if (next !== imageWindow) { imageWindow = next; prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision, imageWindow, messages: snapshot, signal: controller.signal }) }
      }
      // 本回合工具结果合计上限：先缩减较早的结果；仍超过时要求收尾。另有步数上限。
      const capped = finishing ? null : capToolResults(extra, { cap: resultCap, names: callNames, keepFrom: stepStart })
      if (repeated) finishing = '(The repeated tool calls were skipped. No more tools this turn; just reply to the room.)'
      else if (capped?.over) {
        finishing = `(Tool results in this turn have reached the context budget (about ${resultCap} tokens); older results were shortened. No more tools this turn; reply to the room now with what you have, mentioning anything left undone.)`
        await stage(roomId, buf, { kind: 'system', speaker: { id: 'system', name: '聊天室' }, text: `${seat.name} 本回合的工具结果已达上限（约 ${resultCap} tokens），已精简较早的结果，正在收尾。` }, { relay: false })
      } else if (step + 1 >= maxSteps) {
        finishing = `(You have used ${maxSteps} tool steps this turn. No more tools; reply to the room now, mentioning anything left undone.)`
        await stage(roomId, buf, { kind: 'system', speaker: { id: 'system', name: '聊天室' }, text: `${seat.name} 的工具循环已达 ${maxSteps} 步上限，正在收尾。` }, { relay: false })
      } else if (!gameTurn && now() - started > wallMs) {
        finishing = `(That's been ${Math.round(wallMs / 60000)} minutes of tool use. Leave the tools for now and just reply to the room, mentioning anything left undone.)`
        await stage(roomId, buf, { kind: 'system', speaker: { id: 'system', name: '聊天室' }, text: `${seat.name} 的工具循环已达 ${Math.round(wallMs / 60000)} 分钟上限，正在收尾。` }, { relay: false })
      }
    }
  }

  async function generate(roomId, seat, cfg, controller, task, { extraUser, tools, maxTokens, ensure = false } = {}) {
    const vision = await visionOf(seat)
    let checked = !ensure || !!maxTokens
    const once = async (v) => {
      let prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision: v, signal: controller.signal })
      if (!checked) {
        checked = true
        if (await ensureForRequest(roomId, seat, cfg, { system: prompt.system, messages: prompt.messages, tools }, controller.signal)) prompt = await promptFor(roomId, seat, cfg, task, extraUser, { vision: v, signal: controller.signal })
      }
      const stopTyping = tg.typing(seat, roomId)
      try {
        const aux = Number(maxTokens) || 0
        const cap = aux > 0 ? aux : (tools?.length ? toolStepTokens(cfg) : (Number(cfg.maxTokens) || 0))
        return await callLogged(roomId, seat, { seat, prompt, ...(cap > 0 ? { maxTokens: cap } : {}), signal: controller.signal, tools, onDelta: (text) => emit(roomId, { type: 'delta', seatId: seat.id, text }), ...(aux > 0 ? {} : { onReasoning: (text) => emit(roomId, { type: 'thinking-delta', seatId: seat.id, text }) }) }, { kind: aux > 0 ? 'aux' : 'turn' })
      } finally { try { stopTyping() } catch {} }
    }
    try { return await once(vision) } catch (e) {
      if (e?.longContext) throw longContextFailure(e)
      const policy = imagePolicyBlock(e)
      if (!vision || controller.signal.aborted || !(isImageRejection(e) || policy)) throw e
      try { onVisionRejected(seat, e, { policy }) } catch {}
      if (policy) await notePolicyFallback(roomId, seat, 0, e)
      return once(false)
    }
  }

  /** 把 cursor_handoff 调用（原生或回退写法）变成待执行的任务书。 */
  async function submitBrief(roomId, seat, rawArgs, cfg) {
    const h = normalizeHandoffArgs(rawArgs, { defaultRepo: cfg.cursorRepo })
    if (h.error) {
      return appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: seat.id, name: seat.name }, text: 'invalid cursor_handoff call', data: jsonSafe({ ok: false, status: 'invalid', error: h.error }), status: 'ok' }, { relay: false })
    }
    const briefId = 'b' + now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4)
    await store.patchMeta(roomId, (m) => { m.briefs = { ...(m.briefs || {}), [briefId]: { ...h, status: 'awaiting_owner', by: seat.id, at: new Date(now()).toISOString() } }; m.pendingBrief = briefId })
    // 任务书正文转发 Telegram（此前 relay:false 导致群里只看到「已提交」短通知、看不到任务书正文）
    const briefMsg = await appendAndEmit(roomId, { kind: 'brief', briefId, briefStatus: 'awaiting_owner', action: h.action, repo: h.repo, title: h.title, speaker: { id: seat.id, name: seat.name }, text: h.brief, deeplink: cursorDeeplink(h.brief) }, { relaySeat: seat })
    await store.patchMeta(roomId, (m) => { if (m.briefs?.[briefId]) m.briefs[briefId].msgId = briefMsg.id })
    return appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: { id: seat.id, name: seat.name }, text: `任务书 #${briefId} 已提交，等待 ${cfg.userName} 回复「执行」`, data: jsonSafe({ ok: true, status: 'awaiting_owner', briefId, action: h.action, title: h.title, repo: h.repo }), status: 'ok' }, { relaySeat: seat })
  }

  /** 一个 AI 回合。返回 { outcome: 'spoke'|'pass'|'error'|'dropped'|'redirect'|'stopped', handoffTo?, counted } */
  async function speak(roomId, seat, cfg, controller, task, opts = {}) {
    const run = runs.get(roomId)
    const turn = newTurnControl(controller, { gameTurn: !!opts.gameTurn })
    if (run) run.turn = turn
    try { return await speakTurn(roomId, seat, cfg, controller, turn, task, opts) } finally {
      turn.dispose()
      if (run && run.turn === turn) run.turn = null
    }
  }
  /** 被新消息打断：只给界面一个不入库的 turn-interrupted 事件；不转发 Telegram、不标记离开、AI 看不到。 */
  function noteInterrupted(roomId, seat, task) {
    emit(roomId, { type: 'turn-interrupted', seatId: seat?.id || '', name: seat?.name || '', model: seat?.model || '', task: task?.id || '', at: new Date(now()).toISOString() })
  }
  async function speakTurn(roomId, seat, cfg, controller, turn, task, { gameTurn = false, extraUser } = {}) {
    const run = runs.get(roomId)
    if (run) run.seatId = seat.id
    // Rolling context compress: checked per request in toolLoop / generate (ensureForRequest), sized by what this member actually sends.
    emit(roomId, { type: 'turn', seatId: seat.id, name: seat.name, model: seat.model, task: task.id })
    const base = { kind: 'seat', speaker: { id: seat.id, name: seat.name }, provider: seat.provider, model: seat.model, task: task.id }
    const basedOn = await store.lastSeq(roomId)
    const buf = newTurnBuffer()
    let out
    let stepTimer
    if (gameTurn) {
      stepTimer = setTimeout(() => {
        if (run) run.stepTimeout = true
        try { controller.abort() } catch {}
      }, GAME_STEP_MS)
      stepTimer.unref?.()
    }
    try {
      out = await toolLoop(roomId, seat, cfg, turn.ctl, task, buf, { gameTurn, extraUser })
    } catch (e) {
      // 只有用户「停止」（本房间的 controller 被中止）才算停止；服务商自己中断 / 超时按失败处理
      if (controller.signal.aborted) {
        if (gameTurn && run?.stepTimeout && !run.userStop) {
          await rollbackTurn(roomId, buf)
          announceFailure(roomId, seat, task, new Error('这一步超时'), { away: false })
          await system(roomId, `${seat.name} 这一步超时。本轮未写入记录。`)
          return { outcome: 'error' }
        }
        await rollbackTurn(roomId, buf)
        const partial = String(e?.partial?.text || '').trim()
        await appendAndEmit(roomId, { ...base, text: partial, status: 'stopped', basedOn, usage: e?.partial?.usage }, { relay: false })
        return { outcome: 'stopped' }
      }
      if (turn.interrupted) {
        // 用户新消息打断：与失败相同地回滚（正文不写入、排队的发送丢弃、已完成的工具卡片保留），不提示失败
        await rollbackTurn(roomId, buf)
        noteInterrupted(roomId, seat, task)
        return { outcome: 'redirect', counted: false }
      }
      await rollbackTurn(roomId, buf)
      announceFailure(roomId, seat, task, e?.aborted ? new Error(`请求被中断（不是用户停止）：${failureReason(e)}`) : e, { away: false })
      if (gameTurn) await system(roomId, `${seat.name} 这一步没有完成：${failureReason(e).slice(0, 200)}。本轮未写入记录。`)
      return { outcome: 'error' }
    } finally {
      if (stepTimer) clearTimeout(stepTimer)
    }
    // 回合成功：先写入本回合的工具记录，再处理正文
    await commitTurn(roomId, buf, seat, task)
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
        const r = await generate(roomId, seat, cfg, turn.ctl, task, { extraUser: ask, maxTokens: Math.min(cfg.maxTokens || 1024, 1024) })
        const d = parseStaleDecision(r.text)
        if (d.action === 'drop') { await appendAndEmit(roomId, { ...base, text, status: 'dropped', basedOn, reason: 'stale, dropped by speaker' }, { relay: false }); return { outcome: 'dropped' } }
        if (d.action === 'revise') text = stripSelfPrefix(d.text, seat.name).trim()
      } catch (e) {
        if (!controller.signal.aborted && turn.interrupted) {
          await appendAndEmit(roomId, { ...base, text, status: 'dropped', basedOn, reason: 'new user message', usage: out.usage }, { relay: false })
          noteInterrupted(roomId, seat, task)
          return { outcome: 'redirect', counted: false }
        }
        if (controller.signal.aborted || e?.aborted) return { outcome: 'stopped' }
      }
    }
    if (isPass(text) && !toolCalls.length && !directive?.args) {
      await appendAndEmit(roomId, { ...base, text: PASS_TOKEN, status: 'pass', basedOn, usage: out.usage }, { relay: false })
      return { outcome: 'pass' }
    }
    const handoff = parseHandoff(text, cfg.seats.filter((s) => s.enabled !== false), seat.id)
    text = handoff.text
    if (text && !isPass(text)) {
      // 思考过程：只随正式写入的回复保存到 thinking.jsonl（消息上只记字数）；失败 / 被打断 / 停止 / 跳过 / 撤回的回合都不保存
      const thinking = String(out.reasoning || '').trim()
      const saved = await appendAndEmit(roomId, { ...base, text, status: 'ok', basedOn, usage: out.usage, ...(handoff.seat ? { handoffTo: handoff.seat.id } : {}), ...(thinking ? { thinkingChars: thinking.length } : {}) }, { relaySeat: seat })
      if (thinking && typeof store.appendThinking === 'function') { try { await store.appendThinking(roomId, saved.id, thinking) } catch {} }
    }
    for (const tc of toolCalls) await submitBrief(roomId, seat, tc.arguments, cfg)
    if (directive?.args) await submitBrief(roomId, seat, directive.args, cfg)
    else if (directive && directive.error) await submitBrief(roomId, seat, '{bad', cfg)
    return { outcome: 'spoke', handoffTo: handoff.seat?.id }
  }

  /** 预算用尽：不请任何 AI 汇报（AI 看不到预算），只发一条系统提示（界面 + Telegram 群；系统消息不进入 AI 的提示词）。 */
  async function budgetNotice(roomId, task) {
    await system(roomId, budgetExhaustedText(task))
  }

  function newTask(cfg, message, roomId) {
    const enabled = cfg.seats.filter((s) => s.enabled !== false)
    // 点名：用户消息里第一个提到的成员（@名字 或直接写名字，按出现位置）做本任务的主答——只管这一个任务，之后照常。
    // 只看用户消息（AI 回复、交卷唤醒不走这里）。若仍有遗留 away 状态则一并清除。
    const mention = message?.kind === 'user' ? firstNamedSeat(message.text, enabled, { presetNames: knownPresets }) : null
    const def = findSeat(enabled, cfg.defaultMain) || null
    if (mention && roomId) back(roomId, mention.id)
    const task = createTask({ id: `t${++taskSeq}-${message.seq}`, seats: enabled, mainId: (mention || def)?.id, budget: cfg.budget || 10, basedOn: message.seq })
    task.owner = isOwnerMessage(message, cfg.ownerId)
    task.source = message.source || 'local'
    return task
  }

  /** 进行中的棋局轮到某个 AI 成员：只叫这一位，不扣讨论预算。 */
  async function driveGame(roomId, cfg, controller, run) {
    const snap = games.snapshot(roomId)
    if (!snap.active || snap.paused || snap.waiting) return 'hold'
    const memberId = snap.actor?.kind === 'ai' ? snap.actor.memberId : ''
    if (!memberId) return 'hold'
    const seat = cfg.seats.find((s) => s.id === memberId && s.enabled !== false)
    if (!seat) {
      games.pause(roomId)
      await system(roomId, `轮到 ${snap.actor.name || memberId}，但该成员不在房间里。对局已暂停。回复「继续」恢复。`)
      return 'paused'
    }
    if (isAway(roomId, seat.id)) {
      games.pause(roomId)
      await system(roomId, `${seat.name} 暂时离开，对局已暂停。回复「继续」恢复。`)
      return 'paused'
    }
    const before = snap.view?.moveCount
    const task = { id: 'game', owner: false, source: 'game', main: seat.id, gameTurn: true }
    let got
    try {
      got = await speak(roomId, seat, cfg, controller, task, { gameTurn: true, extraUser: games.prompt(snap.view, seat.id) })
    } catch (e) {
      if (controller.signal.aborted && run.userStop) return 'stopped'
      announceFailure(roomId, seat, task, e, { away: false })
      await system(roomId, `${seat.name} 这一步没有完成：${failureReason(e).slice(0, 200)}。本轮未写入记录。`)
      return 'error'
    }
    if (got.outcome === 'stopped') return 'stopped'
    if (got.outcome === 'error') return 'error'
    const after = games.snapshot(roomId)
    if (!after.active || after.paused || after.view?.over) return 'idle'
    if (after.waiting || after.actor?.kind !== 'ai' || !after.actor.memberId) return 'human'
    if ((after.view?.moveCount ?? before) === before) {
      if (!snap.reminded) {
        games.markReminded(roomId)
        await system(roomId, `轮到${seat.name}了。`, { game: true })
      }
      return 'reminded'
    }
    return 'again'
  }

  /** 房间循环：一次只跑一个槽位，直到任务完成 / 等预算 / 停止。有棋局时改为只走当前座位。 */
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
          const snap = games ? games.snapshot(roomId) : null
          const gameAi = !!(snap?.active && !snap.paused && !snap.waiting && snap.actor?.kind === 'ai' && snap.actor.memberId)
          if (gameAi && run.pendingUser) run.pendingUser = null
          if (run.pendingUser) {
            const msg = run.pendingUser
            run.pendingUser = null
            const prev = tasks.get(roomId)
            if (prev && prev.state === 'running') prev.state = 'superseded'
            const t = newTask(cfg, msg, roomId)
            tasks.set(roomId, t)
            emit(roomId, { type: 'task', task: status(roomId).task })
          }
          if (gameAi) {
            const step = await driveGame(roomId, cfg, controller, run)
            if (step === 'again') continue
            if (step === 'stopped') { reason = 'stopped'; break }
            reason = step === 'error' || step === 'timeout' ? 'error' : step
            break
          }
          if (snap?.active && !run.pendingUser) {
            const cur = tasks.get(roomId)
            const discussing = cur && cur.state === 'running' && !cur.gameTurn
            if (!discussing) { reason = snap.paused ? 'paused' : 'human'; break }
          }
          const task = tasks.get(roomId)
          if (!task) { reason = 'idle'; break }
          const id = nextSpeaker(task)
          if (!id) {
            if (task.state === 'budget' && !task.reported) { task.reported = true; await budgetNotice(roomId, task); reason = 'budget' }
            else reason = task.state
            if (!run.pendingUser) break
            continue
          }
          const seat = cfg.seats.find((s) => s.id === id)
          if (!seat) { recordTurn(task, id, 'error', { counted: false }); continue }
          // 遗留 away 状态（已不再由失败写入）：若仍存在则跳过；正常失败路径不会再置 away
          if (isAway(roomId, id)) { recordTurn(task, id, 'pass', { counted: false }); continue }
          let got
          try { got = await speak(roomId, seat, cfg, controller, task) } catch (e) {
            if (controller.signal.aborted) got = { outcome: 'stopped' }
            else { announceFailure(roomId, seat, task, e); got = { outcome: 'error' } }
          }
          if (got.outcome === 'stopped') { reason = 'stopped'; break }
          if (got.outcome === 'redirect') continue
          if (got.outcome !== 'error') back(roomId, id)
          recordTurn(task, id, got.outcome, { handoffTo: got.handoffTo, counted: got.counted !== false })
          // end_round 已生效：本轮到此为止——不再请其他成员、不写预算提示 / 汇报；只给界面一条不转发、不进提示词的通知
          if (task.endRound && !task.endNoted && tasks.get(roomId) === task) {
            task.endNoted = true
            task.state = 'ended'
            await system(roomId, endRoundNotice(task.endRound.by, task.endRound.reason), { relay: false, notice: 'end-round' })
            emit(roomId, { type: 'task', task: status(roomId).task })
            reason = 'ended'
            if (!run.pendingUser) break
            continue
          }
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
  async function post(roomId, text, { userName, owner = false, source = 'local', fromId, run = true, attachments, videoLinks } = {}) {
    const t = String(text || '').trim()
    const atts = Array.isArray(attachments) ? attachments.filter((a) => a && a.id) : []
    const links = Array.isArray(videoLinks) ? videoLinks.filter((a) => a && a.id) : []
    if (!t && !atts.length) throw Object.assign(new Error('消息不能为空'), { status: 400 })
    const cfg = await getRoomConfig()
    // 「批准 +N」/「批准」：所有者的控制消息，由程序处理，不写入房间记录（AI 看不到）；其他人的「批准」按普通消息处理
    const early = !atts.length && owner ? parseOwnerCommand(t) : null
    if (early?.kind === 'approve') return approve(roomId, early.n, { run, by: userName || cfg.userName })
    // /compact：主动压缩上下文。命令本身不写入房间记录、不开始 AI 回合；结果只写一行 AI 不可见的系统提示。
    const compact = !atts.length ? parseCompactCommand(t, (cfg.seats || []).map((s) => s.telegram?.username)) : null
    if (compact) return compactCommand(roomId, compact, { owner, source, cfg })
    if (!atts.length && games) {
      const snap = games.snapshot(roomId)
      if (snap.active && /^继续\s*[。.!！]?$/.test(t)) {
        if (!owner) { const notice = await system(roomId, `只有 ${cfg.userName} 可以继续对局。`); return { message: null, notice, started: false } }
        games.resume(roomId)
        const notice = await system(roomId, '对局继续。')
        const p = run !== false ? ensureLoop(roomId) : null
        return { message: null, notice, control: 'resume', started: !!p, promise: p }
      }
      if (snap.active && /^(?:停止|stop)\s*[。.!！]?$/i.test(t)) {
        if (!owner) { const notice = await system(roomId, `只有 ${cfg.userName} 可以停止对局。`); return { message: null, notice, started: false } }
        games.pause(roomId)
        const any = stop(roomId)
        const notice = await system(roomId, '对局已暂停。回复「继续」恢复。')
        return { message: null, notice, control: 'pause', started: false, stopped: any }
      }
      const routed = await games.route(roomId, {
        text: t,
        ...(source === 'telegram' && fromId ? { telegramUserId: String(fromId) } : {}),
        ...(source !== 'telegram' ? { local: true } : {}),
      })
      if (routed?.consumed) {
        if (routed.notice) await system(roomId, routed.notice)
        if (routed.said) return post(roomId, routed.said, { userName, owner, source, fromId, run, attachments, videoLinks })
        return { message: null, started: false, routed: true }
      }
    }
    const mainSeat = source === 'local' ? findSeat((cfg.seats || []).filter((s) => s.enabled !== false), cfg.defaultMain) : null
    const message = await appendAndEmit(roomId, { kind: 'user', speaker: { id: source === 'telegram' ? `tg:${fromId}` : 'user', name: userName || cfg.userName }, owner: !!owner, source, text: t.slice(0, 20000), ...(atts.length ? { attachments: atts } : {}), ...(links.length ? { videoLinks: links } : {}) }, { relay: source === 'local', relaySeat: mainSeat || null, prefixName: userName || cfg.userName })
    if (/^(?:停止|stop)\s*[。.!！]?$/i.test(t)) {
      if (!owner) { await system(roomId, `只有 ${cfg.userName} 可以停止。`); return { message, started: false } }
      const any = stop(roomId)
      await system(roomId, any ? '已停止。' : '当前没有进行中的发言。')
      return { message, started: false, stopped: any }
    }
    if (/^\/tools(?:\s|$)/i.test(t)) {
      if (!owner) { await system(roomId, `只有 ${cfg.userName} 可以管理工具集。`); return { message, started: false } }
      if (!toolkit) { await system(roomId, '当前环境未启用聊天室工具。'); return { message, started: false } }
      if (/^\/tools\s+clear\s*$/i.test(t)) { const n = await toolkit.toolsets.clear(roomId); await system(roomId, `已清空房间工具集（移除 ${n} 个工具）。联网搜索（web_search、web_fetch）为默认工具，仍对所有房间开放。`); return { message, started: false } }
      const list = await toolkit.toolsets.list(roomId)
      const defs = toolkit.defaultsPresent ? toolkit.defaultsPresent() : []
      const defNote = defs.length ? `默认工具（始终可用）：${defs.join('、')}。` : ''
      await system(roomId, defNote + (list.length ? `房间工具集（${list.length}）：${list.map((x) => x.name).join('、')}。发送 /tools clear 可清空。` : '房间工具集为空。成员可用 find_tools 查找工具。'))
      return { message, started: false }
    }
    const cmd = parseOwnerCommand(t)
    if (cmd && cmd.kind !== 'approve') {
      if (!owner) { await system(roomId, `只有 ${cfg.userName} 可以执行 Cursor 任务。`); return { message, started: false } }
      if (cmd.kind === 'execute') {
        // 「执行」也是插话：中止进行中的座位，作废旧讨论任务，不另开一轮（Cursor 交卷后再 wake）
        const live = runs.get(roomId)
        let seatInterrupted = false
        if (live) {
          const prev = tasks.get(roomId)
          if (prev && prev.state === 'running') prev.state = 'superseded'
          seatInterrupted = !!live.turn?.interrupt()
        }
        const p = executeBrief(roomId, cmd.briefId)
        return { message, started: false, cursor: p, interrupted: seatInterrupted }
      }
      if (cmd.kind === 'cancel') {
        const live = runs.get(roomId)
        if (live) {
          const prev = tasks.get(roomId)
          if (prev && prev.state === 'running') prev.state = 'superseded'
          live.turn?.interrupt()
        }
        const ok = await cancelBrief(roomId)
        return { message, started: false, cancelled: ok }
      }
    }
    if (!run) return { message, started: false }
    await refreshPresetNames()
    const r = runs.get(roomId)
    if (r) {
      // 进行中又来新消息：作为新任务（进行中的草稿会被丢弃并转向），点名照常在 newTask 里处理
      const task = tasks.get(roomId)
      r.pendingUser = message
      // 熔断：任何人的新消息立即中止进行中的 AI 请求（棋局除外），并中止正在跑的 Cursor 任务；循环随后为新消息开始新的一轮
      const fusedCursor = fuseCursor(roomId)
      const interrupted = !!r.turn?.interrupt()
      if (interrupted || fusedCursor) return { message, started: false, redirected: !!task, interrupted: interrupted || fusedCursor, fusedCursor, promise: r.promise }
      return { message, started: false, redirected: !!task, promise: r.promise }
    }
    // 无讨论循环时：若 Cursor 在跑，插话同样熔断它，再为新消息开一轮
    const fusedCursor = fuseCursor(roomId)
    const p = ensureLoop(roomId) // 循环的第一步在下一个微任务之后才读 pendingUser
    runs.get(roomId).pendingUser = message
    return { message, started: true, interrupted: fusedCursor || undefined, fusedCursor: fusedCursor || undefined, promise: p }
  }

  /** /compact 的结果提示：kind 'system'（不带 aiVisible），与回收站提示相同，不进入任何 AI 的提示词。 */
  async function compactCommand(roomId, cmd, { owner, source, cfg }) {
    const relay = source === 'telegram'
    const note = (text) => system(roomId, text, { relay, notice: 'compact' })
    if (cmd.args) { const notice = await note('用法：/compact（不带参数）'); return { message: null, notice, started: false, control: 'compact', compacted: false } }
    if (!owner) { const notice = await note(`只有 ${cfg.userName} 可以压缩上下文。`); return { message: null, notice, started: false, control: 'compact', compacted: false } }
    if (typeof compactContext !== 'function') { const notice = await note('当前环境不支持压缩上下文。'); return { message: null, notice, started: false, control: 'compact', compacted: false } }
    let r
    try { r = await compactContext(roomId) } catch (e) { r = { ok: false, reason: 'error', error: String(e?.message || e) } }
    let text
    if (r?.ok && !r.skipped) text = `已压缩上下文：${r.folded} 条较早的消息已并入摘要。`
    else if (r?.reason === 'unconfigured') text = '自动压缩未启用：请选择摘要模型（聊天室设置 › 摘要模型），无法压缩上下文。'
    else if (r?.reason === 'busy') text = '上下文压缩进行中，请稍候。'
    else if (r?.reason === 'nothing-to-fold') text = '当前消息未超出上下文窗口，无需压缩。'
    else text = '上下文压缩失败，已保留原窗口。'
    const notice = await note(text)
    return { message: null, notice, started: false, control: 'compact', compacted: !!(r?.ok && !r.skipped), result: r }
  }

  /** 所有者批准追加回合：追加并继续；只写一条系统提示（界面 + Telegram 群，不进入 AI 提示词）。 */
  async function approve(roomId, n, { run = true, by } = {}) {
    const task = tasks.get(roomId)
    if (!task || (task.state !== 'budget' && task.state !== 'running')) {
      const notice = await system(roomId, '当前没有等待追加回合的任务。')
      return { message: null, notice, control: 'approve', started: false }
    }
    extendBudget(task, n)
    task.reported = false
    const notice = await system(roomId, `${by ? by + ' ' : ''}已批准追加 ${n} 个回合（${task.used}/${task.budget}），继续。`)
    emit(roomId, { type: 'task', task: status(roomId).task })
    const p = run ? ensureLoop(roomId) : null
    return { message: null, notice, control: 'approve', started: !!p, promise: p }
  }

  /** 让指定成员 / 继续当前任务（界面「继续」）。 */
  function start(roomId, { seatIds } = {}) {
    if (runs.has(roomId)) return false
    const snap = games?.snapshot(roomId)
    if (snap?.active && !snap.paused && !snap.waiting && snap.actor?.kind === 'ai' && snap.actor.memberId) return ensureLoop(roomId)
    const task = tasks.get(roomId)
    if (seatIds?.length && task) { setMain(task, seatIds[0]); if (task.state !== 'running') { task.state = 'running'; if (task.used >= task.budget) task.budget = task.used + 1 } }
    if (!task) return false
    if (task.state === 'done') { task.state = 'running' }
    return ensureLoop(roomId)
  }

  // ── Cursor 任务卡片：「先交卷、后补卷」──
  // 执行时立即为发起成员建一张「进行中」卡片（不阻塞任何 AI 回合）；cursor-agent 结束后原位补上报告
  // （状态、退出码、用时、改动文件、最终回复），再发一条「交卷了」的房间提示并唤醒发起成员（不在则唤醒组长）。
  // 卡片直接写入房间（不经过回合暂存），所以回合失败 / 被打断的回滚碰不到它。
  const cursorFolder = (repo) => { const t = String(repo || '').replace(/[\\/]+$/, ''); return t.split(/[\\/]/).pop() || t || '?' }
  const cursorCardTitle = (id, repo, label) => `Cursor 任务 #${id} · ${cursorFolder(repo)} · ${label}`
  /** 卡片空白时的原因：给用户看的（中文）与给 AI 看的粗略原因（英文）。 */
  const CURSOR_BLANK = {
    cancelled: { label: '已取消', user: '已取消', ai: 'cancelled by the user' },
    stopped: { label: '已取消', user: '已取消（停止）', ai: 'cancelled by the user' },
    shutdown: { label: '状态未知', user: 'DSH 关闭时任务被中止，工作区可能已有改动', ai: 'interrupted, the outcome is unknown' },
    interrupted: { label: '状态未知', user: 'DSH 在任务运行期间重启，结果未能收回；工作区可能已有改动', ai: 'interrupted by a restart, the outcome is unknown' },
    fused: { label: '已熔断', user: '已熔断（用户插话，任务已中止）', ai: 'aborted by a new user message' },
  }

  /**
   * 附件元数据变了（视频「内容描述」完成 / 失败等）：把房间消息里该附件（含 videoLinks）的快照换成新的，推 message-update。
   * 不新增消息，不影响回合的过时判断（scheduler.staleness 只数新消息）。
   */
  async function patchAttachment(roomId, attId, snap) {
    if (!attId || !snap || typeof store.updateMessage !== 'function') return 0
    let ids = []
    try { ids = (await store.readMessages(roomId)).filter((m) => [...(m.attachments || []), ...(m.videoLinks || [])].some((a) => a?.id === attId)).map((m) => m.id) } catch { return 0 }
    const swap = (list) => (Array.isArray(list) ? list.map((a) => (a?.id === attId ? { ...snap } : a)) : list)
    for (const id of ids) await updateCard(roomId, id, (m) => ({ ...m, ...(m.attachments ? { attachments: swap(m.attachments) } : {}), ...(m.videoLinks ? { videoLinks: swap(m.videoLinks) } : {}) }))
    return ids.length
  }

  async function updateCard(roomId, msgId, fn, extra = {}) {
    if (!msgId || typeof store.updateMessage !== 'function') return null
    const m = await store.updateMessage(roomId, msgId, fn)
    if (m) emit(roomId, { type: 'message-update', message: m, ...extra })
    return m
  }
  async function setBriefMsgStatus(roomId, briefId, status, msgId) {
    let id = msgId
    if (!id) { try { id = (await store.readMessages(roomId)).find((m) => m.kind === 'brief' && m.briefId === briefId)?.id } catch {} }
    if (id) await updateCard(roomId, id, (m) => ({ ...m, briefStatus: status }))
  }
  /** 发起成员（仍在且启用）→ 组长 → 默认主答 → 第一位成员。 */
  function wakeTarget(cfg, seatId) {
    const enabled = cfg.seats.filter((s) => s.enabled !== false)
    return enabled.find((s) => s.id === seatId) || enabled.find((s) => s.leader) || findSeat(enabled, cfg.defaultMain) || enabled[0] || null
  }
  /** 交卷后唤醒：没有进行中的讨论时，以该成员为主答开一轮；有进行中的讨论时只让其回到可发言状态（提示已在记录里）。 */
  function wake(roomId, cfg, seat, note) {
    if (!seat) return null
    back(roomId, seat.id)
    if (runs.has(roomId)) return null
    const enabled = cfg.seats.filter((s) => s.enabled !== false)
    const task = createTask({ id: `t${++taskSeq}-${note.seq}`, seats: enabled, mainId: seat.id, budget: cfg.budget || 10, basedOn: note.seq })
    task.owner = false
    task.source = 'cursor'
    tasks.set(roomId, task)
    emit(roomId, { type: 'task', task: status(roomId).task })
    return ensureLoop(roomId)
  }
  /** 把一张 Cursor 卡片变成空白卷（取消 / 中止 / 重启后状态未知）。 */
  async function blankCursorCard(roomId, cardId, briefId, b, kind) {
    const why = CURSOR_BLANK[kind] || CURSOR_BLANK.cancelled
    return updateCard(roomId, cardId, (m) => ({
      ...m,
      text: why.user,
      data: jsonSafe({ ...(m.data || {}), ok: false, blank: true, status: kind === 'stopped' ? 'cancelled' : kind, title: cursorCardTitle(briefId, b?.repo, why.label), cursorTask: { ...(m.data?.cursorTask || {}), briefId, status: kind === 'stopped' ? 'cancelled' : kind, reason: why.user, aiReason: why.ai, endedAt: new Date(now()).toISOString() } }),
    }))
  }

  /** 插话熔断：中止本房间正在跑的 Cursor 任务（收尾与「取消执行」相同，卡片标「已熔断」）。待执行的任务书不动。 */
  function fuseCursor(roomId) {
    const c = cursorRuns.get(roomId)
    if (!c || c.cancelled) return false
    c.cancelled = 'fused'
    try { c.controller.abort() } catch {}
    return true
  }

  /** 取消任务书：待执行的直接作废（留一张空白卡片）；运行中的中止 cursor-agent，其卡片变为空白卷。 */
  async function cancelBrief(roomId, briefId) {
    const c = cursorRuns.get(roomId)
    if (c && (!briefId || briefId === c.briefId)) {
      c.cancelled = 'cancelled'
      c.controller.abort()
      return true
    }
    const meta = await store.getRoom(roomId)
    const id = briefId || meta.pendingBrief
    const b = id ? meta.briefs?.[id] : null
    if (!b || b.status !== 'awaiting_owner') { await system(roomId, id ? `任务书 #${id} 不在待执行状态。` : '没有待执行的任务书。'); return false }
    await store.patchMeta(roomId, (m) => { if (m.briefs?.[id]) m.briefs[id].status = 'cancelled'; if (m.pendingBrief === id) m.pendingBrief = undefined })
    await setBriefMsgStatus(roomId, id, 'cancelled', b.msgId)
    const cfg = await getRoomConfig()
    const seat = cfg.seats.find((s) => s.id === b.by)
    const why = CURSOR_BLANK.cancelled
    await appendAndEmit(roomId, { kind: 'tool', tool: CURSOR_TOOL_NAME, speaker: seat ? { id: seat.id, name: seat.name } : { id: 'cursor', name: 'Cursor' }, text: why.user, data: jsonSafe({ ok: false, blank: true, status: 'cancelled', briefId: id, briefTitle: b.title, title: cursorCardTitle(id, b.repo, why.label), repo: b.repo, action: b.action, cursorTask: { briefId: id, status: 'cancelled', repo: b.repo, reason: why.user, aiReason: why.ai, endedAt: new Date(now()).toISOString() } }), status: 'ok' }, { relay: false })
    return true
  }

  /** 执行任务书（只由所有者的「执行」触发：执行对话框即批准）。返回在任务结束、卡片补完后才完成的 Promise。 */
  async function executeBrief(roomId, briefId) {
    if (!runCursor) { await system(roomId, '当前环境不支持运行 Cursor。'); return null }
    if (cursorRuns.has(roomId)) { await system(roomId, `Cursor 任务 #${cursorRuns.get(roomId).briefId} 仍在运行。`); return null }
    const run = { controller: new AbortController(), briefId: null, cancelled: null, card: null, promise: null }
    cursorRuns.set(roomId, run) // 同步占位：两次「执行」不会同时启动
    let cfg, b, id
    try {
      cfg = await getRoomConfig()
      const meta = await store.getRoom(roomId)
      id = briefId || meta.pendingBrief
      b = id ? meta.briefs?.[id] : null
      // 中断 / 关闭 / 熔断后可一键继续：先收回 awaiting_owner（等同以前手改 meta.json），再走原执行路径
      if (b && b.status !== 'awaiting_owner' && isBriefContinuable(b.status)) {
        await store.patchMeta(roomId, (m) => {
          if (m.briefs?.[id]) {
            m.briefs[id].status = 'awaiting_owner'
            if (m.briefs[id].runner) delete m.briefs[id].runner
          }
          m.pendingBrief = id
        })
        await setBriefMsgStatus(roomId, id, 'awaiting_owner', b.msgId)
        b = { ...b, status: 'awaiting_owner' }
      }
      if (!b || b.status !== 'awaiting_owner') { cursorRuns.delete(roomId); await system(roomId, id ? `任务书 #${id} 不在待执行状态。` : '没有待执行的任务书。'); return null }
      run.briefId = id
      const seat = cfg.seats.find((s) => s.id === b.by) || null
      const startedAt = new Date(now()).toISOString()
      run.card = await appendAndEmit(roomId, {
        kind: 'tool', tool: CURSOR_TOOL_NAME,
        speaker: seat ? { id: seat.id, name: seat.name } : { id: 'cursor', name: 'Cursor' },
        text: b.title || `任务书 #${id}`,
        data: jsonSafe({ ok: true, status: 'running', briefId: id, briefTitle: b.title, title: cursorCardTitle(id, b.repo, '进行中'), repo: b.repo, action: b.action, cursorTask: { briefId: id, status: 'running', repo: b.repo, startedAt } }),
        status: 'ok',
      }, { relaySeat: seat })
      await store.patchMeta(roomId, (m) => { Object.assign(m.briefs[id], { status: 'running', cardId: run.card.id, runner: { pid: process.pid, startedAt } }); if (m.pendingBrief === id) m.pendingBrief = undefined })
      await setBriefMsgStatus(roomId, id, 'running', b.msgId)
    } catch (e) {
      if (!run.card) cursorRuns.delete(roomId)
      throw e
    }
    emit(roomId, { type: 'cursor', running: true, briefId: id })
    run.promise = finishCursor(roomId, run, b, id, cfg)
    return run.promise
  }

  async function finishCursor(roomId, run, b, id, cfg0) {
    const seat0 = cfg0.seats.find((s) => s.id === b.by) || null
    let lastRelay = 0
    const pending = []
    // 执行明细：进度事件记进卡片（最近 200 步）。面板约每秒更新一次（progress 事件只推给本机），约每 10 秒落盘一次，结束时必落盘。
    const tracker = cursorStepTracker({ now })
    const withSteps = (m) => ({ ...m, data: { ...(m.data || {}), cursorTask: { ...(m.data?.cursorTask || {}), ...tracker.snapshot() } } })
    let liveTimer = null; let lastLive = 0; let lastFlush = now(); let flushing = Promise.resolve()
    const flush = () => { lastFlush = now(); flushing = flushing.then(async () => { if (run.card && !run.done) { const m = await updateCard(roomId, run.card.id, withSteps, { progress: true }).catch(() => null); if (m) run.card = m } }); return flushing }
    const tick = () => {
      liveTimer = null; lastLive = now()
      if (!run.card || run.done) return
      if (now() - lastFlush >= 10000) void flush()
      else emit(roomId, { type: 'message-update', progress: true, message: withSteps(run.card) })
    }
    const schedule = () => { if (liveTimer || run.done) return; liveTimer = setTimeout(tick, Math.max(0, 1000 - (now() - lastLive))); liveTimer.unref?.() }
    const result = await Promise.resolve().then(() => runCursor(b, {
      signal: run.controller.signal,
      onProgress: (p) => {
        emit(roomId, { type: 'cursor-progress', briefId: id, ...p })
        if (tracker.add(p)) schedule()
        if (p.kind !== 'tool') return
        pending.push(p.text)
        if (now() - lastRelay > 20000) { lastRelay = now(); const line = `⏳ Cursor #${id}：${pending.splice(0).slice(-3).join('；')}`.slice(0, 300); void Promise.resolve(tg.relay(seat0, roomId, line, { prefixName: 'Cursor' })).catch(() => {}) }
      },
    })).catch((e) => ({ ok: false, status: 'error', error: String(e?.message || e) }))
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = null }
    if (tracker.total) await flush()
    run.done = true
    await flushing
    try {
      if (run.cancelled) {
        const kind = run.cancelled
        await store.patchMeta(roomId, (m) => { if (m.briefs?.[id]) m.briefs[id].status = kind === 'stopped' ? 'cancelled' : kind })
        await setBriefMsgStatus(roomId, id, kind === 'stopped' ? 'cancelled' : kind, b.msgId)
        const card = await blankCursorCard(roomId, run.card.id, id, b, kind)
        if (card && kind !== 'shutdown') void Promise.resolve(tg.relay(seat0, roomId, toolSummaryLine(card), { prefixName: seat0?.name || 'Cursor' })).catch(() => {})
        emit(roomId, { type: 'cursor', running: false, briefId: id, status: kind === 'fused' ? 'fused' : 'cancelled' })
        return card
      }
      const data0 = jsonSafe({ ...result, briefId: id })
      const done = data0.status === 'success'
      const label = done ? '已完成' : '失败'
      const report = cursorReport(data0, { briefId: id, title: b.title, repo: b.repo })
      let saved = null
      if (toolkit?.results?.save) { try { saved = await toolkit.results.save(roomId, { tool: CURSOR_TOOL_NAME, args: { briefId: id }, text: report }) } catch { saved = null } }
      await store.patchMeta(roomId, (m) => { if (m.briefs?.[id]) { m.briefs[id].status = data0.status; m.briefs[id].sessionId = data0.sessionId || '' } m.lastCursorSession = data0.sessionId || m.lastCursorSession })
      await setBriefMsgStatus(roomId, id, data0.status, b.msgId)
      const { finalText, stderrTail, ...rest } = data0
      const card = await updateCard(roomId, run.card.id, (m) => ({
        ...m,
        text: `任务书 #${id} ${done ? '执行完成' : '执行结束：' + data0.status}`,
        data: jsonSafe({
          ...rest, ok: true, briefTitle: b.title, title: cursorCardTitle(id, b.repo, label),
          ...(saved ? { resultId: saved.id, chars: saved.chars, preview: report.slice(0, 2000) } : { preview: report.slice(0, 2000), finalText }),
          cursorTask: { ...(m.data?.cursorTask || {}), briefId: id, status: done ? 'done' : 'failed', exitCode: data0.exitCode ?? null, durationMs: data0.durationMs ?? null, changedFiles: Array.isArray(data0.changedFiles) ? data0.changedFiles.slice(0, 200) : null, endedAt: new Date(now()).toISOString() },
        }),
      }))
      emit(roomId, { type: 'cursor', running: false, briefId: id, status: data0.status })
      if (!card) return null
      void Promise.resolve(tg.relay(seat0, roomId, toolSummaryLine(card), { prefixName: seat0?.name || 'Cursor' })).catch(() => {})
      const cfg = await getRoomConfig()
      const target = wakeTarget(cfg, b.by)
      const ref = card.data?.resultId ? `card #${card.data.resultId}` : 'its card'
      const note = await system(roomId, `Cursor 任务 #${id} 交卷了`, {
        relay: false, aiVisible: true, notice: 'cursor-done', briefId: id, cardId: card.id,
        aiText: `The Cursor task #${id} handed in its sheet (${ref}, ${done ? 'completed' : 'failed: ' + data0.status}).${target ? ` ${target.name}, open the card and carry on.` : ''}`,
      })
      wake(roomId, cfg, target, note)
      return card
    } finally {
      if (cursorRuns.get(roomId) === run) cursorRuns.delete(roomId)
    }
  }

  /**
   * 启动时调用：上次 DSH 运行期间仍在执行的 Cursor 任务（本进程没有在跑的）→ 任务书标为 interrupted，
   * 卡片变成「状态未知」的空白卷（给用户看真实原因，AI 只看到粗略原因）。返回处理的张数。
   */
  async function recoverCursorRuns() {
    let n = 0
    let rooms = []
    try { rooms = await store.listRooms() } catch { return 0 }
    for (const r of rooms || []) {
      const roomId = r?.id
      if (!roomId) continue
      let meta
      try { meta = await store.getRoom(roomId) } catch { continue }
      for (const [id, b] of Object.entries(meta?.briefs || {})) {
        if (b?.status !== 'running') continue
        const c = cursorRuns.get(roomId)
        if (c && c.briefId === id) continue
        await store.patchMeta(roomId, (m) => { if (m.briefs?.[id]) m.briefs[id].status = 'interrupted' })
        await setBriefMsgStatus(roomId, id, 'interrupted', b.msgId)
        if (b.cardId) await blankCursorCard(roomId, b.cardId, id, b, 'interrupted')
        n++
      }
    }
    return n
  }
  function stop(roomId) {
    let any = false
    const r = runs.get(roomId)
    if (r) { r.userStop = true; r.controller.abort(); any = true }
    const c = cursorRuns.get(roomId)
    if (c) { if (!c.cancelled) c.cancelled = 'stopped'; c.controller.abort(); any = true }
    return any
  }

  async function stopAll() {
    const ps = [...runs.values()].map((r) => { r.userStop = true; r.controller.abort(); return r.promise })
    for (const c of cursorRuns.values()) { if (!c.cancelled) c.cancelled = 'shutdown'; c.controller.abort() }
    await Promise.allSettled(ps)
  }

  /** 棋盘会话变化写成房间系统事件。不要 await ensureLoop：调用方可能就在这一局的循环里。 */
  async function noteCard(roomId, event) {
    if (event.type === 'close') { games.clear(roomId); return }
    if (event.type === 'open') {
      games.clear(roomId)
      const view = event.view
      for (const name of view?.waiting || []) await system(roomId, `${name}，请回复「入座」加入这局${view.label || '牌'}。`)
      const snap = games.snapshot(roomId)
      if (snap.active && !snap.waiting && !snap.paused && snap.actor?.kind === 'ai' && snap.actor.memberId) ensureLoop(roomId)
      return
    }
    if (event.type === 'seat') {
      await system(roomId, `${event.seat?.name || '一位玩家'} 已入座。`, { game: true })
      const snap = games.snapshot(roomId)
      if (snap.active && !snap.waiting && !snap.paused && snap.actor?.kind === 'ai' && snap.actor.memberId) ensureLoop(roomId)
      return
    }
    if (event.type === 'play') {
      const cfg = await getRoomConfig()
      const who = event.who === 'ai' ? 'ai' : 'human'
      const noted = games.noteMove(roomId, who, cfg.gameAiStreak)
      const snap = games.snapshot(roomId)
      const mover = event.seat?.name || (who === 'ai' ? 'AI' : '一方')
      const action = event.action || ''
      const finished = Boolean(event.view?.over)
      const next = finished ? '对局结束。' : (snap.actor ? `轮到 ${snap.actor.name}。` : (snap.waiting ? '还有玩家未入座。' : ''))
      await system(roomId, next ? `${mover} 出了 ${action}，${next}` : `${mover} 出了 ${action}。`, { game: true })
      if (noted.paused) {
        await system(roomId, `对局已暂停（已连续 ${noted.streak} 步），回复「继续」恢复。`)
        return
      }
      if (!finished && snap.actor?.kind === 'ai' && snap.actor.memberId) ensureLoop(roomId)
    }
  }

  async function noteBoard(roomId, event) {
    if (!games || !event) return
    try {
      if (event.table === 'card') { await noteCard(roomId, event); return }
      if (event.type === 'close') { games.clear(roomId); return }
      if (event.type === 'open') {
        games.clear(roomId)
        const view = event.view
        for (const s of view?.seats || []) {
          if (s.status === 'pending') await system(roomId, `${s.name}，请回复「入座」加入这局${view.label || '棋'}。`)
        }
        const snap = games.snapshot(roomId)
        if (snap.active && !snap.waiting && !snap.paused && snap.actor?.kind === 'ai' && snap.actor.memberId) ensureLoop(roomId)
        return
      }
      if (event.type === 'seat') {
        await system(roomId, `${event.seat?.name || '一位玩家'} 已入座。`, { game: true })
        const snap = games.snapshot(roomId)
        if (snap.active && !snap.waiting && !snap.paused && snap.actor?.kind === 'ai' && snap.actor.memberId) ensureLoop(roomId)
        return
      }
      if (event.type === 'move') {
        const cfg = await getRoomConfig()
        const who = event.who === 'ai' ? 'ai' : 'human'
        const noted = games.noteMove(roomId, who, cfg.gameAiStreak)
        const view = event.view
        const mover = event.seat?.name || (who === 'ai' ? 'AI' : '一方')
        const notation = event.notation || ''
        const next = view?.over ? '对局结束。' : (view?.turnSeat ? `轮到 ${view.turnSeat.name}。` : '')
        await system(roomId, next ? `${mover} 下在了${notation}，${next}` : `${mover} 下在了${notation}。`, { game: true })
        if (noted.paused) {
          await system(roomId, `对局已暂停（已连续 ${noted.streak} 步），回复「继续」恢复。`)
          return
        }
        if (!view?.over && view?.turnSeat?.kind === 'ai' && view.turnSeat.memberId) ensureLoop(roomId)
      }
    } catch (e) {
      try { emit(roomId, { type: 'error', error: String(e?.message || e) }) } catch {}
    }
  }

  return { post, start, stop, stopAll, status, executeBrief, cancelBrief, recoverCursorRuns, tasks, noteBoard, restoreCards, userBin, patchAttachment }
}
