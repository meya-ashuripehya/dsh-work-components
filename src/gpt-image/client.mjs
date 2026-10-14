/**
 * GPT Image 2 生图：OpenAI 兼容 Images API 的最小客户端。
 * - API Key 只放在 Authorization 头里，不进日志、不进返回值；错误信息里出现的 Key 一律打码。
 * - 「测试连接」只做 GET {base}/models，不产生出图费用。
 * - 请求与响应都有大小上限，超时用 AbortSignal。
 */

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-image-2'
export const SIZE_OPTIONS = ['auto', '1024x1024', '1536x1024', '1024x1536']
export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high']
export const BACKGROUND_OPTIONS = ['auto', 'transparent', 'opaque']
export const MAX_N = 4
export const MAX_PROMPT_CHARS = 32000
/** 单张输入图上限（与 OpenAI gpt-image 编辑接口一致）。 */
export const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_INPUT_IMAGES = 16
/** 编辑请求的 multipart 总大小上限。 */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024
/** 响应体上限：4 张高分辨率 b64_json 也远小于此。 */
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024
/** url 形式返回时单张下载上限。 */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
export const TEST_TIMEOUT_MS = 15_000
export const DEFAULT_TIMEOUT_SEC = 300

export class GptImageError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'GptImageError'
    if (status !== undefined) this.status = status
    if (code !== undefined) this.code = code
  }
}

/** 规范化 Base URL：去掉末尾斜杠；只接受 http/https。 */
export function normalizeBaseUrl(raw) {
  const text = String(raw ?? '').trim() || DEFAULT_BASE_URL
  let url
  try { url = new URL(text) } catch { throw new GptImageError('Base URL 格式不正确：' + text) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new GptImageError('Base URL 仅支持 http 或 https 协议')
  if (url.username || url.password) throw new GptImageError('Base URL 中不能包含用户名或密码')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/** 把字符串里出现的 Key 以及形如 sk-… 的令牌打码。 */
export function redactSecret(text, apiKey) {
  let out = String(text ?? '')
  const key = String(apiKey ?? '')
  if (key && key.length >= 4) out = out.split(key).join('***')
  return out.replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1***').replace(/(Bearer\s+)[^\s"']+/gi, '$1***')
}

function hostOf(base) {
  try { return new URL(base).host } catch { return base }
}

function serverMessage(bodyText, apiKey) {
  let msg = ''
  try {
    const j = JSON.parse(bodyText)
    msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '')
  } catch {
    msg = /^\s*</.test(bodyText) ? '' : bodyText
  }
  msg = redactSecret(String(msg || '').replace(/\s+/g, ' ').trim(), apiKey)
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg
}

/** HTTP 状态码 → 正式中文说明。 */
export function describeHttpError(status, bodyText, apiKey) {
  const detail = serverMessage(bodyText, apiKey)
  const tail = detail ? '服务端信息：' + detail : ''
  let head
  if (status === 400) head = '请求参数被拒绝（400）。请检查提示词、尺寸、质量等参数是否为该模型所支持。'
  else if (status === 401) head = 'API Key 无效或已失效（401）。请在「GPT Image 2 生图」设置中核对 API Key。'
  else if (status === 403) head = '没有访问权限（403）。该 API Key 可能无权使用此模型，或所属组织尚未完成验证。'
  else if (status === 404) head = '接口或模型不存在（404）。请核对 Base URL 与模型名称。'
  else if (status === 413) head = '请求体过大（413）。请减少输入图片数量或压缩图片后重试。'
  else if (status === 429) head = '请求过于频繁或账户额度不足（429）。请稍后重试，或检查账户余额与速率限制。'
  else if (status >= 500) head = `服务端出错（${status}）。上游服务暂时不可用，请稍后重试。`
  else head = `请求失败（HTTP ${status}）。`
  return new GptImageError(tail ? head + tail : head, { status })
}

function networkError(error, base, timeoutMs) {
  if (error instanceof GptImageError) return error
  const name = error?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new GptImageError(`请求超时（${Math.round(timeoutMs / 1000)} 秒内未完成）。请稍后重试，或在设置中调大超时时间。`, { code: 'timeout' })
  }
  const code = error?.cause?.code || error?.code || ''
  return new GptImageError(`网络连接失败：无法连接到 ${hostOf(base)}${code ? `（${code}）` : ''}。请检查 Base URL、网络或代理设置。`, { code: 'network' })
}

