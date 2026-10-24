// 「工作组件」设置页首页搜索：lib/client.js 中 <mm-search-helpers> 段的纯函数（名称 / 描述 / 分组名，多词「且」，
// 不区分大小写，中英文），以及按真实 FEATURES 数据筛选的结果。客户端为手写文件，测试从源码截取该段在 vm 中执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..', '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

function helpers() {
  const a = src.indexOf('// <mm-search-helpers>'), b = src.indexOf('// </mm-search-helpers>')
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks the <mm-search-helpers> block')
  const ctx = {}
  vm.runInNewContext(src.slice(a, b) + '\nthis.h = { mmSearchFold, mmSearchTerms, mmSearchMatches, mmSearchFilter, mmSearchRanges };', ctx)
  return ctx.h
}

// 真实功能列表：截取 FEATURES 数组，ICONS 用桩代替（只取 id / group / title / desc / hidden）。
function features() {
  const a = src.indexOf('var FEATURES = [')
  const b = src.indexOf('\n];', a)
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks var FEATURES')
  const ctx = { ICONS: new Proxy({}, { get: () => '' }) }
  vm.runInNewContext(src.slice(a, b + 3) + '\nthis.list = FEATURES.map(function (f) { return { id: f.id, group: f.group, title: f.title, desc: f.desc, hidden: f.hidden === true }; });', ctx)
  return JSON.parse(JSON.stringify(ctx.list))
}

const plain = (v) => JSON.parse(JSON.stringify(v))

const ITEMS = [
  { id: 'image', group: '多模态', title: '媒体卡片', desc: 'mm_send_image 发图片卡片。' },
  { id: 'map', group: '多模态', title: '地图', desc: '地点检索、路线规划、天气预报。' },
  { id: 'office', group: '工作组件', title: 'Office', desc: '经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP）。' },
  { id: 'chrome', group: '工作组件', title: 'Chrome', desc: '控制 Chrome 浏览器。' },
  { id: 'desktop', group: '通用', title: '桌面控制', desc: '按控件操作键鼠和截图。' },
  { id: 'mc', group: '游戏', title: 'Minecraft', desc: 'GameBot 玩 Minecraft。' },
  { id: 'chatroom', group: '通用', title: '聊天室', desc: '多个 AI 协作讨论。', hidden: true },
]
const ids = (res, items = ITEMS) => items.filter((_, i) => res.matched[i]).map((it) => it.id)

test('terms: lowercased, split on any whitespace (incl. full-width space), deduped; empty query = no filter', () => {
  const h = helpers()
  assert.deepEqual(plain(h.mmSearchTerms('  Office   WORD office ')), ['office', 'word'])
  assert.deepEqual(plain(h.mmSearchTerms('桌面\u3000控制')), ['桌面', '控制'])
  assert.deepEqual(plain(h.mmSearchTerms('ＧＰＴ')), ['gpt'])
  assert.deepEqual(plain(h.mmSearchTerms('')), [])
  assert.deepEqual(plain(h.mmSearchTerms(null)), [])
  const res = h.mmSearchFilter(ITEMS, '   ')
  assert.equal(res.active, false)
  assert.deepEqual(ids(res), ['image', 'map', 'office', 'chrome', 'desktop', 'mc'], 'empty query shows everything except rows hidden anyway')
})

test('matches name / description / group, case-insensitive, Chinese and English', () => {
  const h = helpers()
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, 'OFFICE')), ['office'])
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, 'powerpoint')), ['office'], 'description match')
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, '桌面')), ['desktop'])
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, '路线')), ['map'])
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, 'zzz-none')), [])
  // 搜索词不跨字段拼接（名称尾 + 描述头不算命中）
  assert.deepEqual(ids(h.mmSearchFilter([{ id: 'x', group: 'g', title: 'ab', desc: 'cd' }], 'bc'), [{ id: 'x' }]), [])
})

test('multiple terms are AND; terms may hit different fields', () => {
  const h = helpers()
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, 'chrome 浏览器')), ['chrome'])
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, '工作组件 word')), ['office'], 'group + description')
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, 'chrome word')), [])
  assert.deepEqual(ids(h.mmSearchFilter(ITEMS, '游戏 minecraft')), ['mc'])
})

