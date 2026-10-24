// 余额查询：用模拟 fetch 覆盖各官方服务商的解析与单位换算、打码、缓存、设置接口与工具注册；不访问真实接口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDERS, providerById, aliyunSignedQuery, spendRange, redactText, toNumber, BalanceError } from './providers.mjs'
import { createBalanceFeature, handleBalanceApi, balanceSchemaShape, balanceSettings, mergeExtraEntries, isLow, BALANCE_KEYS } from './index.mjs'
import { createBalanceTools } from './tools.mjs'
import { validateJsonSchemaValue } from '../../vendor/dsh-tools/json-schema.js'
import { isOpenTool } from '../channels/telegram/owner-gate.mjs'

const KEY = 'sk-test-do-not-leak-0123456789abcdef'
const NOW = () => new Date('2026-10-15T04:00:00Z')

/** 模拟 fetch：routes 为 [predicate(url, init) → { status, body }]，记录每次请求。 */
function mockFetch(routes) {
  const calls = []
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} })
    for (const r of routes) {
      const out = r(String(url), init)
      if (out) {
        const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body)
        return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => text }
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":{"message":"no route"}}' }
  }
  f.calls = calls
  return f
}
const ok = (body) => ({ status: 200, body })
const opts = (fetchImpl) => ({ fetchImpl, timeoutMs: 2000, now: NOW })
const byLabel = (r, label) => r.items.find((x) => x.label === label)

test('DeepSeek：解析各币种余额，密钥只在 Authorization 头', async () => {
  const f = mockFetch([(u) => u === 'https://api.deepseek.com/user/balance' && ok({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })])
  const r = await providerById('deepseek').query({ balanceDeepseekKey: KEY }, opts(f))
  assert.deepEqual(byLabel(r, '可用余额'), { label: '可用余额', value: 110, currency: 'CNY', type: 'balance' })
  assert.equal(byLabel(r, '赠送余额').value, 10)
  assert.match(r.note, /余额不足/)
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + KEY)
  assert.ok(!f.calls[0].url.includes(KEY))
})

test('xAI：total.val 为美分且购买记为负 → 余额为正美元；可选后付费预览', async () => {
  const f = mockFetch([
    (u) => u.endsWith('/v1/billing/teams/team-123/prepaid/balance') && ok({ changes: [], total: { val: '-4550' } }),
    (u) => u.endsWith('/v1/billing/teams/team-123/postpaid/invoice/preview') && ok({ coreInvoice: { amountAfterVat: '1234' }, effectiveSpendingLimit: '20000' }),
  ])
  const p = providerById('xai')
  const r = await p.query({ balanceXaiKey: KEY, balanceXaiTeamId: 'team-123', balanceXaiInvoice: true }, opts(f))
  assert.equal(byLabel(r, '预付费余额').value, 45.5)
  assert.equal(byLabel(r, '预付费余额').currency, 'USD')
  assert.equal(byLabel(r, '本月后付费（预览）').value, 12.34)
  assert.equal(byLabel(r, '后付费额度上限').value, 200)
  assert.ok(f.calls.every((c) => c.url.startsWith('https://management-api.x.ai/')))
  await assert.rejects(p.query({ balanceXaiKey: KEY, balanceXaiTeamId: '../x' }, opts(f)), /团队 ID/)
})

test('OpenRouter：普通密钥（/credits 403）只显示该密钥额度；管理密钥显示账户余额', async () => {
  const keyInfo = { data: { limit: 20, limit_remaining: 12.5, usage: 7.5, usage_monthly: 3.25 } }
  const normal = mockFetch([
    (u) => u.endsWith('/api/v1/credits') && { status: 403, body: { error: { code: 403, message: 'Only management keys can perform this operation' } } },
    (u) => u.endsWith('/api/v1/key') && ok(keyInfo),
  ])
  const r1 = await providerById('openrouter').query({ balanceOpenrouterKey: KEY }, opts(normal))
  assert.deepEqual(byLabel(r1, '此密钥剩余额度'), { label: '此密钥剩余额度', value: 12.5, currency: 'USD', type: 'balance' })
  assert.equal(byLabel(r1, '此密钥本月用量').type, 'spend')
  const mgmt = mockFetch([
    (u) => u.endsWith('/api/v1/credits') && ok({ data: { total_credits: 100.5, total_usage: 25.75 } }),
    (u) => u.endsWith('/api/v1/key') && { status: 401, body: { error: { message: 'bad' } } },
  ])
  const r2 = await providerById('openrouter').query({ balanceOpenrouterKey: KEY }, opts(mgmt))
  assert.equal(byLabel(r2, '账户余额').value, 74.75)
  assert.equal(byLabel(r2, '账户余额').type, 'balance')
})

