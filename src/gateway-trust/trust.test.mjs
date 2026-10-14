// 网关核验：采集器、五项判定、回合合并、开关 / API、llm/stream 只读包装、缺少 llm-gateway-bench 时的降级（node:test）。
// 判定用一个与 llm-gateway-bench probe/metrics.mjs 同签名的桩；设置 LLM_GATEWAY_BENCH 指向真实仓库时另跑一遍。
// 运行时只认 <数据目录>/tools/llm-gateway-bench（设置页下载的副本），不读设置项或同级目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCallRecorder, evaluateCall, mergeTurn, STATUS } from './evaluate.mjs'
import { loadBench } from './bench.mjs'
import { managedBenchDir } from './install.mjs'
import { createGatewayTrust } from './index.mjs'

// 隔离数据目录：默认的 llm-gateway-bench 托管位置在 <数据目录>/tools 下，不能读到本机真实安装。
if (!process.env.DSH_WORKBENCH_DATA_DIR) process.env.DSH_WORKBENCH_DATA_DIR = mkdtempSync(join(tmpdir(), 'dsw-trust-data-'))

const stub = {
  summarize: () => ({}),
  isBurstStream({ chunks, ttftMs, streamWindowMs }) {
    if (typeof chunks !== 'number' || chunks < 5) return null
    return streamWindowMs <= 250 && ttftMs >= 800 && ttftMs >= 4 * Math.max(streamWindowMs, 1)
  },
  evalModelEcho(reported, requested) {
    if (!reported) return null
    const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
    const a = n(reported), b = n(requested)
    return a.includes(b) || b.includes(a) ? { ok: true, reported } : { ok: false, reported }
  },
  evalCjkIntegrity(s) {
    if ((s.match(/\ufffd/g) || []).length) return { ok: false, reason: 'contains 1 replacement char(s)' }
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
    return cjk < 2 ? { ok: false, reason: 'almost no Chinese characters in response' } : { ok: true, cjkChars: cjk }
  },
  extractCachedTokens: (u) => (typeof u?.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : null),
  evalCache({ cachedSecond, promptTokens }) {
    if (typeof cachedSecond !== 'number') return { reported: false, supported: null, cachedTokens: null, cachedFrac: null }
    return { reported: true, supported: cachedSecond > 0, cachedTokens: cachedSecond, cachedFrac: promptTokens ? Math.round(cachedSecond / promptTokens * 100) / 100 : null }
  },
}

function clock(times) { let i = 0; return () => times[Math.min(i++, times.length - 1)] }

function run(chunks, { model = 'deepseek-v4-flash', times } = {}) {
  const r = createCallRecorder({ provider: 'p', model, now: clock(times) })
  for (const c of chunks) r.onChunk(c)
  return r.end()
}

const zh = '这是一个用于测试的中文回答，内容完整，没有乱码。'.repeat(4)
function deltas(n, text = zh) {
  const per = Math.ceil(text.length / n)
  return Array.from({ length: n }, (_, i) => ({ type: 'text-delta', index: 0, text: text.slice(i * per, (i + 1) * per) }))
}
const finish = (responseModel) => ({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { model: 'x', ...(responseModel ? { responseModel } : {}) } } })

test('genuine stream passes every row it can judge', () => {
  const ch = [...deltas(10), { type: 'usage', usage: { inputTokens: 1000, outputTokens: 70, totalTokens: 1600, cacheReadTokens: 500 } }, finish('deepseek-v4-flash-0528')]
  const times = [0, ...ch.map((_, i) => 300 + i * 120), 2000]
  const out = evaluateCall(run(ch, { times }), stub, { priorMaxPrompt: 1200 })
  assert.equal(out.rows.model.status, STATUS.PASS)
  assert.equal(out.rows.stream.status, STATUS.PASS)
  assert.equal(out.rows.tokens.status, STATUS.PASS)
  assert.equal(out.rows.cjk.status, STATUS.PASS)
  assert.equal(out.rows.cache.status, STATUS.PASS)
  assert.equal(out.overall, STATUS.PASS)
})

test('burst stream, model swap, inflated tokens, U+FFFD, impossible cache are flagged', () => {
  const ch = [...deltas(10, zh + '\ufffd'), { type: 'usage', usage: { inputTokens: 100, outputTokens: 2000, totalTokens: 9000, cacheReadTokens: 8000 } }, finish('gpt-4o-mini')]
  const times = [0, ...ch.map((_, i) => 3000 + i * 5), 3100]
  const out = evaluateCall(run(ch, { times }), stub, { priorMaxPrompt: 1000 })
  for (const k of ['model', 'stream', 'tokens', 'cjk', 'cache']) assert.equal(out.rows[k].status, STATUS.WARN, k)
  assert.equal(out.overall, STATUS.WARN)
})

