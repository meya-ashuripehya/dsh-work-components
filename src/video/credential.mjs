/**
 * Google Cloud 服务账号：校验 JSON、落盘、OAuth token（进程内缓存）、Vertex 请求参数。
 * 私钥与完整 token 不出日志、不出接口。
 */
import { createSign, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../tools.mjs'
import { VIDEO_MODEL } from '../chatroom/video.mjs'
import { videoBucketSettings } from './bucket.mjs'

export const VIDEO_SA_REL = 'credentials/video-sa.json'
export const SA_INLINE_MAX_BYTES = 20 * 1024 * 1024
export const SA_FILE_PROBLEM = '服务账号文件缺失或无效'
export const SA_SIZE_ERROR = '服务账号模式未配置存储桶，只支持 20 MB 以内的视频。请改用 API Key 模式，或在设置里填写存储桶。'
export const VERTEX_LOCATION_DEFAULT = 'us-central1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const REFRESH_SKEW_MS = 60 * 1000

const cache = new Map() // abs path → { token, expiresAt }
const inflight = new Map()

export function resetAccessTokenCache() {
  cache.clear()
  inflight.clear()
}

export function videoCredentialSource(cfg) {
  return String(cfg?.videoCredentialSource || '').trim() === 'serviceAccount' ? 'serviceAccount' : 'apiKey'
}

export function videoVertexLocation(cfg) {
  const s = String(cfg?.videoVertexLocation || '').trim()
  return s || VERTEX_LOCATION_DEFAULT
}

/** @returns {string|null} 中文原因；合法返回 null */
export function validateServiceAccountObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '不是有效的 JSON 对象'
  if (obj.type !== 'service_account') return '缺少有效的 type（须为 service_account）'
  if (!String(obj.project_id || '').trim()) return '缺少 project_id'
  if (!String(obj.private_key || '').trim()) return '缺少 private_key'
  if (!String(obj.client_email || '').trim()) return '缺少 client_email'
  return null
}

export function parseServiceAccountText(text) {
  try {
    const obj = JSON.parse(String(text || ''))
    const problem = validateServiceAccountObject(obj)
    if (problem) return { ok: false, problem }
    return {
      ok: true,
      projectId: String(obj.project_id).trim(),
      clientEmail: String(obj.client_email).trim(),
      privateKey: String(obj.private_key),
      raw: JSON.stringify(obj),
    }
  } catch {
    return { ok: false, problem: 'JSON 解析失败' }
  }
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function signJwt({ clientEmail, privateKey, now = () => Date.now() }) {
  const iat = Math.floor(now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iss: clientEmail, sub: clientEmail, aud: TOKEN_URL, iat, exp: iat + 3600, scope: JWT_SCOPE }
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createSign('RSA-SHA256').update(body).sign(privateKey)
  return `${body}.${b64url(sig)}`
}

async function exchangeToken({ assertion, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  })
  let j = null
  try { j = await res.json() } catch { j = null }
  if (!res?.ok || !j?.access_token) {
    const msg = j?.error_description || j?.error || `HTTP ${res?.status || 0}`
    throw new Error(`换取访问令牌失败：${msg}`)
  }
  const expiresIn = Number(j.expires_in) || 3600
  return { token: String(j.access_token), expiresAt: Date.now() + expiresIn * 1000 }
}

function readSaFile(abs) {
  if (!abs || !existsSync(abs)) return { ok: false, problem: SA_FILE_PROBLEM }
  try {
    const parsed = parseServiceAccountText(readFileSync(abs, 'utf8'))
    if (!parsed.ok) return { ok: false, problem: parsed.problem || SA_FILE_PROBLEM }
    return { ok: true, ...parsed, abs }
  } catch {
    return { ok: false, problem: SA_FILE_PROBLEM }
  }
}

export function serviceAccountAbsPath(cfg, root = dataDir()) {
  const rel = String(cfg?.videoServiceAccountFile || '').trim() || VIDEO_SA_REL
  return { rel, abs: join(root || dataDir(), rel.replace(/^[/\\]+/, '')) }
}

export function readServiceAccountMeta(cfg, root = dataDir()) {
  const { rel, abs } = serviceAccountAbsPath(cfg, root)
  const file = readSaFile(abs)
  if (!file.ok) return { ok: false, problem: file.problem, relPath: rel }
  return { ok: true, relPath: rel, projectId: file.projectId, clientEmail: file.clientEmail, privateKey: file.privateKey }
}

export function atomicWriteText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    const old = `${file}.old`
    let backed = false
    try {
      if (existsSync(file)) { renameSync(file, old); backed = true }
      renameSync(tmp, file)
      if (backed) rmSync(old, { force: true })
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch {}
      throw e
    }
  }
}