/** 读取响应体，超过上限即中止。 */
export async function readLimited(res, limit) {
  const declared = Number(res.headers?.get?.('content-length') || 0)
  if (declared && declared > limit) throw new GptImageError(`响应体过大（${declared} 字节，上限 ${limit} 字节）。`)
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limit) throw new GptImageError(`响应体过大（超过 ${limit} 字节）。`)
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      try { await reader.cancel() } catch {}
      throw new GptImageError(`响应体过大（超过 ${limit} 字节）。`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function request({ base, apiKey, path, method = 'GET', body, headers = {}, timeoutMs, fetchImpl = fetch, limit = MAX_RESPONSE_BYTES }) {
  let res
  let buf
  try {
    res = await fetchImpl(base + path, {
      method,
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    buf = await readLimited(res, limit)
  } catch (error) {
    throw networkError(error, base, timeoutMs)
  }
  const text = buf.toString('utf8')
  if (!res.ok) throw describeHttpError(res.status, text, apiKey)
  try {
    return JSON.parse(text)
  } catch {
    throw new GptImageError('服务端返回的内容不是有效的 JSON。请核对 Base URL 是否指向 OpenAI 兼容接口（通常以 /v1 结尾）。')
  }
}

function requireKey(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (!key) throw new GptImageError('尚未配置 API Key。请在「GPT Image 2 生图」设置中填写并保存。')
  return key
}

/** 测试连接：GET {base}/models（不出图、不计费）。返回不含 Key 的结果。 */
export async function testConnection({ baseUrl, apiKey, model, fetchImpl, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const key = requireKey(apiKey)
  const base = normalizeBaseUrl(baseUrl)
  const body = await request({ base, apiKey: key, path: '/models', timeoutMs, fetchImpl, limit: 8 * 1024 * 1024 })
  const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? '')).filter(Boolean) : []
  const want = String(model ?? '').trim()
  return {
    status: 'connected',
    host: hostOf(base),
    modelCount: ids.length,
    ...(want ? { modelListed: ids.includes(want) } : {}),
  }
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return { mediaType: 'image/png', ext: '.png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mediaType: 'image/jpeg', ext: '.jpg' }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mediaType: 'image/webp', ext: '.webp' }
  return null
}
export { sniffImage }

async function downloadImage(url, { timeoutMs, fetchImpl = fetch }) {
  let u
  try { u = new URL(url) } catch { throw new GptImageError('服务端返回的图片地址无效。') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new GptImageError('服务端返回的图片地址协议不受支持。')
  let res
  let buf
  try {
    res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(timeoutMs) })
    buf = await readLimited(res, MAX_DOWNLOAD_BYTES)
  } catch (error) {
    throw networkError(error, u.origin, timeoutMs)
  }
  if (!res.ok) throw new GptImageError(`下载生成的图片失败（HTTP ${res.status}）。图片链接可能已过期。`, { status: res.status })
  return buf
}

/** 把 data[] 转成图片字节；b64_json 与 url 两种形式都支持。 */
async function collectImages(body, { timeoutMs, fetchImpl }) {
  const data = Array.isArray(body?.data) ? body.data : []
  if (!data.length) throw new GptImageError('服务端未返回任何图片。可能是提示词触发了内容安全策略，请调整后重试。')
  const out = []
  for (const item of data) {
    let buf
    if (typeof item?.b64_json === 'string' && item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    else if (typeof item?.url === 'string' && item.url) buf = await downloadImage(item.url, { timeoutMs, fetchImpl })
    else throw new GptImageError('服务端返回的图片既没有 b64_json 也没有 url。')
    const kind = sniffImage(buf)
    if (!kind) throw new GptImageError('服务端返回的数据不是可识别的 PNG / JPEG / WebP 图片。')
    out.push({ data: buf, ...kind, ...(typeof item.revised_prompt === 'string' && item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}) })
  }
  return out
}

function usageOf(body) {
  const u = body?.usage
  if (!u || typeof u !== 'object') return undefined
  const pick = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined)
  const usage = {}
  if (pick(u.input_tokens) !== undefined) usage.inputTokens = u.input_tokens
  if (pick(u.output_tokens) !== undefined) usage.outputTokens = u.output_tokens
  if (pick(u.total_tokens) !== undefined) usage.totalTokens = u.total_tokens
  return Object.keys(usage).length ? usage : undefined
}

/** 校验并补全出图参数。 */
export function normalizeImageArgs(args, defaults = {}) {
  const prompt = String(args?.prompt ?? '').trim()
  if (!prompt) throw new GptImageError('需要填写 prompt（图片描述）。')
  if (prompt.length > MAX_PROMPT_CHARS) throw new GptImageError(`prompt 过长（${prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}）。`)
  const size = String(args?.size ?? '').trim() || String(defaults.size ?? '').trim() || 'auto'
  if (!/^(auto|\d{2,5}x\d{2,5})$/.test(size)) throw new GptImageError('size 须为 auto 或「宽x高」形式，例如 1024x1024。')
  const quality = String(args?.quality ?? '').trim() || String(defaults.quality ?? '').trim() || 'auto'
  if (!QUALITY_OPTIONS.includes(quality) && !['standard', 'hd'].includes(quality)) throw new GptImageError('quality 须为 auto、low、medium 或 high。')
  const n = args?.n === undefined || args?.n === null ? 1 : Number(args.n)
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw new GptImageError(`n 须为 1 到 ${MAX_N} 的整数。`)
  const background = args?.background === undefined || args?.background === null || args?.background === '' ? undefined : String(args.background)
  if (background !== undefined && !BACKGROUND_OPTIONS.includes(background)) throw new GptImageError('background 须为 auto、transparent 或 opaque。')
  return { prompt, size, quality, n, ...(background ? { background } : {}) }
}

function isGptImageModel(model) {
  return /^gpt-image/i.test(model)
}

/** POST {base}/images/generations */
export async function generateImages({ baseUrl, apiKey, model, args, defaults, timeoutMs, fetchImpl } = {}) {
  const key = requireKey(apiKey)
  const base = normalizeBaseUrl(baseUrl)
  const m = String(model ?? '').trim() || DEFAULT_MODEL
  const p = normalizeImageArgs(args, defaults)
  const payload = { model: m, prompt: p.prompt, n: p.n, size: p.size, quality: p.quality }
  if (p.background) payload.background = p.background
  if (isGptImageModel(m)) payload.output_format = 'png'
  const body = await request({
    base, apiKey: key, path: '/images/generations', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs, fetchImpl,
  })
  const images = await collectImages(body, { timeoutMs, fetchImpl })
  const usage = usageOf(body)
  return { model: m, ...p, images, ...(usage ? { usage } : {}) }
}

/**
 * POST {base}/images/edits（multipart）。inputs: [{ data: Buffer, mediaType, name }]，mask 同形可选。
 */
export async function editImages({ baseUrl, apiKey, model, args, inputs, mask, defaults, timeoutMs, fetchImpl } = {}) {
  const key = requireKey(apiKey)
  const base = normalizeBaseUrl(baseUrl)
  const m = String(model ?? '').trim() || DEFAULT_MODEL
  const p = normalizeImageArgs(args, defaults)
  if (!Array.isArray(inputs) || !inputs.length) throw new GptImageError('图片编辑至少需要一张输入图片。')
  if (inputs.length > MAX_INPUT_IMAGES) throw new GptImageError(`输入图片最多 ${MAX_INPUT_IMAGES} 张。`)
  let total = 0
  const form = new FormData()
  form.append('model', m)
  form.append('prompt', p.prompt)
  form.append('n', String(p.n))
  form.append('size', p.size)
  form.append('quality', p.quality)
  if (p.background) form.append('background', p.background)
  if (isGptImageModel(m)) form.append('output_format', 'png')
  const field = inputs.length === 1 ? 'image' : 'image[]'
  for (const img of inputs) {
    total += img.data.length
    form.append(field, new Blob([img.data], { type: img.mediaType }), img.name)
  }
  if (mask) {
    total += mask.data.length
    form.append('mask', new Blob([mask.data], { type: mask.mediaType }), mask.name)
  }
  if (total > MAX_REQUEST_BYTES) throw new GptImageError(`输入图片合计过大（${total} 字节，上限 ${MAX_REQUEST_BYTES} 字节）。`)
  const body = await request({ base, apiKey: key, path: '/images/edits', method: 'POST', body: form, timeoutMs, fetchImpl })
  const images = await collectImages(body, { timeoutMs, fetchImpl })
  const usage = usageOf(body)
  return { model: m, ...p, images, ...(usage ? { usage } : {}) }
}