test('Moonshot / 硅基流动：站点决定主机与币种', async () => {
  const f = mockFetch([
    (u) => u === 'https://api.moonshot.ai/v1/users/me/balance' && ok({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, status: true }),
    (u) => u === 'https://api.moonshot.cn/v1/users/me/balance' && ok({ code: 0, data: { available_balance: 1, voucher_balance: 0, cash_balance: 1 }, status: true }),
    (u) => u === 'https://api.siliconflow.cn/v1/user/info' && ok({ code: 20000, data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } }),
  ])
  const a = await providerById('moonshot').query({ balanceMoonshotKey: KEY, balanceMoonshotRegion: 'ai' }, opts(f))
  assert.deepEqual(byLabel(a, '可用余额'), { label: '可用余额', value: 49.5889, currency: 'USD', type: 'balance' })
  const c = await providerById('moonshot').query({ balanceMoonshotKey: KEY, balanceMoonshotRegion: 'cn' }, opts(f))
  assert.equal(byLabel(c, '可用余额').currency, 'CNY')
  const s = await providerById('siliconflow').query({ balanceSiliconflowKey: KEY, balanceSiliconflowRegion: 'cn' }, opts(f))
  assert.deepEqual(byLabel(s, '总余额'), { label: '总余额', value: 88.88, currency: 'CNY', type: 'balance' })
})

test('OpenAI Costs：按页累计 amount.value，标为已用金额', async () => {
  const f = mockFetch([
    (u) => u.startsWith('https://api.openai.com/v1/organization/costs?') && !u.includes('page=') && ok({ data: [{ results: [{ amount: { value: 1.5, currency: 'usd' } }] }, { results: [{ amount: { value: 2.25, currency: 'usd' } }] }], has_more: true, next_page: 'p2' }),
    (u) => u.includes('page=p2') && ok({ data: [{ results: [{ amount: { value: 0.25, currency: 'usd' } }] }], has_more: false }),
  ])
  const r = await providerById('openai').query({ balanceOpenaiKey: KEY, balanceOpenaiRange: 'month' }, opts(f))
  assert.deepEqual(r.items, [{ label: '本月已用金额（UTC）', value: 4, currency: 'USD', type: 'spend' }])
  const q = new URL(f.calls[0].url).searchParams
  assert.equal(q.get('start_time'), String(Date.UTC(2026, 9, 1) / 1000))
})