/** 校验通过后原子写入默认路径；返回相对路径与公开字段。 */
export function saveServiceAccountJson(text, root = dataDir()) {
  const parsed = parseServiceAccountText(text)
  if (!parsed.ok) return parsed
  const rel = VIDEO_SA_REL
  const abs = join(root || dataDir(), rel)
  atomicWriteText(abs, parsed.raw)
  return { ok: true, file: rel, email: parsed.clientEmail, projectId: parsed.projectId }
}

export function removeServiceAccountFile(cfg, root = dataDir()) {
  const { rel, abs } = serviceAccountAbsPath(cfg, root)
  try { if (existsSync(abs)) rmSync(abs, { force: true }) } catch {}
  const defaultAbs = join(root || dataDir(), VIDEO_SA_REL)
  if (abs !== defaultAbs) {
    try { if (existsSync(defaultAbs)) rmSync(defaultAbs, { force: true }) } catch {}
  }
  resetAccessTokenCache()
  return rel
}

/**
 * @param {{ keyPath: string, now?: () => number, fetchImpl?: typeof fetch }} o
 * @returns {Promise<{ token: string, expiresAt: number }>}
 */
export async function getAccessToken({ keyPath, now = () => Date.now(), fetchImpl = fetch }) {
  const abs = keyPath
  const hit = cache.get(abs)
  const t = now()
  if (hit && hit.expiresAt - REFRESH_SKEW_MS > t) return hit
  if (inflight.has(abs)) return inflight.get(abs)
  const p = (async () => {
    const sa = readSaFile(abs)
    if (!sa.ok) throw new Error(sa.problem || SA_FILE_PROBLEM)
    const assertion = signJwt({ clientEmail: sa.clientEmail, privateKey: sa.privateKey, now })
    const tok = await exchangeToken({ assertion, fetchImpl })
    const out = { token: tok.token, expiresAt: tok.expiresAt }
    cache.set(abs, out)
    return out
  })().finally(() => { inflight.delete(abs) })
  inflight.set(abs, p)
  return p
}

export function vertexGenerateUrl({ projectId, location, model }) {
  const loc = String(location || VERTEX_LOCATION_DEFAULT).trim() || VERTEX_LOCATION_DEFAULT
  const proj = String(projectId || '').trim()
  // 原生 generateContent 的模型名不带 google/ 前缀（那是 OpenAI 兼容端点用的），
  // 且模型路径段不能整体转义——否则斜杠会变成 %2F，Vertex 报 Invalid Endpoint name。
  const m = String(model || '').trim().replace(/^google\//, '')
  const modelPath = m.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/')
  // global 是"跨区域分摊"的特殊 location：主机没有区域前缀，
  // 写成 global-aiplatform.googleapis.com 会解析到不存在的主机。
  const host = loc.toLowerCase() === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${modelPath}:generateContent`
}

export function videoAuthReady(k) {
  if (!k || k.problem) return false
  if (k.credentialSource === 'serviceAccount') return true
  return !!k.key
}

function videoModelOf(cfg) {
  const model = String(cfg?.videoModel || '').trim()
  const legacyModel = String(cfg?.chatroomVideoModel || '').trim()
  return model && (model !== VIDEO_MODEL || !legacyModel) ? model : (legacyModel || VIDEO_MODEL)
}

/** 供 chatroom / 会话工具拼 generateWithVideo 参数。 */
export async function videoGenerateAuth(cfg, fetchImpl, { root = dataDir(), now } = {}) {
  const { resolveVideoKey } = await import('./key.mjs')
  const k = resolveVideoKey(cfg, root)
  if (!videoAuthReady(k)) return { error: k.problem || SA_FILE_PROBLEM }
  const model = videoModelOf(cfg)
  if (k.credentialSource === 'serviceAccount') {
    const { abs } = serviceAccountAbsPath(cfg, root)
    const bucket = videoBucketSettings(cfg)
    return {
      fetchImpl,
      model,
      credentialSource: 'serviceAccount',
      vertexProject: k.projectId,
      vertexLocation: k.location,
      dataRoot: root,
      getAccessToken: async () => (await getAccessToken({ keyPath: abs, fetchImpl, now })).token,
      ...(bucket.enabled ? { videoBucket: bucket.bucket, videoBucketPrefix: bucket.prefix } : {}),
    }
  }
  const baseRaw = String(cfg?.videoBaseUrl || '').trim().replace(/\/+$/, '')
  let base = ''
  if (baseRaw) {
    try {
      const u = new URL(baseRaw)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host && !u.username && !u.password && !u.search && !u.hash) base = baseRaw
    } catch { base = '' }
  }
  return {
    fetchImpl,
    model,
    credentialSource: 'apiKey',
    apiKey: k.key,
    ...(base ? { base } : {}),
  }
}
