/**
 * dsh-workbench shared session-controls: retract / regenerate / circuit-breaker.
 * Mounted from src/index.mjs (host HTTP under /dsh-workbench/api/session/*).
 */
import { listUserTurns, truncateSession, extractUserText, rewindTailTurn, resolveAnchorSeq, recallLiveTurn, recallLiveOutput, REGENERATE_SOURCE_KIND } from './ops.mjs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createCircuitBreaker } from './circuit.mjs'
import { findSessionLogPath } from './zstd-log.mjs'
import { createSamplingStore, mountSamplingExtensions, samplingPayload, SamplingError } from './sampling.mjs'
import { dataDir } from '../tools.mjs'

export { listUserTurns, truncateSession, extractUserText, rewindTailTurn, resolveAnchorSeq, recallLiveTurn, recallLiveOutput, findSessionLogPath, createCircuitBreaker }

/**
 * Cancel live agent for sessionId (manual 熔断).
 */
export function cancelLive(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
  const agent = agents?.get?.(sessionId)
  if (!agent) return { ok: false, error: 'no live agent' }
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  return { ok: true, accepted: true }
}

/**
 * Best-effort flush + detach before rewriting the durable log.
 */
export async function prepareForRewrite(ctx, sessionId) {
  const notes = []
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
  try {
    const r = cancelLive(ctx, sessionId)
    notes.push(r.ok ? 'cancelled' : 'no-live-agent')
  } catch (e) {
    notes.push('cancel-error:' + String(e?.message ?? e))
  }
  // Official cancel still appends the interrupted closers. Wait until the
  // agent leaves `running` so those events land before the suffix cut.
  for (let i = 0; i < 20; i++) {
    const agent = agents?.get?.(sessionId)
    if (!agent || agent.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
    const live = sessions?.get?.(sessionId)
    if (live && typeof sessions.flush === 'function') {
      await sessions.flush(live)
      notes.push('flushed')
    } else if (live && typeof live.flush === 'function') {
      await live.flush()
      notes.push('flushed')
    }
  } catch (e) {
    notes.push('flush-error:' + String(e?.message ?? e))
  }
  return notes
}

function service(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value != null) return value
    }
  } catch { /* fall through to the context property */ }
  try { return ctx?.[name] ?? null }
  catch { return null }
}

function failureText(error) {
  if (error == null || error === '') return ''
  if (typeof error === 'string') return error
  const message = String(error.message || error.reason || error)
  const code = error.code || error.name
  if (code && code !== 'Error' && !message.includes(String(code))) return `${code}: ${message}`
  return message
}

function asAgent(value) {
  if (value && typeof value.followup === 'function') return value
  if (value?.agent && typeof value.agent.followup === 'function') return value.agent
  return null
}

function isLiveSession(value) {
  return !!value && typeof value.append === 'function' && typeof value.snapshotEvents === 'function'
}

function sessionOf(value) {
  if (isLiveSession(value)) return value
  if (isLiveSession(value?.session)) return value.session
  return null
}

function matchId(items, sessionId) {
  const want = String(sessionId)
  for (const item of items) {
    const id = item?.id ?? item?.session?.id
    if (id != null && String(id) === want) return item
  }
  return null
}

