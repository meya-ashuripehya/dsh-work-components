/**
 * 语音 / 音频转写：Google Gemini 官方 API generateContent，模型 gemini-3.5-transcribe
 * （https://ai.google.dev/gemini-api/docs/generate-content/transcribe）。
 *   - 小文件（≤ INLINE_MAX_BYTES）以 inlineData 直接随请求发送；更大的先经 Files API 断点续传上传，再以 fileData 引用。
 *   - 密钥：优先聊天室设置中保存的转写密钥（宿主凭据 CHATROOM_GEMINI_TRANSCRIBE_KEY）；否则沿用 Gemini 席位所用服务商的密钥引用
 *     （与 tool-selector 解析 DeepSeek 服务商相同：先看席位的服务商，再按名称匹配），见 resolveGeminiKey。
 *   - 密钥只放在 x-goog-api-key 请求头中，不进 URL、不写日志；错误信息经 redact() 去除密钥。
 * fetchImpl 可注入（测试用模拟，不联网）。
 */
export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe'
export const TRANSCRIBE_KEY_REF = 'CHATROOM_GEMINI_TRANSCRIBE_KEY'
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'
export const INLINE_MAX_BYTES = 14 * 1024 * 1024

const isGemini = (x) => /gemini|google/i.test(String(x || ''))

/** Gemini 支持的音频类型；Telegram / 浏览器常见的别名统一过来。 */
export function normalizeAudioMime(mediaType, name = '') {
  const mt = String(mediaType || '').split(';')[0].trim().toLowerCase()
  const map = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/x-m4a': 'audio/m4a', 'audio/mp4': 'audio/m4a', 'audio/x-aac': 'audio/aac', 'audio/x-flac': 'audio/flac', 'audio/mp3': 'audio/mp3', 'audio/x-aiff': 'audio/aiff', 'audio/oga': 'audio/ogg', 'video/ogg': 'audio/ogg', 'audio/x-opus+ogg': 'audio/ogg' }
  if (map[mt]) return map[mt]
  if (mt.startsWith('audio/')) return mt
  const ext = String(name).toLowerCase().split('.').pop()
  return { ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', mp3: 'audio/mp3', wav: 'audio/wav', m4a: 'audio/m4a', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm', weba: 'audio/webm', aiff: 'audio/aiff' }[ext] || 'audio/ogg'
}

/** 从错误文字中去掉密钥。 */
export function redact(text, key) {
  let s = String(text ?? '')
  if (key && key.length >= 6) s = s.split(key).join('***')
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '***').replace(/([?&]key=)[^&\s]+/gi, '$1***')
}

/** Gemini 席位：服务商 / 名称 / 编号 / 模型含 gemini 或 google 的已启用席位，服务商匹配者优先。 */
export function geminiSeat(seats = []) {
  const on = (seats || []).filter((s) => s && s.enabled !== false && s.provider)
  return on.find((s) => isGemini(s.provider)) || on.find((s) => isGemini(s.name) || isGemini(s.id) || isGemini(s.model)) || null
}

/**
 * 依次尝试的凭据引用名（去重）：设置中的转写密钥 → 该服务商在 DSH 中的密钥引用（providerKeyRef，若宿主能给出）
 * → 按服务商编号推出的 <PROVIDER>_API_KEY → GOOGLE_API_KEY / GEMINI_API_KEY。
 */
export function geminiKeyRefs({ seats = [], providerKeyRef } = {}) {
  const seat = geminiSeat(seats)
  const refs = [{ ref: TRANSCRIBE_KEY_REF, via: 'setting' }]
  const prov = seat?.provider || ''
  if (prov && typeof providerKeyRef === 'function') { try { const r = providerKeyRef(prov); if (r) refs.push({ ref: String(r), via: 'seat' }) } catch {} }
  if (prov) refs.push({ ref: prov.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY', via: 'seat' })
  refs.push({ ref: 'GOOGLE_API_KEY', via: 'match' }, { ref: 'GEMINI_API_KEY', via: 'match' })
  const seen = new Set()
  return { seat, refs: refs.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.ref) && !seen.has(x.ref) && seen.add(x.ref)) }
}

/**
 * @param {{ seats?: any[], resolve: (ref: string) => Promise<string|undefined>, providerKeyRef?: (provider: string) => string|undefined }} o
 * @returns {Promise<{ key: string, ref?: string, via?: string, seat?: string, problem?: string }>}
 */
export async function resolveGeminiKey({ seats = [], resolve, providerKeyRef } = {}) {
  const { seat, refs } = geminiKeyRefs({ seats, providerKeyRef })
  for (const r of refs) {
    let v
    try { v = await resolve?.(r.ref) } catch { v = undefined }
    if (typeof v === 'string' && v.trim()) return { key: v.trim(), ref: r.ref, via: r.via, ...(seat ? { seat: seat.name } : {}) }
  }
  return { key: '', problem: '未找到 Gemini API 密钥：请在聊天室「附件与语音」中填写转写密钥，或在 DSH「设置 › 模型」中为 Gemini（google）服务商配置密钥。' }
}