test('Anthropic Cost Report：amount 为美分十进制字符串 → 美元；分页', async () => {
  const f = mockFetch([
    (u) => u.startsWith('https://api.anthropic.com/v1/organizations/cost_report?') && !u.includes('page=') && ok({ data: [{ results: [{ amount: '123.45', currency: 'USD' }, { amount: '76.55', currency: 'USD' }] }], has_more: true, next_page: 'n2' }),
    (u) => u.includes('page=n2') && ok({ data: [{ results: [{ amount: '50', currency: 'USD' }] }], has_more: false, next_page: null }),
  ])
  const r = await providerById('anthropic').query({ balanceAnthropicKey: KEY, balanceAnthropicRange: '30d' }, opts(f))
  assert.deepEqual(r.items, [{ label: '近 30 天已用金额', value: 2.5, currency: 'USD', type: 'spend' }])
  assert.equal(f.calls[0].headers['x-api-key'], KEY)
  assert.equal(f.calls[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(new URL(f.calls[0].url).searchParams.get('starting_at'), '2026-09-16T00:00:00.000Z')
})

test('阿里云签名与官方示例一致；QueryAccountBalance 解析', async () => {
  // 阿里云文档的签名示例（testid / testsecret，DescribeRegions）。
  const qs = aliyunSignedQuery({ accessKeyId: 'testid', accessKeySecret: 'testsecret', action: 'DescribeRegions', version: '2014-05-26', timestamp: '2016-02-23T12:46:24Z', nonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf', extra: { Format: 'XML' } })
  assert.equal(new URLSearchParams(qs).get('Signature'), 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=')
  const f = mockFetch([(u) => u.startsWith('https://business.aliyuncs.com/?') && ok({ Code: '200', Success: true, Data: { AvailableAmount: '10,000.00', AvailableCashAmount: '9000.00', CreditAmount: '0.00', Currency: 'CNY' } })])
  const r = await providerById('aliyun').query({ balanceAliyunKeyId: 'LTAIexampleid', balanceAliyunKeySecret: 'secretvalue123', balanceAliyunRegion: 'cn' }, opts(f))
  assert.deepEqual(byLabel(r, '可用额度'), { label: '可用额度', value: 10000, currency: 'CNY', type: 'balance' })
  assert.ok(!f.calls[0].url.includes('secretvalue123'))
  const bad = mockFetch([() => ({ status: 400, body: { Code: 'NoPermission', Message: 'You are not authorized LTAIexampleid' } })])
  await assert.rejects(providerById('aliyun').query({ balanceAliyunKeyId: 'LTAIexampleid', balanceAliyunKeySecret: 'secretvalue123' }, opts(bad)), (e) => !String(e.message).includes('LTAIexampleid') && /400/.test(e.message))
})

test('错误打码：服务端回显的密钥不会出现在错误中', async () => {
  const f = mockFetch([() => ({ status: 401, body: { error: { message: 'Incorrect API key provided: ' + KEY } } })])
  await assert.rejects(providerById('deepseek').query({ balanceDeepseekKey: KEY }, opts(f)), (e) => e instanceof BalanceError && e.status === 401 && !e.message.includes(KEY) && /401/.test(e.message))
  assert.ok(!redactText('Bearer ' + KEY, []).includes(KEY))
  assert.equal(toNumber('1,234.5'), 1234.5)
  assert.equal(toNumber('abc'), null)
  const r = spendRange('month', NOW())
  assert.equal(r.start.toISOString(), '2026-10-01T00:00:00.000Z')
})

function makeFeature(cfg, fetchImpl, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'balance-test-'))
  const feature = createBalanceFeature({ logger: { warn() {} } }, () => cfg.value, { fetchImpl, now: NOW, storeFile: join(dir, 'extra.json'), extensionPaths: extra.extensionPaths || [join(dir, 'none.mjs')] })
  return { feature, dir }
}

test('功能：60 秒缓存、强制刷新、状态不含密钥、低余额标记', async () => {
  const f = mockFetch([(u) => u.endsWith('/user/balance') && ok({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3.00', granted_balance: '0', topped_up_balance: '3.00' }] })])
  const cfg = { value: { balanceEnabled: true, balanceAiTool: false, balanceLowThreshold: 5, balanceDeepseekEnabled: true, balanceDeepseekKey: KEY } }
  const { feature, dir } = makeFeature(cfg, f)
  try {
    await feature.refresh()
    await feature.refresh()
    assert.equal(f.calls.length, 1)
    await feature.refresh(null, { force: true })
    assert.equal(f.calls.length, 2)
    const v = await feature.view()
    assert.ok(!JSON.stringify(v).includes(KEY))
    const ds = v.providers.find((p) => p.id === 'deepseek')
    assert.equal(ds.configured, true)
    assert.equal(ds.fields[0].configured, true)
    assert.equal(ds.result.low, true)
    assert.equal(v.extra, null)
    assert.ok(v.unsupported.some((u) => u.id === 'gemini' && /aistudio\.google\.com\/billing/.test(u.console)))
  } finally { await feature.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('设置接口：拒绝跨站；掩码保持密钥，空字符串清除；未知键忽略', async () => {
  const cfg = { value: { balanceEnabled: true, balanceAiTool: false, balanceMoonshotKey: KEY, balanceMoonshotRegion: 'cn' } }
  const { feature, dir } = makeFeature(cfg, mockFetch([]))
  const MASK = '__mask__'
  const sent = []
  const sendJson = (_res, status, body) => { sent.push({ status, body }); return true }
  const call = (sub, body, headers = {}) => handleBalanceApi({ method: 'POST', headers }, {}, sub, { sendJson, readBody: async () => JSON.stringify(body), feature, applyPatch: async (p) => { cfg.value = { ...cfg.value, ...p } }, secretMask: MASK })
  try {
    await call('/balance/config', { provider: 'moonshot', enabled: true }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(sent.at(-1).status, 403)
    await call('/balance/config', { provider: 'moonshot', enabled: true, values: { balanceMoonshotKey: MASK, balanceMoonshotRegion: 'ai', balanceDeepseekKey: 'x', bogus: 1 } })
    assert.equal(cfg.value.balanceMoonshotKey, KEY)
    assert.equal(cfg.value.balanceMoonshotRegion, 'ai')
    assert.equal(cfg.value.balanceMoonshotEnabled, true)
    assert.equal(cfg.value.balanceDeepseekKey, undefined)
    assert.ok(!JSON.stringify(sent.at(-1).body).includes(KEY))
    await call('/balance/config', { provider: 'moonshot', values: { balanceMoonshotRegion: 'zz' } })
    assert.equal(cfg.value.balanceMoonshotRegion, 'ai')
    await call('/balance/config', { provider: 'moonshot', values: { balanceMoonshotKey: '' } })
    assert.equal(cfg.value.balanceMoonshotKey, '')
    await call('/balance/extra', { entries: [] })
    assert.equal(sent.at(-1).status, 404)
  } finally { await feature.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('附加条目扩展：存在时加载；掩码保留密钥；数据文件之外不返回密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-ext-'))
  const extFile = join(dir, 'ext.mjs')
  writeFileSync(extFile, `export function describe(){return{title:'示例分组',note:'说明',example:{name:'示例',baseUrl:'https://example.test'}}}
export async function query(e,o){const r=await o.fetchImpl(e.baseUrl+'/q',{headers:{authorization:'Bearer '+e.apiKey}});const j=JSON.parse(await r.text());return{items:[{label:'余额',value:j.v,currency:'USD',type:'balance'}]}}`)
  const f = mockFetch([(u) => u === 'https://example.test/q' && ok({ v: 7 })])
  const cfg = { value: { balanceEnabled: true, balanceAiTool: false } }
  const feature = createBalanceFeature({}, () => cfg.value, { fetchImpl: f, now: NOW, storeFile: join(dir, 'extra.json'), extensionPaths: [join(dir, 'missing.mjs'), extFile] })
  try {
    await feature.saveExtra([{ name: '示例', baseUrl: 'https://example.test/', enabled: true, apiKey: KEY }], '__mask__')
    let v = await feature.view()
    assert.equal(v.extra.title, '示例分组')
    assert.equal(v.extra.entries.length, 1)
    assert.equal(v.extra.entries[0].configured, true)
    assert.equal(v.extra.entries[0].baseUrl, 'https://example.test')
    const id = v.extra.entries[0].id
    await feature.saveExtra([{ id, name: '示例 2', baseUrl: 'https://example.test', enabled: true, apiKey: '__mask__' }], '__mask__')
    assert.equal(JSON.parse(readFileSync(join(dir, 'extra.json'), 'utf8')).entries[0].apiKey, KEY)
    const results = await feature.refresh()
    assert.equal(results[0].ok, true)
    assert.equal(results[0].items[0].value, 7)
    v = await feature.view()
    assert.ok(!JSON.stringify(v).includes(KEY))
    assert.throws(() => mergeExtraEntries([], [{ name: 'a', baseUrl: 'ftp://x' }], {}), /http/)
    assert.throws(() => mergeExtraEntries([], [{ name: '', baseUrl: 'https://x' }], {}), /名称/)
  } finally { await feature.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('工具 balance_query：结果符合输出 schema、只含金额；筛选；不在 Telegram 开放工具中', async () => {
  const f = mockFetch([
    (u) => u.endsWith('/user/balance') && ok({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5.5', granted_balance: '0', topped_up_balance: '5.5' }] }),
    (u) => u.endsWith('/v1/user/info') && { status: 401, body: { message: 'invalid ' + KEY } },
  ])
  const cfg = { value: { balanceEnabled: true, balanceDeepseekEnabled: true, balanceDeepseekKey: KEY, balanceSiliconflowEnabled: true, balanceSiliconflowKey: KEY } }
  const { feature, dir } = makeFeature(cfg, f)
  try {
    const [tool] = createBalanceTools({ query: feature.query })
    assert.equal(tool.name, 'balance_query')
    const all = await tool.execute({}, {})
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, all, ''), [])
    assert.equal(all.results.length, 2)
    assert.ok(!JSON.stringify(all).includes(KEY))
    assert.equal(all.results.find((r) => r.provider === 'siliconflow').ok, false)
    const one = await tool.execute({ provider: 'DeepSeek' }, {})
    assert.equal(one.results.length, 1)
    assert.equal(one.results[0].items[0].value, 5.5)
    await assert.rejects(tool.execute({ provider: 'nope' }, {}), /没有已启用/)
    assert.ok(Array.isArray(tool.output.render({}, all)))
    assert.equal(isOpenTool('balance_query'), false)
  } finally { await feature.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

test('设置 schema：每个服务商单独的密钥均为 secret；默认关闭', async () => {
  const roles = {}
  const z = new Proxy({}, { get: (_t, kind) => () => { const s = { kind, meta: {}, role(r) { s.meta.role = r; return s }, default(d) { s.def = d; return s }, description() { return s } }; return s } })
  const shape = balanceSchemaShape(z)
  for (const k of BALANCE_KEYS) assert.ok(shape[k], k)
  for (const p of PROVIDERS) {
    assert.equal(shape[p.enabledKey].def, false)
    for (const fd of p.fields) if (fd.type === 'secret') { roles[fd.key] = shape[fd.key].meta.role }
  }
  assert.ok(Object.values(roles).length >= 9)
  assert.ok(Object.values(roles).every((r) => r === 'secret'))
  assert.equal(shape.balanceEnabled.def, false)
  assert.deepEqual(balanceSettings({}), { enabled: false, toolEnabled: true, autoRefreshMin: 0, lowThreshold: 0 })
  assert.equal(isLow({ ok: true, items: [{ type: 'spend', value: 1 }] }, 5), false)
})