function listed(service) {
  if (!service || typeof service.list !== 'function') return []
  try {
    const items = service.list()
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/** A session the user is only viewing is often not in the registry until the next send. */
function findAttached(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  const agents = service(ctx, 'agents')
  const agent = agents?.get?.(sessionId) || matchId(listed(agents), sessionId)
  const live = sessionOf(sessions?.get?.(sessionId))
    || sessionOf(matchId(listed(sessions), sessionId))
    || sessionOf(agent)
  if (!live) return null
  return { sessions, live, agent: agent || agents?.get?.(live.id) || null }
}

function modelOptions(ctx) {
  try {
    const model = service(ctx, 'agentDefaultModel')
    const current = typeof model?.currentSelection === 'function' ? model.currentSelection() : model?.current
    if (current?.provider && current?.model) return { provider: current.provider, model: current.model }
  } catch { /* the resumed log already has a request header */ }
  return {}
}

function attachResult(ctx, agent, found) {
  const live = sessionOf(agent) || found?.live || sessionOf(service(ctx, 'sessions')?.get?.(agent?.id))
  if (!agent || !live) return null
  return { sessions: service(ctx, 'sessions') || found?.sessions || null, live, agent }
}

/**
 * Return the open session, resuming it first when the page is showing a cold log.
 * Disk truncation is the wrong tool for that page: the client keeps the old window.
 * `error` is set when no followup-capable agent could be published.
 */
export async function ensureLiveSession(ctx, sessionId) {
  const found = findAttached(ctx, sessionId)
  if (found?.agent && typeof found.agent.followup === 'function') return found
  const notes = []
  const controller = service(ctx, 'sessionController')
  const resolvers = []
  if (typeof controller?.agents?.resolveAgent === 'function') resolvers.push(controller.agents)
  if (typeof controller?.resolveAgent === 'function') resolvers.push(controller)
  if (!resolvers.length) notes.push(controller ? 'sessionController 上没有 resolveAgent' : '没有 sessionController')
  for (const owner of resolvers) {
    try {
      const result = await owner.resolveAgent(sessionId)
      const agent = asAgent(result?.agent) || asAgent(result)
      const attached = attachResult(ctx, agent, found)
      if (attached) return attached
      const again = findAttached(ctx, sessionId)
      if (again?.agent && typeof again.agent.followup === 'function') return again
      if (result?.error) notes.push(failureText(result.error))
      else notes.push('resolveAgent 没有返回可继续生成的 agent')
    } catch (error) {
      notes.push(failureText(error))
      const again = findAttached(ctx, sessionId)
      if (again?.agent && typeof again.agent.followup === 'function') return again
    }
    break
  }
  const agents = service(ctx, 'agents')
  if (typeof agents?.resume === 'function') {
    try {
      const handle = await agents.resume({
        resumeSessionId: String(sessionId),
        agentOptions: modelOptions(ctx),
      })
      const agent = asAgent(handle) || asAgent(agents.get?.(sessionId))
      const attached = attachResult(ctx, agent, found)
      if (attached) return attached
      notes.push('agents.resume 没有返回可继续生成的 agent')
    } catch (error) {
      notes.push(failureText(error))
    }
  }
  const again = findAttached(ctx, sessionId)
  if (again?.agent && typeof again.agent.followup === 'function') return again
  const error = notes.filter(Boolean).join('；') || '会话还没挂上，未能重新生成'
  if (again?.live || found?.live) return { ...(again || found), error }
  return { sessions: service(ctx, 'sessions'), live: null, agent: null, error }
}

function agentFor(ctx, sessionId, known) {
  if (known && typeof known.cancel === 'function') return known
  const agents = service(ctx, 'agents')
  return agents?.get?.(sessionId) || matchId(listed(agents), sessionId) || null
}

/** Stop a running turn and drop its inbox, so a retracted prompt is not left half-sent. */
function stopOpenTurn(ctx, sessionId, known) {
  const agent = agentFor(ctx, sessionId, known)
  if (!agent || agent.status !== 'running') return false
  agent.cancel({ kind: 'user' }, { keepInbox: false })
  return true
}

/** Cancel still appends the interrupted closers. Wait until those land. */
async function waitUntilIdle(ctx, sessionId, known) {
  for (let i = 0; i < 20; i++) {
    const agent = agentFor(ctx, sessionId, known)
    if (!agent || agent.status !== 'running') return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function flushLive(sessions, live) {
  try {
    if (live && typeof sessions?.flush === 'function') await sessions.flush(live)
    else if (live && typeof live.flush === 'function') await live.flush()
  } catch { /* the marker is already in the live log */ }
}

function messageHasPayload(blocks) {
  return blocks.some((block) => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'text') return String(block.text ?? '').trim().length > 0
    return typeof block.type === 'string' && block.type.length > 0
  })
}

/** Queue the same user text on the live agent. Seq stays contiguous after a recall marker. */
export function rePromptLive(ctx, sessionId, text, { content, sourceKind = REGENERATE_SOURCE_KIND, agent: given } = {}) {
  let blocks
  try {
    blocks = Array.isArray(content) && content.length ? JSON.parse(JSON.stringify(content)) : null
  } catch {
    blocks = null
  }
  if (!blocks) {
    const body = String(text ?? '').trim()
    blocks = body ? [{ type: 'text', text: body }] : []
  }
  if (!messageHasPayload(blocks)) return { ok: false, error: 'empty user text' }
  const agents = service(ctx, 'agents')
  const agent = (given && typeof given.followup === 'function')
    ? given
    : (agents?.get?.(sessionId) || matchId(listed(agents), sessionId))
  if (!agent || typeof agent.followup !== 'function') {
    return { ok: false, error: 'no live agent to resend' }
  }
  const id = randomUUID()
  try {
    agent.followup({
      role: 'user',
      id,
      content: blocks,
      source: { kind: sourceKind },
    })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), messageId: id }
  }
  return { ok: true, accepted: true, messageId: id }
}

