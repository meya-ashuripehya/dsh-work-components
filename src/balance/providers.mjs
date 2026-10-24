/**
 * 「余额查询」：各服务商官方查询接口的最小客户端（只读）。
 * - 每个服务商使用本卡片中单独保存的密钥，不复用 DSH 聊天服务商的密钥。
 * - 密钥只放在请求头（阿里云为签名参数），不进日志、不进返回值；错误信息一律打码。
 * - 只请求固定的官方主机；请求有超时与响应大小上限。
 * - 返回统一结构：{ items: [{ label, value, currency, type }], note? }，type 为 balance（余额）/ spend（已用金额）/ info（附加信息）。
 */
import { createHmac, randomUUID } from 'node:crypto'

export const REQUEST_TIMEOUT_MS = 15_000
export const MAX_RESPONSE_CHARS = 1_000_000

export class BalanceError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'BalanceError'
    if (status !== undefined) this.status = status
    if (code !== undefined) this.code = code
  }
}

/** 把出现的密钥与常见令牌形态打码。 */
export function redactText(text, secrets = []) {
  let out = String(text ?? '')
  for (const s of secrets) {
    const v = String(s ?? '')
    if (v && v.length >= 4) out = out.split(v).join('***')
  }
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{2})[A-Za-z0-9_-]{6,}/g, '$1***')
    .replace(/\b(xai-[A-Za-z0-9_-]{2})[A-Za-z0-9_-]{6,}/g, '$1***')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/(AccessKeyId=)[^&\s"]+/gi, '$1***')
    .replace(/(Signature=)[^&\s"]+/gi, '$1***')
}

function serverMessage(text, secrets) {
  let msg = ''
  try {
    const j = JSON.parse(text)
    msg = j?.error?.message || j?.message || j?.Message || j?.msg || (typeof j?.error === 'string' ? j.error : '') || (typeof j?.data === 'string' ? j.data : '')
  } catch {
    msg = /^\s*</.test(text) ? '' : text
  }
  msg = redactText(String(msg || '').replace(/\s+/g, ' ').trim(), secrets)
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg
}

/** HTTP 状态码 → 简短的正式中文说明（已打码）。 */
export function describeHttpError(status, text, secrets = [], hint = '') {
  const detail = serverMessage(text || '', secrets)
  let head
  if (status === 401) head = '密钥无效或已失效（401）'
  else if (status === 403) head = '密钥权限不足（403）' + (hint ? '：' + hint : '')
  else if (status === 404) head = '接口不存在或参数有误（404）'
  else if (status === 429) head = '请求过于频繁（429），请稍后再试'
  else if (status >= 500) head = `服务端暂时不可用（${status}）`
  else head = `请求被拒绝（${status}）`
  return detail ? `${head}。服务端信息：${detail}` : `${head}。`
}

/**
 * GET/POST 并解析 JSON。非 2xx 抛出 BalanceError（已打码）。
 * @returns {Promise<any>}
 */
export async function requestJson(url, { method = 'GET', headers = {}, body, secrets = [], fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS, hint403 = '' } = {}) {
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') throw new BalanceError('当前运行环境不支持网络请求。')
  let res
  try {
    res = await f(url, { method, headers: { accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  } catch (error) {
    const name = error?.name || ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new BalanceError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）。`)
    throw new BalanceError('网络请求失败：' + redactText(String(error?.cause?.code || error?.message || error), secrets).slice(0, 120))
  }
  let text = ''
  try { text = await res.text() } catch { text = '' }
  if (text.length > MAX_RESPONSE_CHARS) throw new BalanceError('服务端响应过大，已放弃解析。')
  if (!res.ok) throw new BalanceError(describeHttpError(res.status, text, secrets, hint403), { status: res.status })
  try { return JSON.parse(text) } catch { throw new BalanceError('服务端返回的不是有效的 JSON。', { status: res.status }) }
}

/** 字符串 / 数字 → 有限数（去掉千分位逗号）；无法解析时返回 null。 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/,/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const round = (n, d = 4) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)
const item = (label, value, currency, type = 'info') => ({ label, value: round(value), currency: String(currency || '').toUpperCase(), type })
const keep = (list) => list.filter((x) => x && x.value != null)

// ── 时间范围（已用金额）：本月（UTC 月初起）或近 30 天（按 UTC 日对齐）──
export function spendRange(range, now = new Date()) {
  const end = new Date(now.getTime())
  let start
  if (range === '30d') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - 29 * 86400_000)
  } else {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  }
  return { start, end, label: range === '30d' ? '近 30 天已用金额' : '本月已用金额（UTC）' }
}

// ── 阿里云 RPC 签名（HMAC-SHA1，SignatureVersion 1.0），不依赖 SDK ──
export function aliyunPercentEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 构造已签名的 QueryAccountBalance 查询串（纯函数，便于测试）。 */
export function aliyunSignedQuery({ accessKeyId, accessKeySecret, action = 'QueryAccountBalance', version = '2017-12-14', timestamp, nonce, method = 'GET', extra = {} }) {
  const params = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: timestamp || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: nonce || randomUUID(),
    Action: action,
    ...extra,
  }
  const canonical = Object.keys(params).sort().map((k) => aliyunPercentEncode(k) + '=' + aliyunPercentEncode(params[k])).join('&')
  const stringToSign = method + '&' + aliyunPercentEncode('/') + '&' + aliyunPercentEncode(canonical)
  const signature = createHmac('sha1', String(accessKeySecret) + '&').update(stringToSign).digest('base64')
  return canonical + '&Signature=' + aliyunPercentEncode(signature)
}

const OPTION = (key, label, options, def) => ({ key, label, type: 'select', options, def })
const SECRET = (key, label, placeholder) => ({ key, label, type: 'secret', placeholder })
const TEXT = (key, label, placeholder) => ({ key, label, type: 'text', placeholder, def: '' })
const SWITCH = (key, label, def = false) => ({ key, label, type: 'switch', def })
const RANGE_OPTIONS = [{ value: 'month', label: '本月（UTC）' }, { value: '30d', label: '近 30 天' }]

/**
 * 有官方查询接口的服务商。enabledKey 与各 fields 的 key 都是本插件的设置键。
 * kind：balance（查询余额）/ spend（只能查询已用金额）。
 */
export const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'balance', enabledKey: 'balanceDeepseekEnabled',
    console: 'https://platform.deepseek.com/usage',
    desc: '官方接口 GET https://api.deepseek.com/user/balance，使用普通 API Key。',
    fields: [SECRET('balanceDeepseekKey', 'API Key', 'sk-…')],
    async query(s, o) {
      const key = s.balanceDeepseekKey
      const j = await requestJson('https://api.deepseek.com/user/balance', { headers: { authorization: 'Bearer ' + key }, secrets: [key], ...o })
      const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : []
      if (!infos.length) throw new BalanceError('服务端未返回余额信息。')
      const items = []
      for (const b of infos) {
        items.push(item('可用余额', toNumber(b.total_balance), b.currency, 'balance'))
        items.push(item('赠送余额', toNumber(b.granted_balance), b.currency))
        items.push(item('充值余额', toNumber(b.topped_up_balance), b.currency))
      }
      return { items: keep(items), ...(j?.is_available === false ? { note: '余额不足，当前无法调用 API。' } : {}) }
    },
  },
  {
    id: 'xai', name: 'xAI（Grok）', kind: 'balance', enabledKey: 'balanceXaiEnabled',
    console: 'https://console.x.ai',
    desc: '官方 Management API（management-api.x.ai）。需要在 xAI Console › Settings › Management Keys 创建的管理密钥与团队 ID；普通推理 API Key 无法查询。',
    fields: [SECRET('balanceXaiKey', '管理密钥（Management Key）', 'xai-…'), TEXT('balanceXaiTeamId', '团队 ID（Team ID）', '例如 65c1e471-…'), SWITCH('balanceXaiInvoice', '同时显示本月后付费账单预览')],
    async query(s, o) {
      const key = s.balanceXaiKey
      const team = String(s.balanceXaiTeamId || '').trim()
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(team)) throw new BalanceError('请填写有效的团队 ID（Team ID）。')
      const base = 'https://management-api.x.ai/v1/billing/teams/' + encodeURIComponent(team)
      const headers = { authorization: 'Bearer ' + key }
      const hint403 = '请确认使用的是管理密钥，且具有 Billing 读取权限'
      const j = await requestJson(base + '/prepaid/balance', { headers, secrets: [key], hint403, ...o })
      // total.val 为美分；购买记为负、消费记为正，因此可用余额 = -total / 100。
      const cents = toNumber(j?.total?.val)
      if (cents == null) throw new BalanceError('服务端未返回预付费余额。')
      const items = [item('预付费余额', -cents / 100, 'USD', 'balance')]
      let note
      if (s.balanceXaiInvoice === true) {
        try {
          const p = await requestJson(base + '/postpaid/invoice/preview', { headers, secrets: [key], hint403, ...o })
          const due = toNumber(p?.coreInvoice?.amountAfterVat)
          const limit = toNumber(p?.effectiveSpendingLimit)
          if (due != null) items.push(item('本月后付费（预览）', due / 100, 'USD', 'spend'))
          if (limit != null) items.push(item('后付费额度上限', limit / 100, 'USD'))
        } catch (error) {
          note = '后付费账单预览未取得：' + (error?.message || error)
        }
      }
      return { items: keep(items), ...(note ? { note } : {}) }
    },
  },
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'balance', enabledKey: 'balanceOpenrouterEnabled',
    console: 'https://openrouter.ai/settings/credits',
    desc: '普通 API Key 可查询该密钥的额度与用量（GET /api/v1/key）；管理密钥（Management Key）可查询账户总余额（GET /api/v1/credits）。按密钥权限显示能查到的内容。',
    fields: [SECRET('balanceOpenrouterKey', 'API Key 或管理密钥', 'sk-or-…')],
    async query(s, o) {
      const key = s.balanceOpenrouterKey
      const headers = { authorization: 'Bearer ' + key }
      const items = []
      let firstError = null
      try {
        const c = await requestJson('https://openrouter.ai/api/v1/credits', { headers, secrets: [key], ...o })
        const total = toNumber(c?.data?.total_credits)
        const used = toNumber(c?.data?.total_usage)
        if (total != null && used != null) items.push(item('账户余额', total - used, 'USD', 'balance'))
        if (total != null) items.push(item('累计充值', total, 'USD'))
        if (used != null) items.push(item('累计用量', used, 'USD'))
      } catch (error) {
        if (!(error instanceof BalanceError) || (error.status !== 401 && error.status !== 403)) firstError = error
      }
      try {
        const k = await requestJson('https://openrouter.ai/api/v1/key', { headers, secrets: [key], ...o })
        const d = k?.data || {}
        const hasAccount = items.some((x) => x.type === 'balance')
        const remaining = toNumber(d.limit_remaining)
        if (remaining != null) items.push(item('此密钥剩余额度', remaining, 'USD', hasAccount ? 'info' : 'balance'))
        const monthly = toNumber(d.usage_monthly)
        if (monthly != null) items.push(item('此密钥本月用量', monthly, 'USD', 'spend'))
        const usage = toNumber(d.usage)
        if (usage != null) items.push(item('此密钥累计用量', usage, 'USD'))
      } catch (error) {
        if (!items.length) throw firstError || error
      }
      if (!items.length) throw firstError || new BalanceError('该密钥未返回可显示的额度信息。')
      return { items: keep(items) }
    },
  },
  {
    id: 'moonshot', name: 'Moonshot（Kimi）', kind: 'balance', enabledKey: 'balanceMoonshotEnabled',
    console: 'https://platform.kimi.com',
    desc: '官方接口 GET /v1/users/me/balance，使用普通 API Key。中国站与国际站的账户、余额与密钥相互独立。',
    fields: [SECRET('balanceMoonshotKey', 'API Key', 'sk-…'), OPTION('balanceMoonshotRegion', '站点', [{ value: 'cn', label: '中国站 api.moonshot.cn（人民币）' }, { value: 'ai', label: '国际站 api.moonshot.ai（美元）' }], 'cn')],
    async query(s, o) {
      const key = s.balanceMoonshotKey
      const intl = s.balanceMoonshotRegion === 'ai'
      const j = await requestJson(`https://api.moonshot.${intl ? 'ai' : 'cn'}/v1/users/me/balance`, { headers: { authorization: 'Bearer ' + key }, secrets: [key], ...o })
      const d = j?.data
      if (!d || typeof d !== 'object') throw new BalanceError('服务端未返回余额信息。')
      const cur = intl ? 'USD' : 'CNY'
      return { items: keep([item('可用余额', toNumber(d.available_balance), cur, 'balance'), item('代金券余额', toNumber(d.voucher_balance), cur), item('现金余额', toNumber(d.cash_balance), cur)]) }
    },
  },
  {
    id: 'siliconflow', name: '硅基流动（SiliconFlow）', kind: 'balance', enabledKey: 'balanceSiliconflowEnabled',
    console: 'https://cloud.siliconflow.cn/account/ak',
    desc: '官方接口 GET /v1/user/info，使用普通 API Key。',
    fields: [SECRET('balanceSiliconflowKey', 'API Key', 'sk-…'), OPTION('balanceSiliconflowRegion', '站点', [{ value: 'cn', label: '中国站 api.siliconflow.cn（人民币）' }, { value: 'com', label: '国际站 api.siliconflow.com（美元）' }], 'cn')],
    async query(s, o) {
      const key = s.balanceSiliconflowKey
      const intl = s.balanceSiliconflowRegion === 'com'
      const j = await requestJson(`https://api.siliconflow.${intl ? 'com' : 'cn'}/v1/user/info`, { headers: { authorization: 'Bearer ' + key }, secrets: [key], ...o })
      const d = j?.data
      if (!d || typeof d !== 'object') throw new BalanceError('服务端未返回账户信息。')
      const cur = intl ? 'USD' : 'CNY'
      return { items: keep([item('总余额', toNumber(d.totalBalance), cur, 'balance'), item('充值余额', toNumber(d.chargeBalance), cur), item('赠送余额', toNumber(d.balance), cur)]) }
    },
  },
  {
    id: 'openai', name: 'OpenAI', kind: 'spend', enabledKey: 'balanceOpenaiEnabled',
    console: 'https://platform.openai.com/settings/organization/billing/overview',
    desc: 'OpenAI 没有公开的余额查询接口；此处使用官方 Costs API（GET /v1/organization/costs）查询已用金额，需要组织的 Admin Key（普通 API Key 无法查询）。',
    fields: [SECRET('balanceOpenaiKey', 'Admin Key', 'sk-admin-…'), OPTION('balanceOpenaiRange', '统计范围', RANGE_OPTIONS, 'month')],
    async query(s, o) {
      const key = s.balanceOpenaiKey
      const r = spendRange(s.balanceOpenaiRange, o.now?.())
      const totals = new Map()
      let page = ''
      for (let i = 0; i < 6; i++) {
        const q = new URLSearchParams({ start_time: String(Math.floor(r.start.getTime() / 1000)), end_time: String(Math.floor(r.end.getTime() / 1000)), bucket_width: '1d', limit: '31' })
        if (page) q.set('page', page)
        const j = await requestJson('https://api.openai.com/v1/organization/costs?' + q, { headers: { authorization: 'Bearer ' + key }, secrets: [key], hint403: '需要组织的 Admin Key', ...o })
        for (const b of Array.isArray(j?.data) ? j.data : []) {
          for (const x of Array.isArray(b?.results) ? b.results : []) {
            const v = toNumber(x?.amount?.value)
            if (v == null) continue
            const cur = String(x?.amount?.currency || 'usd').toUpperCase()
            totals.set(cur, (totals.get(cur) || 0) + v)
          }
        }
        if (!j?.has_more || !j?.next_page) break
        page = String(j.next_page)
      }
      if (!totals.size) totals.set('USD', 0)
      return { items: [...totals].map(([cur, v]) => item(r.label, v, cur, 'spend')) }
    },
  },
  {
    id: 'anthropic', name: 'Anthropic（Claude）', kind: 'spend', enabledKey: 'balanceAnthropicEnabled',
    console: 'https://console.anthropic.com/settings/billing',
    desc: 'Anthropic 没有公开的余额查询接口；此处使用官方 Cost Report（GET /v1/organizations/cost_report）查询已用金额，需要 Admin API Key（sk-ant-admin…，普通 API Key 无法查询）。',
    fields: [SECRET('balanceAnthropicKey', 'Admin API Key', 'sk-ant-admin…'), OPTION('balanceAnthropicRange', '统计范围', RANGE_OPTIONS, 'month')],
    async query(s, o) {
      const key = s.balanceAnthropicKey
      const r = spendRange(s.balanceAnthropicRange, o.now?.())
      const totals = new Map()
      let page = ''
      for (let i = 0; i < 6; i++) {
        const q = new URLSearchParams({ starting_at: r.start.toISOString(), ending_at: r.end.toISOString(), bucket_width: '1d', limit: '31' })
        if (page) q.set('page', page)
        const j = await requestJson('https://api.anthropic.com/v1/organizations/cost_report?' + q, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, secrets: [key], hint403: '需要 Admin API Key', ...o })
        for (const b of Array.isArray(j?.data) ? j.data : []) {
          for (const x of Array.isArray(b?.results) ? b.results : []) {
            // amount 为最小货币单位（美分）的十进制字符串。
            const v = toNumber(x?.amount)
            if (v == null) continue
            const cur = String(x?.currency || 'USD').toUpperCase()
            totals.set(cur, (totals.get(cur) || 0) + v / 100)
          }
        }
        if (!j?.has_more || !j?.next_page) break
        page = String(j.next_page)
      }
      if (!totals.size) totals.set('USD', 0)
      return { items: [...totals].map(([cur, v]) => item(r.label, v, cur, 'spend')) }
    },
  },
  {
    id: 'aliyun', name: '阿里云（百炼 / DashScope 账户）', kind: 'balance', enabledKey: 'balanceAliyunEnabled',
    console: 'https://usercenter2.aliyun.com/finance/fund-management/overview',
    desc: '百炼 API Key 无法查询余额；此处使用阿里云费用中心官方 OpenAPI（BssOpenApi QueryAccountBalance），需要 RAM 用户的 AccessKey，并授予 bss:DescribeAcccount 权限。查询的是整个阿里云账户的余额。',
    fields: [SECRET('balanceAliyunKeyId', 'AccessKey ID', 'LTAI…'), SECRET('balanceAliyunKeySecret', 'AccessKey Secret', ''), OPTION('balanceAliyunRegion', '站点', [{ value: 'cn', label: '中国站 business.aliyuncs.com' }, { value: 'intl', label: '国际站 business.ap-southeast-1.aliyuncs.com' }], 'cn')],
    async query(s, o) {
      const id = s.balanceAliyunKeyId
      const secret = s.balanceAliyunKeySecret
      const host = s.balanceAliyunRegion === 'intl' ? 'business.ap-southeast-1.aliyuncs.com' : 'business.aliyuncs.com'
      const qs = aliyunSignedQuery({ accessKeyId: id, accessKeySecret: secret, timestamp: o.now ? o.now().toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined })
      const j = await requestJson(`https://${host}/?${qs}`, { secrets: [id, secret], hint403: '请为该 AccessKey 授予 bss:DescribeAcccount 权限', ...o })
      if (j?.Success === false || !j?.Data) throw new BalanceError('查询失败：' + redactText(String(j?.Message || j?.Code || '未知错误'), [id, secret]).slice(0, 160))
      const d = j.Data
      const cur = d.Currency || 'CNY'
      return { items: keep([item('可用额度', toNumber(d.AvailableAmount), cur, 'balance'), item('现金余额', toNumber(d.AvailableCashAmount), cur), item('信控额度', toNumber(d.CreditAmount), cur)]) }
    },
  },
]

/** 没有官方查询接口的服务商：只显示说明与控制台链接。 */
export const UNSUPPORTED = [
  { id: 'gemini', name: 'Google Gemini（AI Studio）', console: 'https://aistudio.google.com/billing', desc: '无官方查询接口：Gemini API Key 没有独立余额，预付费余额只能在 AI Studio 的 Billing 页面查看。' },
  { id: 'zhipu', name: '智谱（BigModel）', console: 'https://open.bigmodel.cn/', desc: '无官方查询接口：智谱开放平台未公开余额查询 API，请在控制台查看。' },
]

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null
}

/** 该服务商的密钥是否都已填写（不返回值）。 */
export function providerConfigured(p, cfg) {
  return p.fields.filter((f) => f.type === 'secret').every((f) => typeof cfg?.[f.key] === 'string' && cfg[f.key].trim() !== '')
}
