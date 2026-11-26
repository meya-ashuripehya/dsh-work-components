/**
 * Per-session temperature / top_p for ordinary DeepSeek Messages calls.
 *
 * Host 0.2.1-rc.5 (@deepseek-ai/dsh-llm-deepseek prepareRequestExtensions):
 * extension fields are merged onto the serialized body, and a name that
 * already exists on that body fails the whole request. temperature is copied
 * from the call when it is not undefined (auto-review sends temperature: 0).
 * top_p is absent from the base body. Agent-loop buildRequest sets sessionId
 * and omits purpose. Compaction sets purpose "compaction"; session-title sets
 * purpose "session-title". Auto-review omits sessionId.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SAMPLING_PROVIDER_IDS = Object.freeze(['deepseek-official', 'deepseek-account'])

export const SAMPLING_SCOPE_TEXT = '仅写入 DeepSeek 官方 Messages 请求（供应商 deepseek-official 与 deepseek-account）。仅在当前模型为 DeepSeek 时生效。部分模型和思考模式会忽略 temperature、top_p，一般只调整其中一个。'

const TEMPERATURE_ERROR = 'temperature 须为 0 到 2 的有限数值，使用默认时不写入'
const TOP_P_ERROR = 'top_p 须为大于 0 且不超过 1 的有限数值，使用默认时不写入'
const NO_SESSION_ERROR = '会话尚未创建，发送一条消息后再设置采样参数'
const DECIMAL = /^[+]?(?:\d+(?:\.\d+)?|\.\d+)$/

export class SamplingError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SamplingError'
    this.status = status
  }
}

export function samplingErrorMessage(kind) {
  return kind === 'top_p' ? TOP_P_ERROR : TEMPERATURE_ERROR
}

export function isTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2
}

export function isTopP(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

function inRange(kind, value) {
  return kind === 'top_p' ? isTopP(value) : isTemperature(value)
}

/** null clears the override. undefined means the field was not included. */
export function normalizeSamplingValue(kind, value) {
  if (value === undefined) return undefined
  if (value === null) return null
  let number = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    if (!DECIMAL.test(text)) throw new SamplingError(samplingErrorMessage(kind))
    number = Number(text)
  }
  if (typeof number !== 'number' || !inRange(kind, number)) throw new SamplingError(samplingErrorMessage(kind))
  return number
}

function cleanRecord(row) {
  if (!row || typeof row !== 'object') return null
  const next = {}
  if (isTemperature(row.temperature)) next.temperature = row.temperature
  if (isTopP(row.top_p)) next.top_p = row.top_p
  return next.temperature === undefined && next.top_p === undefined ? null : next
}

function publicRecord(row) {
  return {
    temperature: row?.temperature ?? null,
    top_p: row?.top_p ?? null,
  }
}

export function createSamplingStore({ file, warn } = {}) {
  let map = Object.create(null)
  function persist(next) {
    if (!file) throw new SamplingError('采样参数没有可写的数据文件', 500)
    const text = JSON.stringify({ version: 1, sessions: next }) + '\n'
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }
  return {
    file,
    load() {
      if (!file) return
      let raw
      try { raw = JSON.parse(readFileSync(file, 'utf8')) }
      catch (error) {
        if (error?.code !== 'ENOENT') warn?.(`sampling store ignored ${file}: ${error?.message || error}`)
        map = Object.create(null)
        return
      }
      const sessions = raw?.sessions
      const next = Object.create(null)
      if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
        for (const [id, row] of Object.entries(sessions)) {
          if (typeof id !== 'string' || !id) continue
          const clean = cleanRecord(row)
          if (clean) next[id] = clean
        }
      }
      map = next
    },
    get(sessionId) {
      return publicRecord(map[sessionId])
    },
    /** Test/read snapshot of stored overrides. Missing keys are null. */
    records() {
      const out = {}
      for (const [id, row] of Object.entries(map)) out[id] = publicRecord(row)
      return out
    },
    update(sessionId, input) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (!id) throw new SamplingError(NO_SESSION_ERROR, 409)
      const current = map[id] ? { ...map[id] } : {}
      const patch = input && typeof input === 'object' ? input : {}
      if (Object.prototype.hasOwnProperty.call(patch, 'temperature')) {
        const value = normalizeSamplingValue('temperature', patch.temperature)
        if (value === null) delete current.temperature
        else if (value !== undefined) current.temperature = value
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'top_p')) {
        const value = normalizeSamplingValue('top_p', patch.top_p)
        if (value === null) delete current.top_p
        else if (value !== undefined) current.top_p = value
      }
      const next = { ...map }
      if (current.temperature === undefined && current.top_p === undefined) delete next[id]
      else next[id] = current
      try { persist(next) }
      catch (error) {
        if (error instanceof SamplingError) throw error
        throw new SamplingError(`采样参数保存失败：${error?.message || error}`, 500)
      }
      map = next
      return publicRecord(map[id])
    },
  }
}