/**
 * Official Harness assigns the next seq from the live log length. Do not
 * follow up on that agent after an external suffix cut.
 */
export async function rePrompt(ctx, sessionId, text) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'empty user text' }
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
  const agent = agents?.get?.(sessionId)
  // Official Harness assigns seq = log.length on the live Session. Followup
  // after an external suffix cut would append that old length onto the
  // shortened file and fail the next restore (seq must equal the index).
  if (agent) {
    return {
      ok: false,
      deferred: true,
      error: 'live session still owns the old log length',
      userText: body,
    }
  }
  return {
    ok: false,
    error: 'no live agent; reopen the session and resend',
    userText: body,
  }
}

/**
 * Handle /dsh-workbench/api/session/* routes. Returns true if handled.
 */
export async function handleSessionApi(ctx, circuit, req, res, sub, { sendJson, readBody, getConfig, sampling = null }) {
  if (!sub.startsWith('/session')) return false
  const path = sub.slice('/session'.length) || '/'

  function sessionControlsOn() {
    const c = typeof getConfig === 'function' ? getConfig() : {}
    return c?.sessionControlsEnabled === true
  }

  if (path === '/status' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = url.searchParams.get('sessionId') || ''
    return void sendJson(res, 200, { ok: true, ...circuit.status(sessionId || undefined) })
  }

  if (path === '/notices' && req.method === 'GET') {
    return void sendJson(res, 200, { ok: true, notices: circuit.listNotices() })
  }

  if (path === '/sampling' && req.method === 'GET') {
    if (!sampling) return void sendJson(res, 503, { ok: false, error: '采样设置尚未挂载' })
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = (url.searchParams.get('sessionId') || '').trim()
    if (!sessionId) return void sendJson(res, 409, { ok: false, error: '会话尚未创建，发送一条消息后再设置采样参数' })
    return void sendJson(res, 200, samplingPayload(sampling.get(sessionId), sessionId))
  }

  if (path === '/turns' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return void sendJson(res, 400, { ok: false, error: 'sessionId required' })
    return void sendJson(res, 200, { ok: true, ...listUserTurns(sessionId) })
  }

  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return void sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
  }

  if (path === '/sampling' && req.method === 'POST') {
    if (!sampling) return void sendJson(res, 503, { ok: false, error: '采样设置尚未挂载' })
    let body
    try { body = JSON.parse(await readBody(req) || '{}') }
    catch { return void sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return void sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
    try {
      const saved = sampling.update(body.sessionId, body)
      const sessionId = String(body.sessionId || '').trim()
      return void sendJson(res, 200, { ...samplingPayload(saved, sessionId), saved: true })
    } catch (error) {
      const status = error instanceof SamplingError ? error.status : 500
      const message = error instanceof SamplingError ? error.message : `采样参数保存失败：${error?.message || error}`
      return void sendJson(res, status, { ok: false, error: message })
    }
  }

  if (path === '/cancel' && req.method === 'POST') {
    if (!sessionControlsOn()) return void sendJson(res, 403, { ok: false, error: '会话控制未启用（实验性功能，默认关闭）' })
    const body = JSON.parse(await readBody(req) || '{}')
    const sessionId = body.sessionId
    if (!sessionId) return void sendJson(res, 400, { ok: false, error: 'sessionId required' })
    const reason = body.reason || '手动熔断'
    return void sendJson(res, 200, circuit.cancelSession(sessionId, reason))
  }

  if (path === '/retract' && req.method === 'POST') {
    if (!sessionControlsOn()) return void sendJson(res, 403, { ok: false, error: '会话控制未启用（实验性功能，默认关闭）' })
    const body = JSON.parse(await readBody(req) || '{}')
    const sessionId = body.sessionId
    if (!sessionId) return void sendJson(res, 400, { ok: false, error: 'sessionId required' })
    let userMessageSeq
    try { userMessageSeq = resolveAnchorSeq(sessionId, body) }
    catch (e) { return void sendJson(res, e.status || 400, { ok: false, error: String(e.message || e) }) }
    const attached = await ensureLiveSession(ctx, sessionId)
    if (attached?.live) {
      const stopped = stopOpenTurn(ctx, sessionId, attached.agent)
      if (stopped) {
        const idle = await waitUntilIdle(ctx, sessionId, attached.agent)
        if (!idle) return void sendJson(res, 409, { ok: false, error: 'turn is still running', stopped })
      }
      let recalled
      try { recalled = recallLiveTurn(attached.live, userMessageSeq) }
      catch (e) { return void sendJson(res, e.status || 500, { ok: false, error: String(e.message || e), stopped }) }
      await flushLive(attached.sessions, attached.live)
      return void sendJson(res, 200, { ...recalled, stopped })
    }
    const prep = await prepareForRewrite(ctx, sessionId)
    const result = truncateSession(sessionId, userMessageSeq, { keepMode: 'before-turn' })
    return void sendJson(res, 200, { ...result, prepare: prep })
  }

  if (path === '/regenerate' && req.method === 'POST') {
    if (!sessionControlsOn()) return void sendJson(res, 403, { ok: false, error: '会话控制未启用（实验性功能，默认关闭）' })
    const body = JSON.parse(await readBody(req) || '{}')
    const sessionId = body.sessionId
    if (!sessionId) return void sendJson(res, 400, { ok: false, error: 'sessionId required' })
    let userMessageSeq
    try { userMessageSeq = resolveAnchorSeq(sessionId, body) }
    catch (e) { return void sendJson(res, e.status || 400, { ok: false, error: String(e.message || e) }) }
    const attached = await ensureLiveSession(ctx, sessionId)
    if (attached?.agent && typeof attached.agent.followup === 'function') {
      const stopped = stopOpenTurn(ctx, sessionId, attached.agent)
      if (stopped) {
        const idle = await waitUntilIdle(ctx, sessionId, attached.agent)
        if (!idle) {
          return void sendJson(res, 409, { ok: false, error: 'turn is still running', stopped })
        }
      }
      let recalled
      try { recalled = recallLiveOutput(attached.live, userMessageSeq) }
      catch (e) { return void sendJson(res, e.status || 500, { ok: false, error: String(e.message || e), stopped }) }
      await flushLive(attached.sessions, attached.live)
      const promptResult = rePromptLive(ctx, sessionId, recalled.userText, {
        content: recalled.content,
        agent: attached.agent,
      })
      const { content: _content, ...publicRecall } = recalled
      return void sendJson(res, 200, {
        ...publicRecall,
        mode: 'regenerate',
        stopped,
        prompt: promptResult,
        applied: 'live',
        needReload: false,
      })
    }
    // A cold page still holds the old transcript. Cutting the file here deletes
    // the turn and leaves that transcript on screen.
    return void sendJson(res, 409, {
      ok: false,
      error: attached?.error || '会话还没挂上，未能重新生成',
    })
  }

  return void sendJson(res, 404, { ok: false, error: 'session route not found' })
}

/**
 * Install circuit breaker + return handle for API.
 */
export function mountSessionControls(ctx, getConfig) {
  const circuit = createCircuitBreaker(ctx, getConfig)
  const disposeCircuit = circuit.install()
  let sampling = null
  let disposeSampling = () => {}
  try {
    sampling = createSamplingStore({
      file: join(dataDir(), 'sampling-overrides.json'),
      warn: (message) => ctx.logger?.warn?.(`dsh-workbench: ${message}`),
    })
    sampling.load()
    disposeSampling = mountSamplingExtensions(ctx, sampling)
  } catch (error) {
    sampling = null
    ctx.logger?.warn?.('dsh-workbench: sampling controls not mounted', error?.message || error)
  }
  return {
    circuit,
    sampling,
    dispose() {
      try { disposeSampling() } catch { /* extension service already gone */ }
      try { disposeCircuit?.() } catch { /* circuit already released */ }
    },
  }
}
