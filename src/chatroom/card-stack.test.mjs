// 卡片管理堆叠：lib/client.js 中 <cr-cm-stack-helpers> 段的纯函数（只影响面板显示，不改数据格式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

function helpers() {
  const a = src.indexOf('// <cr-cm-stack-helpers>'), b = src.indexOf('// </cr-cm-stack-helpers>')
  assert.ok(a >= 0 && b > a, 'lib/client.js lacks the <cr-cm-stack-helpers> block')
  const ctx = { window: { localStorage: { store: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null }, setItem(k, v) { this.store[k] = String(v) } } } }
  vm.runInNewContext(src.slice(a, b) + '\nthis.h = { CR_CM_GROUP_KEY, CR_CM_PAGE_SIZE, CR_CM_FETCH_LIMIT, crCmLoadGroupBy, crCmSaveGroupBy, crCmNormGroupBy, crCmTypeKey, crCmTypeLabel, crCmRoundKey, crCmRoundLabel, crCmSummary, crCmGroup, crCmSliceGroups, crCmSelState };', ctx)
  return ctx.h
}

test('card stacks: group by type in first-seen order, keep item order, count statuses', () => {
  const h = helpers()
  const items = [
    { id: 'a', tool: 'web_search', status: 'ok', data: {} },
    { id: 'b', tool: 'watch_video', status: 'blank', data: {} },
    { id: 'c', tool: 'web_search', status: 'binned', data: {} },
    { id: 'd', tool: 'cursor', status: 'ok', data: { cursorTask: { id: 1 } } },
    { id: 'e', tool: '', status: 'ok', data: {} },
    null,
  ]
  const g = h.crCmGroup(items)
  assert.deepEqual(Array.from(g, (x) => x.key), ['web_search', 'watch_video', 'cursor-task', 'unknown'])
  assert.deepEqual(Array.from(g[0].items, (x) => x.id), ['a', 'c'])
  assert.equal(g[0].count, 2)
  assert.deepEqual({ ...g[0].counts }, { ok: 1, blank: 0, binned: 1 })
  assert.equal(g[0].mode, 'type')
  assert.equal(g[2].label, 'Cursor 任务')
  assert.equal(g[3].label, '未命名工具')
  assert.equal(h.crCmGroup([]).length, 0)
  assert.equal(h.crCmGroup(undefined).length, 0)
})

test('card stacks: group by round+time (minute buckets) with seq label', () => {
  const h = helpers()
  const items = [
    { id: 'a', tool: 'web_search', status: 'ok', seq: 12, ts: '2026-10-23T08:31:10.000Z', data: {} },
    { id: 'b', tool: 'watch_video', status: 'blank', seq: 11, ts: '2026-10-23T08:31:40.000Z', data: {} },
    { id: 'c', tool: 'web_search', status: 'ok', seq: 5, ts: '2026-10-23T07:01:00.000Z', data: {} },
    { id: 'd', tool: 'x', status: 'ok', seq: 3, data: {} },
  ]
  const g = h.crCmGroup(items, 'round')
  assert.equal(g.length, 3)
  assert.equal(g[0].mode, 'round')
  assert.deepEqual(Array.from(g[0].items, (x) => x.id), ['a', 'b'])
  assert.match(g[0].label, /编号 11–12$/)
  assert.equal(g[2].key, 'seq:3')
  assert.equal(g[2].label, '编号 3')
  assert.equal(h.crCmRoundKey({ ts: 'not-a-date', seq: 9 }), 'seq:9')
})

test('card stacks: groupBy preference persists round / type', () => {
  const h = helpers()
  assert.equal(h.crCmLoadGroupBy(), 'type')
  assert.equal(h.crCmSaveGroupBy('round'), 'round')
  assert.equal(h.crCmLoadGroupBy(), 'round')
  assert.equal(h.crCmSaveGroupBy('nope'), 'type')
  assert.equal(h.crCmLoadGroupBy(), 'type')
})