test('group name match shows all its cards; groups without matches are reported empty', () => {
  const h = helpers()
  const res = h.mmSearchFilter(ITEMS, '多模态')
  assert.deepEqual(ids(res), ['image', 'map'])
  assert.deepEqual(plain(res.groups), { '多模态': true, '工作组件': false, '通用': false, '游戏': false })
  assert.equal(res.count, 2)
  const none = h.mmSearchFilter(ITEMS, '没有这个')
  assert.equal(none.active, true)
  assert.equal(none.count, 0)
  assert.ok(Object.values(none.groups).every((v) => v === false))
})

test('rows hidden anyway (experimental, not enabled) never match or count', () => {
  const h = helpers()
  const res = h.mmSearchFilter(ITEMS, '聊天室')
  assert.deepEqual(ids(res), [])
  assert.equal(res.count, 0)
  assert.equal(res.groups['通用'], false)
  const shown = ITEMS.map((it) => ({ ...it, hidden: false }))
  assert.deepEqual(ids(h.mmSearchFilter(shown, '聊天室'), shown), ['chatroom'])
})

test('does not mutate the input items', () => {
  const h = helpers()
  const copy = JSON.parse(JSON.stringify(ITEMS))
  h.mmSearchFilter(ITEMS, 'office 工作组件')
  assert.deepEqual(ITEMS, copy)
})

test('highlight ranges: all occurrences, case-insensitive, merged, empty when no terms', () => {
  const h = helpers()
  assert.deepEqual(plain(h.mmSearchRanges('Chrome 控制 Chrome', ['chrome'])), [[0, 6], [10, 16]])
  assert.deepEqual(plain(h.mmSearchRanges('OfficeMCP', ['office', 'xyz'])), [[0, 6]], 'non-occurring term adds nothing')
  assert.deepEqual(plain(h.mmSearchRanges('abcdef', ['abc', 'cde'])), [[0, 5]], 'overlaps merge')
  assert.deepEqual(plain(h.mmSearchRanges('abcdef', ['ab', 'cd'])), [[0, 4]], 'adjacent ranges merge')
  assert.deepEqual(plain(h.mmSearchRanges('桌面控制', ['控制'])), [[2, 4]])
  assert.deepEqual(plain(h.mmSearchRanges('ＧＰＴ Image', ['gpt'])), [[0, 3]], 'full-width letters map 1:1')
  assert.deepEqual(plain(h.mmSearchRanges('anything', [])), [])
  assert.deepEqual(plain(h.mmSearchRanges('', ['a'])), [])
})

test('real FEATURES list: Chinese / English queries and group filtering', () => {
  const h = helpers()
  const list = features()
  assert.ok(list.length > 10)
  const visible = (q) => list.filter((_, i) => h.mmSearchFilter(list, q).matched[i]).map((f) => f.id)
  assert.ok(visible('office').includes('office'))
  assert.ok(visible('OFFICE').includes('office'))
  const mm = visible('多模态')
  assert.ok(mm.length >= 2)
  for (const f of list.filter((f) => f.group === '多模态' && !f.hidden)) assert.ok(mm.includes(f.id), `group match shows ${f.id}`)
  const res = h.mmSearchFilter(list, '多模态')
  for (const [g, has] of Object.entries(res.groups)) if (g !== '多模态') assert.equal(has, mm.some((id) => list.find((f) => f.id === id).group === g), `group ${g}`)
  assert.deepEqual(visible('qqq-无此组件-zzz'), [])
})

test('settings page wiring: placeholder, empty state, Esc clears, filtering only toggles a CSS class', () => {
  assert.ok(src.includes('"搜索组件名称、描述或分组"'))
  assert.ok(src.includes('"没有匹配的组件"'))
  assert.ok(src.includes('".mm-page .mm-search-out{display:none!important}"'))
  const a = src.indexOf('function applySearch()')
  assert.ok(a > 0, 'lib/client.js lacks applySearch')
  const body = src.slice(a, src.indexOf('\n  }\n', a) >= 0 ? src.indexOf('\n  }\n', a) : src.indexOf('\r\n  }\r\n', a))
  assert.ok(body.includes('classList.toggle("mm-search-out"'))
  for (const bad of ['fetch(', 'pageFetch', '.remove()', 'removeChild', 'setSwitch', 'saveSettings', 'lastValue']) assert.ok(!body.includes(bad), `applySearch must not use ${bad}`)
})