import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { handleSessionApi } from './index.mjs'
import {
  createSamplingStore,
  finalMessagesBody,
  mergeDeepSeekExtensions,
  mountSamplingExtensions,
  normalizeSamplingValue,
  prepareField,
  isDeepSeekModel,
} from './sampling.mjs'

const root = resolve(import.meta.dirname, '..', '..')

function storeAt(name = 'sampling-overrides.json') {
  const dir = mkdtempSync(join(tmpdir(), 'dsw-sampling-'))
  const file = join(dir, name)
  const store = createSamplingStore({ file })
  store.load()
  return { dir, file, store }
}

function ordinary(sessionId, body, extra = {}) {
  return { sessionId, body, signal: new AbortController().signal, ...extra }
}

function baseBody(extra = {}) {
  return {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...extra,
  }
}

test('both fields land on the messages body, blanks are omitted, and the base object stays put', () => {
  const { store } = storeAt()
  store.update('s-a', { temperature: 0, top_p: 1 })
  const body = baseBody()
  const snapshot = JSON.stringify(body)
  const merged = finalMessagesBody(body, ordinary('s-a', body), store)
  assert.deepEqual(merged.fields, { temperature: 0, top_p: 1 })
  assert.equal(merged.body.temperature, 0)
  assert.equal(merged.body.top_p, 1)
  assert.equal(merged.body.model, 'deepseek-v4-pro')
  assert.equal(JSON.stringify(body), snapshot)
  assert.equal(JSON.parse(merged.payload).top_p, 1)

  store.update('s-a', { temperature: null, top_p: null })
  const cleared = finalMessagesBody(baseBody(), ordinary('s-a', baseBody()), store)
  assert.deepEqual(cleared.fields, {})
  assert.equal('temperature' in cleared.body, false)
  assert.equal('top_p' in cleared.body, false)
})

test('an existing temperature is kept, including auto-review 0, and top_p is not added to review or other calls', () => {
  const { store } = storeAt()
  store.update('s-a', { temperature: 1.5, top_p: 0.2 })
  const chatBody = baseBody({ temperature: 0 })
  const chat = finalMessagesBody(chatBody, ordinary('s-a', chatBody), store)
  assert.equal(chat.body.temperature, 0)
  assert.equal(chat.body.top_p, 0.2)
  assert.equal(prepareField(store, ordinary('s-a', chatBody), 'temperature'), undefined)

  const reviewBody = baseBody({ temperature: 0 })
  const review = finalMessagesBody(reviewBody, { body: reviewBody, signal: new AbortController().signal }, store)
  assert.equal(review.body.temperature, 0)
  assert.equal('top_p' in review.body, false)

  const compact = finalMessagesBody(baseBody(), ordinary('s-a', baseBody(), { purpose: 'compaction' }), store)
  assert.deepEqual(compact.fields, {})
  const title = finalMessagesBody(baseBody(), ordinary('s-a', baseBody(), { purpose: 'session-title' }), store)
  assert.deepEqual(title.fields, {})

  const other = finalMessagesBody(baseBody(), ordinary('s-b', baseBody()), store)
  assert.deepEqual(other.fields, {})
  assert.equal(store.get('s-b').temperature, null)
  assert.equal(store.get('s-a').temperature, 1.5)
})

test('a colliding extension field fails the same way the host adapter does', () => {
  assert.throws(
    () => mergeDeepSeekExtensions({ temperature: 0 }, { temperature: 1 }),
    /collides with the base request/,
  )
})

test('values survive a new store, invalid file entries are dropped, and sessions do not share overrides', () => {
  const { file } = storeAt()
  const first = createSamplingStore({ file })
  first.load()
  first.update('s-a', { temperature: 0.4 })
  first.update('s-b', { top_p: 0.8 })
  first.update('s-a', { top_p: 0.3 })
  const second = createSamplingStore({ file })
  second.load()
  assert.deepEqual(second.get('s-a'), { temperature: 0.4, top_p: 0.3 })
  assert.deepEqual(second.get('s-b'), { temperature: null, top_p: 0.8 })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.sessions['s-a'].temperature, 0.4)

  saved.sessions['s-a'].temperature = 9
  saved.sessions['s-a'].top_p = 0
  saved.sessions['s-c'] = { temperature: '0.2', top_p: Number.POSITIVE_INFINITY }
  writeFileSync(file, JSON.stringify(saved))
  const third = createSamplingStore({ file })
  third.load()
  assert.deepEqual(third.get('s-a'), { temperature: null, top_p: null })
  assert.deepEqual(third.get('s-b'), { temperature: null, top_p: 0.8 })
  assert.equal(third.records()['s-c'], undefined)
})