test('missing data yields 无数据 rows', () => {
  const out = evaluateCall(run([{ type: 'text-delta', index: 0, text: 'ok' }, finish()], { times: [0, 10, 20] }), stub)
  assert.equal(out.rows.model.status, STATUS.NONE)
  assert.equal(out.rows.stream.status, STATUS.NONE)
  assert.equal(out.rows.tokens.status, STATUS.NONE)
  assert.equal(out.rows.cjk.status, STATUS.NONE)
  assert.equal(out.rows.cache.status, STATUS.NONE)
  assert.equal(out.overall, STATUS.NONE)
})

test('mojibake fragments are flagged even without U+FFFD', () => {
  const out = evaluateCall(run([...deltas(6, zh + '锟斤拷'), finish('deepseek-v4-flash')], { times: [0, 100, 200, 300, 400, 500, 600, 700, 800] }), stub)
  assert.equal(out.rows.cjk.status, STATUS.WARN)
})

test('mergeTurn keeps the worst row per key', () => {
  const a = { rows: { model: { status: 'pass' }, stream: { status: 'none' } } }
  const b = { rows: { model: { status: 'warn', value: 'x' }, stream: { status: 'pass' } } }
  const m = mergeTurn([a, b])
  assert.equal(m.rows.model.status, 'warn')
  assert.equal(m.rows.stream.status, 'pass')
  assert.equal(m.rows.cache.status, 'none')
  assert.equal(m.overall, 'warn')
  assert.equal(m.calls, 2)
})

function tmp() { return mkdtempSync(join(tmpdir(), 'dsw-trust-')) }

function fakeBenchDir(d = tmp()) {
  mkdirSync(join(d, 'probe'), { recursive: true })
  const src = Object.entries(stub).map(([k, f]) => `export const ${k} = ${f.toString().replace(/^(\w+)\(/, 'function (')}`).join('\n')
  writeFileSync(join(d, 'probe', 'metrics.mjs'), src)
  return d
}

/** 插件数据目录：bench=true 时在 tools/llm-gateway-bench 放一份桩。 */
function fakeBase(bench = true) {
  const base = tmp()
  if (bench) fakeBenchDir(managedBenchDir(base))
  return base
}

test('loadBench：只读托管目录；未下载 → installed=false；缺导出 → installed=true 但不可用', async () => {
  const none = await loadBench(join(tmp(), 'nope'))
  assert.equal(none.ok, false); assert.equal(none.installed, false)
  assert.match(none.reason, /未下载 llm-gateway-bench/)
  assert.equal((await loadBench('')).installed, false)
  const got = await loadBench(fakeBenchDir())
  assert.equal(got.ok, true); assert.equal(got.installed, true)
  const d = tmp(); mkdirSync(join(d, 'probe')); writeFileSync(join(d, 'probe', 'metrics.mjs'), 'export const x = 1')
  const partial = await loadBench(d)
  assert.equal(partial.ok, false); assert.equal(partial.installed, true)
  assert.match(partial.reason, /缺少导出/)
})

test('运行中下载完成后无需重启：同一实例的 /trust/state 由 installed=false 变为可用', async () => {
  const base = fakeBase(false)
  const trust = createGatewayTrust({ on() {} }, () => ({}), { base })
  let res = fakeRes()
  await trust.handleApi(req('GET', '/x?sessionId=s9'), res, '/trust/state', { sendJson, readBody })
  assert.equal(res.body.installed, false); assert.equal(res.body.available, false)
  fakeBenchDir(managedBenchDir(base))
  res = fakeRes()
  await trust.handleApi(req('GET', '/x?sessionId=s9'), res, '/trust/state', { sendJson, readBody })
  assert.equal(res.body.installed, true); assert.equal(res.body.available, true)
  res = fakeRes()
  await trust.handleApi(req('POST', '/x', { sessionId: 's9', enabled: true }), res, '/trust/toggle', { sendJson, readBody })
  assert.equal(res.status, 200); assert.equal(res.body.enabled, true)
  trust.dispose()
})