export function samplingPayload(record, sessionId) {
  return {
    ok: true,
    sessionId,
    temperature: record.temperature,
    top_p: record.top_p,
    appliesTo: [...SAMPLING_PROVIDER_IDS],
    scope: SAMPLING_SCOPE_TEXT,
  }
}

/**
 * Ordinary chat is the agent-loop request: a session id, and no purpose.
 * Any purpose is an auxiliary call (compaction, session-title, …).
 * Auto-review has neither sessionId nor purpose, and already sets temperature.
 */
export function isOrdinaryConversation(request) {
  const sessionId = request?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  return request.purpose === undefined
}

export function isDeepSeekModel(model) {
  return typeof model === 'string' && /^deepseek(?:$|[-/][a-z0-9])/i.test(model)
}

export function prepareField(store, request, field) {
  if (field !== 'temperature' && field !== 'top_p') return undefined
  if (!isOrdinaryConversation(request)) return undefined
  const body = request?.body
  if (!body || typeof body !== 'object' || !isDeepSeekModel(body.model) || Object.hasOwn(body, field)) return undefined
  const value = store.get(request.sessionId)[field]
  if (value == null) return undefined
  return { value }
}

/**
 * Same merge as host prepareRequestExtensions: a colliding name fails the
 * request; JSON serialization failure drops every extension field.
 */
export function mergeDeepSeekExtensions(body, fields) {
  const names = Object.keys(fields)
  for (const field of names) {
    if (Object.hasOwn(body, field)) {
      throw new SamplingError(`DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, 500)
    }
  }
  try {
    const payload = JSON.stringify({ ...body, ...fields })
    return { payload, body: JSON.parse(payload), omitted: [] }
  } catch (error) {
    return { payload: JSON.stringify(body), body: JSON.parse(JSON.stringify(body)), omitted: names, error }
  }
}

export function finalMessagesBody(baseBody, request, store) {
  const frozen = Object.freeze({ ...baseBody })
  const seen = { ...request, body: frozen }
  const fields = {}
  for (const field of ['temperature', 'top_p']) {
    const prepared = prepareField(store, seen, field)
    if (prepared !== undefined) fields[field] = prepared.value
  }
  const merged = mergeDeepSeekExtensions(frozen, fields)
  return { ...merged, fields }
}

export function mountSamplingExtensions(ctx, store) {
  const releases = []
  let disposed = false
  function attach(ext) {
    if (!ext || typeof ext.register !== 'function') return () => {}
    const offs = []
    try {
      offs.push(ext.register('temperature', {
        prepare(request) { return prepareField(store, request, 'temperature') },
      }))
      offs.push(ext.register('top_p', {
        prepare(request) { return prepareField(store, request, 'top_p') },
      }))
    } catch (error) {
      for (const off of offs) { try { off() } catch { /* the field was not kept */ } }
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const off of offs) { try { off() } catch { /* already released */ } }
    }
  }
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['deepseekLlmApiExtensions'], (scope) => {
        if (disposed) return () => {}
        let release = () => {}
        try {
          release = attach(scope?.deepseekLlmApiExtensions)
          releases.push(release)
        } catch (error) {
          ctx.logger?.warn?.('dsh-workbench: sampling field registration failed', error?.message || error)
        }
        return () => release()
      })
    }
  } catch (error) {
    ctx?.logger?.warn?.('dsh-workbench: sampling extensions unavailable', error?.message || error)
  }
  return () => {
    disposed = true
    for (const release of releases) release()
    releases.length = 0
  }
}