test('card stacks: crCmNormGroupBy never reads .groupBy on undefined; defaults to type', () => {
  const h = helpers()
  assert.equal(h.crCmNormGroupBy(undefined), 'type')
  assert.equal(h.crCmNormGroupBy(null), 'type')
  assert.equal(h.crCmNormGroupBy({}), 'type')
  assert.equal(h.crCmNormGroupBy({ groupBy: 'nope' }), 'type')
  assert.equal(h.crCmNormGroupBy({ groupBy: 'round' }), 'round')
  assert.equal(h.crCmNormGroupBy({ groupBy: 'type' }), 'type')
})

test('card stacks: summary prefers inline, collapses whitespace, truncates, explains failures', () => {
  const h = helpers()
  assert.equal(h.crCmSummary({ data: { inline: '42', preview: 'x' } }), '42')
  assert.equal(h.crCmSummary({ data: { preview: 'a\n\n  b' } }), 'a b')
  assert.equal(h.crCmSummary({ data: { preview: 'x'.repeat(100) } }, 10), 'xxxxxxxxxx…')
  assert.equal(h.crCmSummary({ data: { ok: false, preview: 'p' } }), '调用失败，成员只看到空白卡片')
  assert.equal(h.crCmSummary({}), '')
})

test('card stacks wiring: own rightward fan transform, Esc collapses, keeps bin actions, group toggle', () => {
  assert.ok(src.includes('face.style.transform = cmFanTransform(depth)'))
  assert.ok(src.includes('crCmSliceGroups(allGroups, cm.page, cm.size)'))
  assert.ok(src.includes('CR_CM_FETCH_LIMIT'))
  assert.ok(src.includes('var CR_CM_PAGE_SIZE = 8'))
  assert.ok(src.includes('ev.key !== "Escape"'))
  assert.ok(src.includes('"收进回收站"') && src.includes('"移出回收站"'))
  assert.ok(src.includes('"轮次与时间"') && src.includes('"类型"'))
  assert.ok(src.includes('crCmSaveGroupBy'))
  assert.ok(src.includes('crCmNormGroupBy'))
  const cmDecl = src.indexOf('var cm = { filter:')
  const cmElsCall = src.indexOf('cmEls = buildCardManagerEls()')
  assert.ok(cmDecl >= 0 && cmElsCall > cmDecl, 'cm must be initialized before buildCardManagerEls()')
  assert.ok(src.includes('aria-label", "卡片分组方式"'))
})

test('card stacks: per-type select state is all / some / none', () => {
  const h = helpers()
  assert.equal(h.crCmSelState(['a', 'b'], { a: true, b: true, z: true }), 'all')
  assert.equal(h.crCmSelState(['a', 'b'], { a: true }), 'some')
  assert.equal(h.crCmSelState(['a', 'b'], {}), 'none')
  assert.equal(h.crCmSelState([], { a: true }), 'none')
  assert.equal(h.crCmSelState(undefined, undefined), 'none')
})

test('card stacks wiring: type select-all has aria-label and does not toggle the stack', () => {
  assert.ok(src.includes('"全选此类："'))
  assert.ok(src.includes('"全选本组："'))
  assert.ok(src.includes('all.addEventListener("click", function (ev) { ev.stopPropagation(); });'))
})
test('card stacks: crCmSliceGroups pages by groups, clamps page, empty is 1 page', () => {
  const h = helpers()
  assert.equal(h.CR_CM_PAGE_SIZE, 8)
  assert.equal(h.CR_CM_FETCH_LIMIT, 200)
  const groups = Array.from({ length: 20 }, (_, i) => ({ key: 'g' + i }))
  const a = h.crCmSliceGroups(groups, 0, 8)
  assert.equal(a.pages, 3)
  assert.equal(a.totalGroups, 20)
  assert.equal(a.groups.length, 8)
  assert.equal(a.groups[0].key, 'g0')
  const b = h.crCmSliceGroups(groups, 2, 8)
  assert.equal(b.page, 2)
  assert.equal(b.groups.length, 4)
  assert.equal(b.groups[0].key, 'g16')
  const c = h.crCmSliceGroups(groups, 99, 8)
  assert.equal(c.page, 2)
  const empty = h.crCmSliceGroups([], 3, 8)
  assert.equal(empty.page, 0)
  assert.equal(empty.pages, 1)
  assert.equal(empty.totalGroups, 0)
  assert.deepEqual(empty.groups, [])
})