test('illegal numbers are rejected and a failed write does not change the stored session', () => {
  const cases = [
    ['temperature', 2, 2],
    ['temperature', 0, 0],
    ['temperature', ' 1.25 ', 1.25],
    ['temperature', '', null],
    ['temperature', null, null],
    ['top_p', 1, 1],
    ['top_p', '0.5', 0.5],
    ['top_p', 0, null],
  ]
  for (const [kind, raw, expected] of cases) {
    if (expected === null && (raw === '' || raw === null)) {
      assert.equal(normalizeSamplingValue(kind, raw), null)
    } else if (kind === 'top_p' && raw === 0) {
      assert.throws(() => normalizeSamplingValue(kind, raw), /top_p/)
    } else {
      assert.equal(normalizeSamplingValue(kind, raw), expected)
    }
  }
  for (const raw of [-0.1, 2.1, Number.NaN, Number.POSITIVE_INFINITY, '1e-1', 'abc', true, {}, []]) {
    assert.throws(() => normalizeSamplingValue('temperature', raw), /temperature/)
  }
  for (const raw of [0, -0.1, 1.1, Number.NaN, '0', false]) {
    assert.throws(() => normalizeSamplingValue('top_p', raw), /top_p/)
  }

  const { file, store } = storeAt()
  store.update('s-a', { temperature: 0.2, top_p: 0.4 })
  rmSync(file)
  mkdirSync(file)
  assert.throws(() => store.update('s-a', { temperature: 1 }), /采样参数保存失败/)
  assert.equal(store.get('s-a').temperature, 0.2)
  assert.equal(store.get('s-a').top_p, 0.4)
  assert.throws(() => store.update('s-a', { temperature: 3, top_p: 0.1 }), /temperature/)
  assert.equal(store.get('s-a').top_p, 0.4)
})

function capture() {
  const out = { status: 0, json: null, res: null }
  out.res = {
    writeHead(status) { out.status = status },
    end(text) { out.json = JSON.parse(text) },
  }
  return out
}

function jsonReq(method, url, body, headers = {}) {
  const payload = Buffer.from(body == null ? '' : body)
  const listeners = {}
  return {
    method,
    url,
    headers,
    on(ev, fn) {
      listeners[ev] = fn
      if (ev === 'end') {
        if (listeners.data) listeners.data(payload)
        fn()
      }
    },
  }
}

test('http save, empty session, illegal value, and reload stay on that session only', async () => {
  const { file, store } = storeAt()
  async function call(method, url, body, headers) {
    const out = capture()
    await handleSessionApi(null, {}, jsonReq(method, url, body, headers), out.res, '/session/sampling', {
      sendJson: (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)) },
      readBody: (req) => new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      }),
      getConfig: () => ({ sessionControlsEnabled: false }),
      sampling: store,
    })
    return out
  }

  const missing = await call('GET', '/dsh-workbench/api/session/sampling')
  assert.equal(missing.status, 409)
  assert.match(missing.json.error, /尚未创建/)

  const absent = await call('POST', '/dsh-workbench/api/session/sampling', '{}')
  assert.equal(absent.status, 409)

  const bad = await call('POST', '/dsh-workbench/api/session/sampling', JSON.stringify({
    sessionId: 's-a', temperature: 4, top_p: 0.5,
  }))
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /temperature/)
  assert.equal(store.get('s-a').top_p, null)

  const saved = await call('POST', '/dsh-workbench/api/session/sampling', JSON.stringify({
    sessionId: 's-a', temperature: 0.6, top_p: '',
  }))
  assert.equal(saved.status, 200)
  assert.equal(saved.json.saved, true)
  assert.equal(saved.json.temperature, 0.6)
  assert.equal(saved.json.top_p, null)
  assert.deepEqual(saved.json.appliesTo, ['deepseek-official', 'deepseek-account'])

  const other = await call('GET', '/dsh-workbench/api/session/sampling?sessionId=s-b')
  assert.deepEqual({ temperature: other.json.temperature, top_p: other.json.top_p }, { temperature: null, top_p: null })

  const again = createSamplingStore({ file })
  again.load()
  assert.equal(again.get('s-a').temperature, 0.6)

  const cleared = await call('POST', '/dsh-workbench/api/session/sampling', JSON.stringify({
    sessionId: 's-a', temperature: null, top_p: null,
  }))
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.temperature, null)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.sessions['s-a'], undefined)

  const cross = await call('POST', '/dsh-workbench/api/session/sampling', '{}', { 'sec-fetch-site': 'cross-site' })
  assert.equal(cross.status, 403)
})