/** 转写设置 → audioTranscriptionConfig。 */
export function transcriptionConfig({ mode = 'SMART', languages = [] } = {}) {
  const codes = (Array.isArray(languages) ? languages : String(languages || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
  const cfg = codes.length ? { languageCodes: codes } : {}
  if (String(mode).toUpperCase() === 'VERBATIM') cfg.mode = 'VERBATIM'
  else cfg.mode = 'SMART'
  return cfg
}

/**
 * 构造 generateContent 请求（纯函数，便于测试）。part 为 { inlineData } 或 { fileData }。
 * @returns {{ url: string, init: { method: string, headers: object, body: string } }}
 */
export function buildTranscribeRequest({ apiKey, model = TRANSCRIBE_MODEL, data, mediaType, fileUri, mode, languages, base = GEMINI_API_BASE }) {
  const mimeType = normalizeAudioMime(mediaType)
  const part = fileUri ? { fileData: { fileUri, mimeType } } : { inlineData: { mimeType, data: Buffer.from(data).toString('base64') } }
  const body = { contents: [{ role: 'user', parts: [part] }], generationConfig: { audioTranscriptionConfig: transcriptionConfig({ mode, languages }) } }
  return {
    url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
  }
}

/** generateContent 响应 → 转写文字（优先 text 部分；没有时拼接逐词结果）。 */
export function parseTranscript(json) {
  const parts = json?.candidates?.[0]?.content?.parts || []
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
  if (text) return text
  const words = []
  let lastSpeaker = ''
  for (const p of parts) {
    const t = p?.audioTranscription
    if (!t) continue
    const sp = t.speakerLabel || ''
    const w = (t.words || []).map((x) => x.word).filter(Boolean).join(' ')
    if (!w) continue
    words.push(sp && sp !== lastSpeaker ? `[${sp}] ${w}` : w)
    lastSpeaker = sp
  }
  return words.join('\n').trim()
}

async function readJson(res) {
  let j = null
  try { j = await res.json() } catch { j = null }
  return j
}

function apiError(res, j, fallback) {
  const msg = j?.error?.message || j?.error?.status || `HTTP ${res?.status}`
  return new Error(`${fallback}：${msg}`)
}

/** Files API 断点续传上传，返回 { uri, mimeType, name }。 */
export async function uploadAudioFile({ fetchImpl, apiKey, data, mediaType, name = 'audio', base = GEMINI_API_BASE, signal, waitMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const mimeType = normalizeAudioMime(mediaType, name)
  const bytes = Buffer.from(data)
  const start = await fetchImpl(`${base}/upload/v1beta/files`, {
    method: 'POST', signal,
    headers: { 'x-goog-api-key': apiKey, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mimeType, 'content-type': 'application/json' },
    body: JSON.stringify({ file: { display_name: String(name).slice(0, 100) } }),
  })
  const uploadUrl = start?.headers?.get?.('x-goog-upload-url')
  if (!start?.ok || !uploadUrl) throw apiError(start, await readJson(start), '音频上传（Files API）失败')
  const up = await fetchImpl(uploadUrl, { method: 'POST', signal, headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: bytes })
  const j = await readJson(up)
  if (!up?.ok || !j?.file?.uri) throw apiError(up, j, '音频上传（Files API）失败')
  let file = j.file
  const until = Date.now() + waitMs
  while (file.state === 'PROCESSING' && Date.now() < until) {
    await sleep(1000)
    const r = await fetchImpl(`${base}/v1beta/${file.name}`, { method: 'GET', signal, headers: { 'x-goog-api-key': apiKey } })
    const jj = await readJson(r)
    if (r?.ok && jj) file = jj
    else break
  }
  if (file.state === 'FAILED') throw new Error('音频上传后处理失败')
  return { uri: file.uri, mimeType: file.mimeType || mimeType, name: file.name }
}

/**
 * 转写一段音频。成功返回 { ok: true, text }，失败返回 { ok: false, error }（error 不含密钥）。
 */
export async function transcribeAudio({ fetchImpl, apiKey, model = TRANSCRIBE_MODEL, data, mediaType, name, mode, languages, base = GEMINI_API_BASE, signal, inlineMax = INLINE_MAX_BYTES }) {
  if (!apiKey) return { ok: false, error: '未配置 Gemini API 密钥' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '网络请求不可用' }
  try {
    let fileUri
    if (Buffer.byteLength(Buffer.from(data)) > inlineMax) fileUri = (await uploadAudioFile({ fetchImpl, apiKey, data, mediaType, name, base, signal })).uri
    const { url, init } = buildTranscribeRequest({ apiKey, model, data: fileUri ? undefined : data, mediaType: normalizeAudioMime(mediaType, name), fileUri, mode, languages, base })
    const res = await fetchImpl(url, { ...init, signal })
    const j = await readJson(res)
    if (!res?.ok) throw apiError(res, j, 'Gemini 转写请求失败')
    const block = j?.promptFeedback?.blockReason
    const text = parseTranscript(j)
    if (!text) return { ok: false, error: block ? `Gemini 拒绝处理（${block}）` : 'Gemini 未返回转写文字（可能没有可识别的语音）' }
    return { ok: true, text: text.slice(0, 20000) }
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    return { ok: false, error: redact(String(e?.message || e), apiKey).slice(0, 300) }
  }
}