test('设置项 gatewayBenchPath 已移除：即使配置里残留旧值也不读取', async () => {
  const base = fakeBase(false)
  const trust = createGatewayTrust({ on() {} }, () => ({ gatewayBenchPath: fakeBenchDir() }), { base })
  const res = fakeRes()
  await trust.handleApi(req('GET', '/x?sessionId=s8'), res, '/trust/state', { sendJson, readBody })
  assert.equal(res.body.installed, false); assert.equal(res.body.available, false)
  trust.dispose()
})

function fakeRes() {
  return { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
}
const sendJson = (res, status, body) => { res.status = status; res.body = body }
function req(method, url, body) { return { method, url, headers: {}, body } }
const readBody = async (r) => r.body ? JSON.stringify(r.body) : ''

test('toggle + llm/stream wrapper records per-turn results without altering chunks', async () => {
  const base = fakeBase()
  const dir = tmp()
  let listener = null
  const agents = new Map([['s1', { phase: { kind: 'running', turn: 3 } }]])
  const ctx = { on(name, fn) { if (name === 'llm/stream') listener = fn; return () => { listener = null } }, get: (n) => (n === 'agents' ? agents : undefined), logger: {} }
  let t = 0
  const trust = createGatewayTrust(ctx, () => ({}), { base, dir, now: () => (t += 50) })
  const off = trust.install()
  assert.equal(typeof listener, 'function')

  let res = fakeRes()
  await trust.handleApi(req('GET', '/x?sessionId=s1'), res, '/trust/state', { sendJson, readBody })
  assert.equal(res.body.installed, true); assert.equal(res.body.available, true); assert.equal(res.body.enabled, false)

  // 未开启：直接透传 next()
  const sentinel = {}
  assert.equal(listener({ sessionId: 's1' }, () => sentinel), sentinel)

  res = fakeRes()
  await trust.handleApi(req('POST', '/x', { sessionId: 's1', enabled: true }), res, '/trust/toggle', { sendJson, readBody })
  assert.equal(res.body.enabled, true)

  const chunks = [...deltas(8), { type: 'usage', usage: { inputTokens: 10, outputTokens: 60, totalTokens: 70 } }, finish('deepseek-v4-flash')]
  async function* source() { for (const c of chunks) yield c }
  const seen = []
  for await (const c of listener({ sessionId: 's1', provider: 'p', model: 'deepseek-v4-flash' }, () => source())) seen.push(c)
  assert.deepEqual(seen, chunks)

  res = fakeRes()
  await trust.handleApi(req('GET', '/x?sessionId=s1'), res, '/trust/turns', { sendJson, readBody })
  assert.ok(res.body.turns['3'], 'turn 3 recorded')
  assert.equal(res.body.turns['3'].rows.model.status, 'pass')
  assert.deepEqual(res.body.turns['3'].models, ['deepseek-v4-flash'])

  await trust.flush()
  assert.ok(existsSync(join(dir, 'sessions', 's1.json')))
  assert.ok(existsSync(join(dir, 'state.json')))
  // 重新创建：开关与结果都从磁盘恢复
  const again = createGatewayTrust({ ...ctx, on() {} }, () => ({}), { base, dir })
  assert.equal(again.isEnabled('s1'), true)
  res = fakeRes()
  await again.handleApi(req('GET', '/x?sessionId=s1'), res, '/trust/turns', { sendJson, readBody })
  assert.ok(res.body.turns['3'])
  off()
  trust.dispose(); again.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('toggle refuses when llm-gateway-bench is absent', async () => {
  const trust = createGatewayTrust({ on() {} }, () => ({}), { base: fakeBase(false), dir: tmp() })
  const res = fakeRes()
  await trust.handleApi(req('POST', '/x', { sessionId: 's2', enabled: true }), res, '/trust/toggle', { sendJson, readBody })
  assert.equal(res.status, 409)
  assert.match(res.body.error, /未下载 llm-gateway-bench/)
})

const realDir = process.env.LLM_GATEWAY_BENCH || ''
test('real llm-gateway-bench (when present) agrees with the stub on clear cases', { skip: !existsSync(join(realDir, 'probe', 'metrics.mjs')) }, async () => {
  const mod = await import(pathToFileURL(join(realDir, 'probe', 'metrics.mjs')).href)
  const good = [...deltas(10), { type: 'usage', usage: { inputTokens: 1000, outputTokens: 70, totalTokens: 1600, cacheReadTokens: 500 } }, finish('deepseek-v4-flash')]
  const g = evaluateCall(run(good, { times: [0, ...good.map((_, i) => 300 + i * 120), 2000] }), mod, { priorMaxPrompt: 1200 })
  assert.equal(g.overall, 'pass')
  const bad = [...deltas(10, zh + '\ufffd'), { type: 'usage', usage: { inputTokens: 1, outputTokens: 2000, totalTokens: 2001 } }, finish('gpt-4o')]
  const b = evaluateCall(run(bad, { times: [0, ...bad.map((_, i) => 3000 + i * 5), 3100] }), mod)
  for (const k of ['model', 'stream', 'tokens', 'cjk']) assert.equal(b.rows[k].status, 'warn', k)
})

// ── llm-gateway-bench 设置页下载安装（托管目录 <数据目录>/tools/llm-gateway-bench） ──
test('installBench：下载钉死提交的源码包、校验导出、移入 tools/llm-gateway-bench 并写标记', async () => {
  const { installBench, benchInstallStatus, BENCH_COMMIT, benchTarballUrl, _resetBenchJob } = await import('./install.mjs')
  _resetBenchJob()
  const base = mkdtempSync(join(tmpdir(), 'dsw-bench-'))
  try {
    assert.equal(benchInstallStatus(base).installed, false)
    let gotUrl = null
    const downloadImpl = async (url, dest) => { gotUrl = url; mkdirSync(join(dest, '..'), { recursive: true }); writeFileSync(dest, 'x') }
    const extractImpl = async (_archive, stage) => {
      const root = join(stage, 'llm-gateway-bench-' + BENCH_COMMIT)
      mkdirSync(join(root, 'probe'), { recursive: true })
      writeFileSync(join(root, 'LICENSE'), 'MIT')
      writeFileSync(join(root, 'probe', 'metrics.mjs'), ['isBurstStream', 'evalModelEcho', 'evalCjkIntegrity', 'extractCachedTokens', 'evalCache', 'summarize'].map((n) => `export function ${n}() { return null }`).join('\n'))
    }
    const info = await installBench({ base, downloadImpl, extractImpl })
    assert.equal(gotUrl, benchTarballUrl())
    assert.equal(info.commit, BENCH_COMMIT)
    const st = benchInstallStatus(base)
    assert.equal(st.installed, true)
    assert.equal(st.installedCommit, BENCH_COMMIT)
    assert.equal(st.dir, managedBenchDir(base))
    assert.ok(existsSync(join(managedBenchDir(base), 'probe', 'metrics.mjs')))
    const got = await loadBench(managedBenchDir(base))
    assert.equal(got.ok, true)
    // 缺少导出时拒绝安装，且不覆盖已有目录
    const bad = async (_a, stage) => { mkdirSync(join(stage, 'r', 'probe'), { recursive: true }); writeFileSync(join(stage, 'r', 'probe', 'metrics.mjs'), 'export const x = 1') }
    await assert.rejects(installBench({ base, downloadImpl, extractImpl: bad }), /缺少导出/)
    assert.ok(existsSync(join(managedBenchDir(base), 'probe', 'metrics.mjs')))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('API：/trust/bench 返回未安装 / 已安装状态，/trust/bench/install 启动下载任务', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsw-bench-api-'))
  try {
    let started = null
    const g = createGatewayTrust({}, () => ({}), { base, importImpl: (u) => import(u), installImpl: (opts) => { started = opts; return Promise.resolve({}) } })
    const out = []
    const sendJson = (_res, code, body) => { out.push([code, body]); return true }
    await g.handleApi({ url: '/trust/bench', method: 'GET', headers: {} }, {}, '/trust/bench', { sendJson })
    assert.equal(out[0][0], 200)
    assert.equal(out[0][1].installed, false)
    assert.equal(out[0][1].relDir, 'tools/llm-gateway-bench')
    assert.equal(out[0][1].active.available, false)
    assert.equal(out[0][1].active.installed, false)
    assert.equal('override' in out[0][1], false)
    await g.handleApi({ url: '/trust/bench/install', method: 'POST', headers: {} }, {}, '/trust/bench/install', { sendJson })
    assert.equal(out[1][0], 200)
    assert.equal(started.base, base)
    await g.handleApi({ url: '/trust/bench/install', method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }, {}, '/trust/bench/install', { sendJson })
    assert.equal(out[2][0], 403)
  } finally { rmSync(base, { recursive: true, force: true }) }
})