test('extension registration is optional, session-scoped, and released with the plugin', async () => {
  const { store } = storeAt()
  store.update('s-a', { temperature: 0.1, top_p: 0.9 })
  assert.doesNotThrow(() => mountSamplingExtensions({}, store))
  assert.doesNotThrow(() => mountSamplingExtensions({ inject() { throw new Error('service missing') }, logger: { warn() {} } }, store))

  const providers = new Map()
  const ext = {
    register(field, provider) {
      if (providers.has(field)) throw new Error(`already ${field}`)
      providers.set(field, provider)
      return () => providers.delete(field)
    },
  }
  let queued = null
  const dispose = mountSamplingExtensions({
    inject(names, callback) {
      assert.deepEqual(names, ['deepseekLlmApiExtensions'])
      queued = callback
    },
  }, store)
  const release = queued({ deepseekLlmApiExtensions: ext })
  assert.equal(providers.size, 2)
  const request = ordinary('s-a', baseBody())
  const fields = {}
  for (const [field, provider] of providers) {
    const prepared = await provider.prepare(request)
    if (prepared) fields[field] = prepared.value
  }
  const merged = mergeDeepSeekExtensions(request.body, fields)
  assert.equal(merged.body.temperature, 0.1)
  assert.equal(merged.body.top_p, 0.9)
  const review = { body: baseBody({ temperature: 0 }) }
  assert.equal(await providers.get('temperature').prepare(review), undefined)
  assert.equal(await providers.get('top_p').prepare(review), undefined)
  dispose()
  assert.equal(providers.size, 0)
  release()
  assert.equal(providers.size, 0)

  const late = new Map()
  const lateExt = {
    register(field, provider) {
      late.set(field, provider)
      return () => late.delete(field)
    },
  }
  let lateCallback = null
  const stop = mountSamplingExtensions({
    inject(_names, callback) { lateCallback = callback },
  }, store)
  stop()
  lateCallback({ deepseekLlmApiExtensions: lateExt })
  assert.equal(late.size, 0)
})

function clientHelpers() {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const start = src.indexOf('// <sampling-helpers>')
  const end = src.indexOf('// </sampling-helpers>')
  assert.ok(start >= 0 && end > start)
  const ctx = {}
  vm.runInNewContext(`${src.slice(start, end)}
this.api = { samplingParseInput, samplingScopeMessage, samplingPendingMessage, samplingSliderSpec, samplingIsDeepSeekModel, samplingExample, SAMPLING_APPLIES_TO };`, ctx)
  return ctx.api
}

