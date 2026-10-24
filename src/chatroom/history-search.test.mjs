// search_history：房间级内置只读工具（./history-search.mjs + chatroom-tools 接入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchHistory, searchableMessages, SEARCH_HISTORY, SEARCH_HISTORY_NAME, SEARCH_HISTORY_MAX_TOKENS } from './history-search.mjs'
import { createChatroomTools, DEFAULT_ROOM_TOOLS, effectiveToolNames } from './chatroom-tools.mjs'
import { OPEN_TOOLS } from '../channels/telegram/owner-gate.mjs'
import { buildPrompt } from './transcript.mjs'

const T0 = Date.parse('2026-10-01T00:00:00Z')
let seq = 0
const mk = (kind, text, extra = {}) => ({ id: 'm' + (++seq), seq, ts: new Date(T0 + seq * 60000).toISOString(), kind, status: 'ok', speaker: kind === 'user' ? { id: 'user', name: 'Shiro' } : { id: extra.sid || 'ds', name: extra.name || 'DeepSeek' }, text, ...extra })
function room() {
  seq = 0
  return [
    mk('user', 'Let us pick the Blue Plan for launch'),
    mk('seat', '我同意蓝色方案，预算是 3000 元', { contextHidden: true }),
    mk('seat', 'GPT here: budget ok', { name: 'GPT', sid: 'gpt' }),
    mk('system', '上下文压缩失败，已保留原窗口。', { notice: 'ctx-compress', speaker: { id: 'system', name: '聊天室' } }),
    mk('seat', '蓝色方案 secret draft', { status: 'failed' }),
    mk('tool', 'raw tool output 蓝色方案', { tool: 'web_search', data: { title: '搜索 蓝色方案', ok: true } }),
    mk('tool', 'binned 蓝色方案', { tool: 'web_search', data: { title: '回收 蓝色方案', ok: true } }),
    mk('seat', '最后决定：蓝色方案上线时间 11 月'),
  ]
}

test('matching: all terms, case-insensitive, newest first, total count', () => {
  const r = searchHistory(room(), { query: 'blue PLAN' }, { userName: 'Shiro' })
  assert.equal(r.total, 1); assert.match(r.text, /> #1 .*\[Shiro\] Let us pick the Blue Plan/)
  const z = searchHistory(room(), { query: 'blue nothing' })
  assert.equal(z.total, 0); assert.match(z.text, /No matching/)
})

test('CJK substring + folded (contextHidden) messages searchable; newest first', () => {
  const r = searchHistory(room(), { query: '蓝色方案', context: 0 })
  const seqs = [...r.text.matchAll(/^> #(\d+)/gm)].map((x) => Number(x[1]))
  assert.deepEqual(seqs, [8, 7, 6, 2])
  assert.equal(r.total, 4)
  assert.match(r.text, /预算是 3000 元/)
})

test('visibility: no ctx-compress notices, failed messages, raw card output or binned cards', () => {
  const r = searchHistory(room(), { query: '蓝色方案', context: 3 }, { binned: ['m7'] })
  assert.doesNotMatch(r.text, /上下文压缩失败/)
  assert.doesNotMatch(r.text, /secret draft/)
  assert.doesNotMatch(r.text, /raw tool output/)
  assert.doesNotMatch(r.text, /回收/)
  assert.match(r.text, /\[card · 搜索 蓝色方案\]/)
  assert.ok(!searchableMessages(room()).some((m) => m.notice === 'ctx-compress'))
})

test('filters: sender (member / user), seq range, time range', () => {
  assert.equal(searchHistory(room(), { sender: 'GPT' }).total, 1)
  assert.equal(searchHistory(room(), { sender: 'user' }, { userName: 'Shiro' }).total, 1)
  assert.equal(searchHistory(room(), { query: '蓝色方案', fromSeq: 3, toSeq: 7 }).total, 2)
  const since = new Date(T0 + 7.5 * 60000).toISOString()
  assert.equal(searchHistory(room(), { query: '蓝色方案', since }).total, 1)
  const until = new Date(T0 + 2 * 60000).toISOString()
  assert.equal(searchHistory(room(), { query: '蓝色方案', until }).total, 1)
  assert.equal(searchHistory(room(), {}).error, true)
})

test('context neighbours: default 1 each side, clamped to 3', () => {
  const r = searchHistory(room(), { query: 'GPT here' })
  const lines = r.text.split('\n').filter((l) => /^[> ] #/.test(l))
  assert.deepEqual(lines.map((l) => l.slice(0, 4)), ['  #2', '> #3', '  #6'])
  const big = searchHistory(room(), { query: 'GPT here', context: 99 })
  assert.equal(big.text.split('\n').filter((l) => /^[> ] #/.test(l)).length, 6)
})

test('caps: limit default 8 / max 20, text 600 chars, ~8k token total with note', () => {
  seq = 0
  const many = Array.from({ length: 40 }, (_, i) => mk('seat', 'needle ' + i + ' ' + '字'.repeat(2000)))
  const d = searchHistory(many, { query: 'needle', context: 0 })
  assert.equal(d.total, 40); assert.equal(d.shown, 8)
  assert.ok(d.text.split('\n').every((l) => l.length < 700))
  const m = searchHistory(many, { query: 'needle', context: 3, limit: 50 })
  assert.equal(m.truncated, true); assert.match(m.text, /Result truncated/)
  assert.ok(m.shown < 20)
})

test('default room tool: schema present, not stored, open to non-owners; no game tools pulled in', async () => {
  assert.ok(DEFAULT_ROOM_TOOLS.includes(SEARCH_HISTORY_NAME))
  assert.ok(OPEN_TOOLS.has(SEARCH_HISTORY_NAME))
  assert.ok(effectiveToolNames([], []).includes(SEARCH_HISTORY_NAME))
  assert.match(SEARCH_HISTORY.description, /only this room/)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hs-'))
  try {
    const rooms = { a: room(), b: [mk('user', 'other room 蓝色方案 leak')] }
    const tk = createChatroomTools({ roomDir: (id) => join(dir, id), getTools: () => [], readRoom: async (id) => ({ messages: rooms[id] || [], binned: [] }) })
    const sch = await tk.schemas('a', { owner: false })
    const names = sch.map((t) => t.name)
    assert.ok(names.includes(SEARCH_HISTORY_NAME))
    assert.ok(!names.some((n) => /^mc_|gamebot/.test(n)))
    assert.equal((await tk.toolsets.list('a')).length, 0)
    const r = await tk.run('a', { name: SEARCH_HISTORY_NAME, arguments: JSON.stringify({ query: '蓝色方案' }) }, { owner: false, seat: { id: 'gpt' } })
    assert.equal(r.isError, false); assert.equal(r.room, null)
    assert.doesNotMatch(r.modelText, /leak/)
    const rb = await tk.run('b', { name: SEARCH_HISTORY_NAME, arguments: '{"query":"预算"}' }, { owner: false })
    assert.equal(rb.modelText, 'No matching messages in this room.')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('summary prompt tells members about search_history', () => {
  const seat = { id: 'ds', name: 'DeepSeek', provider: 'p', model: 'm', enabled: true }
  const p = buildPrompt({ seat, seats: [seat], userName: 'Shiro', messages: room(), maxHistory: 24, contextSummary: '摘要', contextUntilSeq: 2 })
  assert.match(p.messages.map((m) => m.content).join('\n'), /use the search_history tool/)
})