test('client validation matches the server and names unsupported providers', () => {
  const api = clientHelpers()
  assert.deepEqual([...api.SAMPLING_APPLIES_TO], ['deepseek-official', 'deepseek-account'])
  assert.match(api.samplingPendingMessage(), /尚未创建/)
  const samples = [
    ['temperature', '', null],
    ['temperature', '0', 0],
    ['temperature', '2', 2],
    ['temperature', '1.5', 1.5],
    ['top_p', '1', 1],
    ['top_p', '0.25', 0.25],
  ]
  for (const [kind, raw, expected] of samples) {
    const parsed = api.samplingParseInput(kind, raw)
    assert.equal(parsed.ok, true, raw)
    assert.equal(parsed.value, expected)
    assert.equal(normalizeSamplingValue(kind, raw), expected)
  }
  for (const raw of ['-1', '2.1', 'abc', '1e-1', '  ']) {
    const parsed = api.samplingParseInput('temperature', raw === '  ' ? '   ' : raw)
    if (raw.trim() === '') assert.equal(parsed.value, null)
    else {
      assert.equal(parsed.ok, false)
      assert.throws(() => normalizeSamplingValue('temperature', raw), /temperature/)
    }
  }
  assert.equal(api.samplingParseInput('top_p', '0').ok, false)
  assert.equal(api.samplingParseInput('top_p', '1.01').ok, false)
  const official = api.samplingScopeMessage('deepseek-official', api.SAMPLING_APPLIES_TO, 'deepseek-flash')
  assert.equal(official.supported, true)
  const account = api.samplingScopeMessage('deepseek-account', api.SAMPLING_APPLIES_TO, 'deepseek-v4-pro')
  assert.equal(account.supported, true)
  const other = api.samplingScopeMessage('openai', api.SAMPLING_APPLIES_TO, 'gpt-5')
  assert.equal(other.supported, false)
  assert.match(other.text, /仅对 DeepSeek/)
  const unknown = api.samplingScopeMessage('', api.SAMPLING_APPLIES_TO)
  assert.equal(unknown.known, false)
  assert.match(unknown.text, /尚未识别当前模型/)

  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(client, /name: "conversation\.input\.right"/)
  assert.match(client, /id: "dsh-workbench-sampling"[\s\S]{0,80}order: 1000/)
  assert.match(client, /SamplingButton/)
  assert.equal(client.includes('conversation.input.activity'), false)
})

test('partial clear keeps the other field', () => {
  const { store } = storeAt()
  store.update('left', { temperature: 1, top_p: 0.7 })
  store.update('left', { temperature: null })
  const body = finalMessagesBody(baseBody(), ordinary('left', baseBody()), store)
  assert.deepEqual(body.fields, { top_p: 0.7 })
})


test('model gating checks the wire model even on a DeepSeek provider', () => {
  const { store } = storeAt()
  const api = clientHelpers()
  store.update('model-switch', { temperature: 0, top_p: 0.75 })
  for (const model of ['deepseek', 'deepseek-flash', 'deepseek-v4-pro', 'DeepSeek-R1']) {
    assert.equal(isDeepSeekModel(model), true)
    assert.equal(api.samplingIsDeepSeekModel(model), true)
    const body = baseBody({ model })
    assert.deepEqual(finalMessagesBody(body, ordinary('model-switch', body), store).fields, { temperature: 0, top_p: 0.75 })
  }
  for (const model of [undefined, null, '', 'gpt-5', 'claude-sonnet', 'not-deepseek', 'deepseeker', 'deepseek-']) {
    assert.equal(isDeepSeekModel(model), false)
    assert.equal(api.samplingIsDeepSeekModel(model), false)
    const body = baseBody({ model })
    assert.deepEqual(finalMessagesBody(body, ordinary('model-switch', body), store).fields, {})
    assert.equal(api.samplingScopeMessage('deepseek-official', api.SAMPLING_APPLIES_TO, model).supported, false)
  }
  assert.equal(api.samplingScopeMessage('custom', api.SAMPLING_APPLIES_TO, 'deepseek-r1').supported, false)
  assert.equal(store.get('model-switch').temperature, 0)
})

test('sliders bound the ranges and preserve existing precise values', () => {
  const api = clientHelpers()
  const temp = api.samplingSliderSpec('temperature', '0')
  assert.deepEqual({ ...temp }, { min: 0, max: 2, step: 0.01, value: 0 })
  assert.deepEqual({ ...api.samplingSliderSpec('top_p', '') }, { min: 0.01, max: 1, step: 0.01, value: 1 })
  for (const raw of ['0.12345', '0.000001', '1e-7']) {
    const spec = api.samplingSliderSpec('top_p', raw)
    assert.equal(spec.value, Number(raw))
    assert.ok(spec.min > 0 && spec.min <= spec.value)
    assert.ok(spec.step <= 10 ** -Math.max(2, raw.includes('e') ? 7 : raw.split('.')[1].length))
  }
})

// Execute the actual component and its event handlers with a small hook renderer.
// This covers save payloads/model switches, rather than matching source strings.
function samplingUi(initial = { temperature: null, top_p: null }) {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const hooks = [], effects = [], posts = []
  let index = 0, dirty = false, tree, observer, sessionId = 'ui-session'
  let selected = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const parent = { querySelector() { return { getAttribute(key) { return key === 'data-provider-id' ? selected.provider : selected.model } } } }
  const button = { parentElement: parent }
  const context = {
    React: {
      Fragment: 'fragment',
      useState(value) {
        const n = index++
        if (!hooks[n]) hooks[n] = { value }
        return [hooks[n].value, next => { const v = typeof next === 'function' ? next(hooks[n].value) : next; if (!Object.is(v, hooks[n].value)) { hooks[n].value = v; dirty = true } }]
      },
      useRef(value) { const n = index++; return hooks[n] || (hooks[n] = { current: value }) },
      useEffect(fn, deps) {
        const n = index++, old = hooks[n]
        if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) {
          hooks[n] = { deps, cleanup: old && old.cleanup }
          effects.push(() => { hooks[n].cleanup?.(); hooks[n].cleanup = fn() })
        }
      },
    },
    h(type, props, ...children) {
      if (props?.ref) props.ref.current = type === 'button' ? button : { focus() {} }
      return { type, props: props || {}, children: children.flat().filter(x => x != null) }
    },
    createPortal: node => node,
    MutationObserver: class { constructor(fn) { observer = fn } observe() {} disconnect() {} },
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    window: { setTimeout(fn) { fn(); return 1 }, clearTimeout() {} },
    API: '/api', SC_CLOSE_ICON: '', mmToast() {},
    fetch: async () => ({ json: async () => ({ ok: true, ...initial }) }),
    scPost: async (_path, payload) => { posts.push(payload); return { ok: true, ...payload } },
  }
  const helpers = source.slice(source.indexOf('// <sampling-helpers>'), source.indexOf('// </sampling-helpers>'))
  const component = source.slice(source.indexOf('function iconSampling()'), source.indexOf('function apply(ctx)', source.indexOf('function SamplingButton(')))
  vm.createContext(context)
  vm.runInContext(helpers + component, context)
  function render() {
    for (let n = 0; n < 12; n++) {
      dirty = false; index = 0
      tree = context.SamplingButton({ sessionId })
      for (const effect of effects.splice(0)) effect()
      if (!dirty) return tree
    }
    throw new Error('component did not settle')
  }
  function all() {
    const nodes = []
    function walk(node) { if (node && typeof node === 'object') { nodes.push(node); node.children?.forEach(walk) } }
    walk(tree); return nodes
  }
  return {
    posts, render,
    nodes: all,
    button: () => all().find(n => n.props['data-dsh-workbench-sampling']),
    find: predicate => all().find(predicate),
    async settle() { await new Promise(resolve => setImmediate(resolve)); render() },
    switchModel(model, provider = selected.provider) { selected = { model, provider }; observer(); render() },
  }
}

test('component renders two sliders, saves defaults/zero/precise values and closes for other models', async () => {
  const ui = samplingUi({ temperature: 0.12345, top_p: null })
  ui.render(); await ui.settle()
  assert.equal(ui.button().props.disabled, false)
  ui.button().props.onClick(); ui.render()
  const sliders = () => ui.nodes().filter(n => n.type === 'input' && n.props.type === 'range')
  assert.equal(sliders().length, 2)
  assert.equal(ui.nodes().filter(n => n.type === 'input' && !['range', 'checkbox'].includes(n.props.type)).length, 0)
  assert.equal(sliders()[0].props.value, 0.12345)
  assert.equal(sliders()[1].props.disabled, true)
  const save = () => ui.find(n => n.type === 'button' && n.children.includes('保存'))
  save().props.onClick(); await ui.settle()
  assert.equal(ui.posts.at(-1).temperature, 0.12345)
  assert.equal(ui.posts.at(-1).top_p, null)
  sliders()[0].props.onChange({ target: { value: '0' } }); ui.render()
  save().props.onClick(); await ui.settle()
  assert.equal(ui.posts.at(-1).temperature, 0)
  const defaults = ui.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox')
  defaults[1].props.onChange({ target: { checked: false } }); ui.render()
  sliders()[1].props.onChange({ target: { value: '0.65' } }); ui.render()
  save().props.onClick(); await ui.settle()
  assert.equal(ui.posts.at(-1).top_p, 0.65)
  ui.find(n => n.type === 'button' && n.children.includes('恢复默认')).props.onClick(); await ui.settle()
  assert.equal(ui.posts.at(-1).temperature, null)
  assert.equal(ui.posts.at(-1).top_p, null)
  ui.switchModel('gpt-5')
  assert.equal(ui.button().props.disabled, true)
  assert.equal(ui.find(n => n.props.role === 'dialog'), undefined)
  ui.switchModel('deepseek-v4-pro')
  assert.equal(ui.button().props.disabled, false)
  ui.switchModel('deepseek-r1', 'custom')
  assert.equal(ui.button().props.disabled, true)
})


test('interactive example applies temperature before cumulative top_p and renormalizes', () => {
  const { samplingExample } = clientHelpers()
  const normal = samplingExample('', '')
  assert.deepEqual(Array.from(normal, r => r.word), ['猫', '狗', '兔子', '鲸鱼'])
  normal.forEach((r, i) => assert.ok(Math.abs(r.probability - [0.5, 0.3, 0.15, 0.05][i]) < 1e-10))
  const nucleus = samplingExample('1', '0.8')
  assert.deepEqual(Array.from(nucleus, r => r.active), [true, true, false, false])
  assert.ok(Math.abs(nucleus[0].probability - 0.625) < 1e-10)
  assert.equal(nucleus[2].probability, 0)
  assert.equal(nucleus[0].winner, true)
  assert.ok(samplingExample('0.2', '1')[0].probability > normal[0].probability)
  assert.ok(samplingExample('2', '1')[0].probability < normal[0].probability)
  for (const t of ['0', '0.0000001', '0.2', '1', '2']) {
    for (const p of ['0.01', '0.5', '0.8', '1']) {
      const rows = samplingExample(t, p)
      assert.equal(rows.filter(r => r.winner).length, 1)
      assert.equal(rows[0].active, true)
      assert.ok(rows.every(r => Number.isFinite(r.probability)))
      assert.ok(Math.abs(rows.reduce((sum, r) => sum + r.probability, 0) - 1) < 1e-10)
    }
  }
  assert.deepEqual(Array.from(samplingExample('0', '1'), r => r.active), [true, false, false, false])
})

test('dialog example reacts to the sliders and greys out excluded words', async () => {
  const ui = samplingUi({ temperature: 1, top_p: 1 })
  ui.render(); await ui.settle(); ui.button().props.onClick(); ui.render()
  const words = () => ui.nodes().filter(n => n.props['data-word'])
  assert.equal(words().length, 4)
  assert.equal(words().filter(n => n.props['data-winner']).length, 1)
  assert.equal(words().find(n => n.props['data-winner']).props['data-word'], '猫')
  const ranges = () => ui.nodes().filter(n => n.type === 'input' && n.props.type === 'range')
  ranges()[1].props.onChange({ target: { value: '0.8' } }); ui.render()
  assert.deepEqual(words().filter(n => n.props['data-excluded']).map(n => n.props['data-word']), ['兔子', '鲸鱼'])
  assert.ok(words()[0].props['aria-label'].includes('62.5%'))
  ranges()[0].props.onChange({ target: { value: '0' } }); ui.render()
  assert.equal(words().filter(n => n.props['data-excluded']).length, 3)
  assert.ok(words()[0].props['aria-label'].includes('100%'))
  const text = ui.nodes().flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ')
  assert.equal(text.includes('部分模型和思考模式会忽略'), false)
  assert.ok(text.includes('示意 · 非模型预测'))
})
