import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { buildPrompt } from './transcript.mjs'
import { listCards } from './card-bin.mjs'
import { changedBetween, cursorReport, toolSummaryLine, listRoomBriefs, isBriefContinuable, briefStatusLabel, CURSOR_BRIEF_CONTINUABLE } from './cursor.mjs'

// Cursor 任务卡片：「先交卷、后补卷」（mock runner，不启动真的 cursor-agent）
const SEATS = [
  { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'd' },
  { id: 'gk', name: 'Grok', provider: 'xai', model: 'g', leader: true },
]
const tc = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)) } }
const promptText = (o) => (o.prompt?.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

async function setup({ script = [], runCursor, seats = SEATS, by = 'ds', dir: given } = {}) {
  const dir = given || await mkdtemp(join(tmpdir(), 'dsh-cc-'))
  const store = createStore(dir)
  const toolkit = createChatroomTools({
    roomDir: (id) => join(dir, 'rooms', id),
    getTools: () => ({ schemas: () => [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], get: (n) => ({ execute: async (a) => ({ content: [{ type: 'text', text: `${n} ${a.path} ` + 'x'.repeat(40) }] }) }) }),
    getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }),
  })
  const calls = []
  let i = 0
  const call = async (o) => { calls.push(o); const step = script[Math.min(i++, script.length - 1)] ?? { text: '[PASS]', usage: {} }; return typeof step === 'function' ? step(o) : step }
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, _r, text, o) => { relays.push({ seat: seat?.id || null, text, prefix: o?.prefixName }); return [] } }
  const cfg = { seats, userName: 'Shiro', budget: 3, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {}, cursorRepo: dir }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call, toolkit, tg, runCursor, emit: (_, e) => events.push(e) })
  const room = await store.createRoom({ title: 'cursor' })
  await toolkit.toolsets.add(room.id, ['read_file'], { max: 10, by: 'test' })
  // 任务书（等同于 submitBrief 的结果）
  const repo = join(dir, 'my-workspace')
  const briefId = 'bt001'
  const msg = await store.append(room.id, { kind: 'brief', briefId, briefStatus: 'awaiting_owner', action: 'brief', repo, title: 'Add A', speaker: { id: by, name: by }, text: 'Implement A.' })
  await store.patchMeta(room.id, (m) => { m.briefs = { [briefId]: { action: 'brief', title: 'Add A', brief: 'Implement A.', repo, status: 'awaiting_owner', by, msgId: msg.id } }; m.pendingBrief = briefId })
  return { dir, store, toolkit, moderator, calls, events, relays, room, briefId, done: () => rm(dir, { recursive: true, force: true }) }
}
const cursorCard = async (f) => (await f.store.readMessages(f.room.id)).find((m) => m.kind === 'tool' && m.data?.cursorTask)

test('cursor card: 执行 creates a running card at once (turn not blocked), then the same card is filled in; 交卷 note wakes the originator', async () => {
  const gate = deferred()
  const longReport = 'Final report. ' + 'y'.repeat(30000)
  const runCursor = async () => { await gate.promise; return { ok: true, status: 'success', exitCode: 0, sessionId: 's1', finalText: longReport, toolCalls: 4, durationMs: 65000, diffStat: ' a.mjs | 2 +-\n 1 file changed', changedFiles: [' M a.mjs', '?? new.txt'] } }
  const f = await setup({ runCursor, script: [{ text: '看过报告了，继续。', usage: {} }] })
  try {
    const ex = await f.moderator.post(f.room.id, '执行 ' + f.briefId, { owner: true })
    assert.ok(ex.cursor && typeof ex.cursor.then === 'function')
    const running = await until(() => cursorCard(f))
    assert.equal(running.speaker.id, 'ds'); assert.equal(running.data.cursorTask.status, 'running')
    assert.equal(running.data.title, 'Cursor 任务 #bt001 · my-workspace · 进行中')
    assert.ok(!running.data.resultId)
    assert.equal(f.moderator.status(f.room.id).cursor.briefId, 'bt001')
    // 运行期间：AI 只看到「仍在进行」；卡片在卡片管理列表里
    let msgs = await f.store.readMessages(f.room.id)
    let p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs })
    assert.match(p.messages.map((m) => m.content).join('\n'), /\[card by DeepSeek · Cursor 任务 #bt001 · my-workspace · 进行中\] \(Cursor is still working on it/)
    assert.equal(listCards(msgs, {}).items.filter((x) => x.id === running.id).length, 1)
    await until(async () => (await f.store.readMessages(f.room.id)).find((m) => m.kind === 'brief').briefStatus === 'running')
    assert.ok(f.relays.some((r) => /开始执行：Add A/.test(r.text)))
    // AI 回合不等它：用户此时说话，成员照常回复
    gate.resolve()
    const card = await ex.cursor
    assert.equal(card.id, running.id); assert.equal(card.seq, running.seq)
    assert.equal(card.data.title, 'Cursor 任务 #bt001 · my-workspace · 已完成')
    assert.ok(card.data.resultId); assert.equal(card.data.cursorTask.status, 'done'); assert.equal(card.data.cursorTask.exitCode, 0); assert.equal(card.data.cursorTask.durationMs, 65000)
    assert.deepEqual(card.data.cursorTask.changedFiles, [' M a.mjs', '?? new.txt'])
    assert.ok(!('finalText' in card.data)) // 全文只在结果文件里
    assert.ok(f.events.some((e) => e.type === 'message-update' && e.message.id === card.id && e.message.data.cursorTask.status === 'done'))
    // 全文分页（与卡片内容接口相同）
    const page1 = await f.toolkit.results.read(f.room.id, card.data.resultId, {})
    assert.ok(page1.ok); assert.ok(page1.total > 30000); assert.ok(page1.next != null)
    assert.match(page1.text, /Status: success · exit code 0 · 65 s/); assert.match(page1.text, / M a\.mjs\n\?\? new\.txt/); assert.match(page1.text, /1 file changed/); assert.match(page1.text, /Final report\./)
    // 交卷提示：用户看到中文，AI 看到系统事件；不转发 Telegram；唤醒发起成员 DeepSeek
    await until(() => !f.moderator.status(f.room.id).running && f.calls.length >= 1)
    msgs = await f.store.readMessages(f.room.id)
    const note = msgs.find((m) => m.notice === 'cursor-done')
    assert.equal(note.text, 'Cursor 任务 #bt001 交卷了'); assert.equal(note.aiVisible, true)
    assert.ok(!f.relays.some((r) => /交卷/.test(r.text)))
    assert.equal(f.relays.filter((r) => /已完成，退出码 0/.test(r.text)).length, 1)
    assert.equal(f.calls[0].seat.id, 'ds')
    const woke = promptText(f.calls[0])
    assert.match(woke, new RegExp(`The Cursor task #bt001 handed in its sheet \\(card #${card.data.resultId}, completed\\)\\. DeepSeek, open the card and carry on\\.`))
    assert.match(woke, new RegExp(`\\[card #${card.data.resultId} by DeepSeek · Cursor 任务 #bt001 · my-workspace · 已完成\\]`))
    assert.ok(!woke.includes('交卷了'))
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'success')
    assert.equal(msgs.find((m) => m.kind === 'brief').briefStatus, 'success')
  } finally { await f.done() }
})

test('cursor card: a failed run keeps its report; the leader is woken when the originator is gone', async () => {
  const runCursor = async () => ({ ok: false, status: 'failed', exitCode: 1, finalText: 'Could not build.', durationMs: 1000, diffStat: '', stderrTail: 'tsc error' })
  const f = await setup({ runCursor, by: 'gone', script: [{ text: '我来看看失败原因。', usage: {} }] })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    const card = await ex.cursor
    assert.equal(card.speaker.id, 'cursor')
    assert.equal(card.data.title, 'Cursor 任务 #bt001 · my-workspace · 失败'); assert.equal(card.data.ok, true); assert.equal(card.data.cursorTask.status, 'failed')
    const full = await f.toolkit.results.read(f.room.id, card.data.resultId, {})
    assert.match(full.text, /Could not build\./); assert.match(full.text, /tsc error/); assert.match(full.text, /not a git repository/)
    await until(() => !f.moderator.status(f.room.id).running && f.calls.length >= 1)
    assert.equal(f.calls[0].seat.id, 'gk')
    assert.match(promptText(f.calls[0]), /handed in its sheet \(card #r\w+, failed: failed\)\. Grok, open the card/)
  } finally { await f.done() }
})

test('cursor card: 取消 while running → blank sheet (user sees 已取消, AIs a rough reason); no wake; pending 取消 also leaves a blank card', async () => {
  let seenSignal
  const runCursor = (_b, { signal }) => new Promise((resolve) => { seenSignal = signal; signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'partial', durationMs: 10 })) })
  const f = await setup({ runCursor })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    await until(() => cursorCard(f))
    await until(() => seenSignal)
    assert.equal(await f.moderator.cancelBrief(f.room.id, 'bt001'), true)
    const card = await ex.cursor
    assert.equal(card.data.ok, false); assert.equal(card.data.blank, true); assert.equal(card.text, '已取消')
    assert.equal(card.data.title, 'Cursor 任务 #bt001 · my-workspace · 已取消'); assert.equal(card.data.cursorTask.status, 'cancelled')
    assert.ok(!card.data.resultId)
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(!msgs.some((m) => m.notice === 'cursor-done'))
    const p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs }).messages.map((m) => m.content).join('\n')
    assert.match(p, /\[card by DeepSeek · Cursor 任务 #bt001 · my-workspace · 已取消\] This sheet came back blank \(cancelled by the user\)\./)
    assert.ok(!p.includes('partial'))
    assert.equal(f.calls.length, 0)
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'cancelled')
    assert.equal(msgs.find((m) => m.kind === 'brief').briefStatus, 'cancelled')
    assert.equal(f.moderator.status(f.room.id).cursor, null)
  } finally { await f.done() }
  const g = await setup({ runCursor })
  try {
    assert.equal(await g.moderator.cancelBrief(g.room.id, 'bt001'), true)
    const card = await cursorCard(g)
    assert.equal(card.data.blank, true); assert.equal(card.data.cursorTask.status, 'cancelled'); assert.equal(card.text, '已取消')
    const meta = await g.store.getRoom(g.room.id)
    assert.equal(meta.briefs.bt001.status, 'cancelled'); assert.equal(meta.pendingBrief, undefined)
    assert.equal((await g.moderator.post(g.room.id, '执行', { owner: true })).cursor && await (await g.moderator.post(g.room.id, '执行 bt001', { owner: true })).cursor, null)
  } finally { await g.done() }
})

test('cursor card: a run interrupted by a DSH restart is marked 状态未知 on startup', async () => {
  const gate = deferred()
  const f = await setup({ runCursor: async () => { await gate.promise; return { ok: true, status: 'success', exitCode: 0 } } })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    const running = await until(() => cursorCard(f))
    await until(async () => (await f.store.getRoom(f.room.id)).briefs.bt001.cardId)
    // 「重启」：新的 moderator（新进程）接手同一个数据目录；旧的那个不再写入
    const events = []
    const fresh = createModerator({ store: createStore(f.dir), getRoomConfig: async () => ({ seats: SEATS, userName: 'Shiro', budget: 3, tools: {} }), call: async () => ({ text: '[PASS]' }), emit: (_, e) => events.push(e) })
    assert.equal(await fresh.recoverCursorRuns(), 1)
    const card = await cursorCard(f)
    assert.equal(card.id, running.id)
    assert.equal(card.data.title, 'Cursor 任务 #bt001 · my-workspace · 状态未知'); assert.equal(card.data.blank, true); assert.equal(card.data.cursorTask.status, 'interrupted')
    assert.match(card.text, /DSH 在任务运行期间重启/)
    assert.ok(events.some((e) => e.type === 'message-update'))
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'interrupted')
    const p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: await f.store.readMessages(f.room.id) }).messages.map((m) => m.content).join('\n')
    assert.match(p, /This sheet came back blank \(interrupted by a restart, the outcome is unknown\)\./)
    // 再跑一次不会重复处理；当前进程自己在跑的任务也不会被误判
    assert.equal(await fresh.recoverCursorRuns(), 0)
    gate.resolve(); await ex.cursor
    await until(() => !f.moderator.status(f.room.id).running)
  } finally { await f.done() }
})

test('cursor card: 插话熔断 running Cursor → blank「已熔断」, abort signal, no wake; pending brief untouched', async () => {
  let seenSignal
  const runCursor = (_b, { signal }) => new Promise((resolve) => {
    seenSignal = signal
    signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'partial', durationMs: 10 }))
  })
  const f = await setup({ runCursor, script: [{ text: '收到，换方向。', usage: {} }, { text: '[PASS]', usage: {} }] })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    await until(() => cursorCard(f))
    await until(() => seenSignal)
    const second = await f.moderator.post(f.room.id, '等一下，换个方向', { owner: true })
    assert.equal(second.interrupted, true)
    assert.equal(second.fusedCursor, true)
    assert.equal(seenSignal.aborted, true)
    const card = await ex.cursor
    assert.equal(card.data.ok, false); assert.equal(card.data.blank, true)
    assert.equal(card.text, '已熔断（用户插话，任务已中止）')
    assert.equal(card.data.title, 'Cursor 任务 #bt001 · my-workspace · 已熔断')
    assert.equal(card.data.cursorTask.status, 'fused')
    assert.ok(!card.data.resultId)
    assert.ok(f.events.some((e) => e.type === 'cursor' && e.running === false && e.status === 'fused'))
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(!msgs.some((m) => m.notice === 'cursor-done'))
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'fused')
    const p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs }).messages.map((m) => m.content).join('\n')
    assert.match(p, /This sheet came back blank \(aborted by a new user message\)\./)
    assert.ok(!p.includes('partial'))
    await second.promise
    assert.ok(f.calls.length >= 1)
    assert.match(promptText(f.calls[0]), /等一下，换个方向/)
    assert.equal(f.moderator.status(f.room.id).cursor, null)
  } finally { await f.done() }
})

test('cursor card: 「执行」 interrupts a hanging seat then starts Cursor (no extra discussion round)', async () => {
  const hang = (o) => new Promise((_, rej) => {
    const fail = () => rej(Object.assign(new Error('已停止'), { aborted: true }))
    if (o.signal?.aborted) fail(); else o.signal?.addEventListener('abort', fail, { once: true })
  })
  let seenSignal
  const runCursor = (_b, { signal }) => new Promise((resolve) => {
    seenSignal = signal
    signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'x', durationMs: 5 }))
    setTimeout(() => resolve({ ok: true, status: 'success', exitCode: 0, finalText: 'done', durationMs: 5 }), 30)
  })
  const f = await setup({
    runCursor,
    script: [hang, { text: '交卷后继续', usage: {} }],
  })
  try {
    const first = await f.moderator.post(f.room.id, '先说着', { owner: true })
    await until(() => f.calls.length >= 1)
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    assert.equal(ex.interrupted, true)
    assert.ok(ex.cursor)
    assert.equal(f.calls[0].signal.aborted, true)
    await first.promise
    const running = await until(() => cursorCard(f))
    assert.equal(running.data.cursorTask.status, 'running')
    await until(() => seenSignal)
    const card = await ex.cursor
    assert.equal(card.data.cursorTask.status, 'done')
    await until(() => !f.moderator.status(f.room.id).running && f.calls.length >= 2)
    assert.match(promptText(f.calls[1]), /handed in its sheet/)
  } finally { await f.done() }
})


test('cursor card: end_round while Cursor is running does NOT abort (handoff keeps going; only cancel/fuse/stopAll blank it)', async () => {
  let seenSignal
  const gate = deferred()
  const runCursor = (_b, { signal }) => new Promise((resolve) => {
    seenSignal = signal
    signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'partial', durationMs: 10 }))
    gate.promise.then(() => resolve({ ok: true, status: 'success', exitCode: 0, finalText: 'done after end_round', durationMs: 20 }))
  })
  // leader GPT ends the round while Cursor is still working — discussion stops; Cursor must keep running
  const f = await setup({
    runCursor,
    seats: [
      { id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'd' },
      { id: 'gk', name: 'Grok', provider: 'xai', model: 'g' },
      { id: 'gpt', name: 'GPT', provider: 'openai', model: 'gpt', leader: true },
    ],
    by: 'gpt',
    script: [
      { text: '等 Cursor。', toolCalls: [tc('e1', 'end_round', { reason: 'Cursor is running; wait for the sheet.' })] },
      { text: '本轮到此。', usage: {} },
      { text: '交卷后继续。', usage: {} },
    ],
  })
  try {
    // Start discussion first (so a seat can call end_round), then start Cursor without going through post「执行」
    // (post「执行」interrupts seats by design; executeBrief alone leaves the discussion loop alone).
    const disc = await f.moderator.post(f.room.id, '先讨论，Cursor 随后跑', { owner: true })
    await until(() => f.calls.length >= 1)
    const cursorP = f.moderator.executeBrief(f.room.id, f.briefId)
    await until(() => cursorCard(f))
    await until(() => seenSignal)
    assert.equal(seenSignal.aborted, false)
    assert.equal(f.moderator.status(f.room.id).cursor?.briefId, 'bt001')
    // Wait until end_round took effect (discussion run finished with reason ended)
    await until(() => f.events.some((e) => e.type === 'run' && e.running === false && e.reason === 'ended'))
    assert.equal(seenSignal.aborted, false, 'end_round must not abort Cursor')
    const still = await cursorCard(f)
    assert.equal(still.data.cursorTask.status, 'running')
    assert.ok(!still.data.blank)
    gate.resolve()
    const card = await cursorP
    assert.equal(card.data.cursorTask.status, 'done')
    assert.equal(card.data.blank, undefined)
    assert.match(card.data.title, /已完成/)
    await disc.promise
  } finally { await f.done() }
})

test('cursor card: stopAll (DSH dispose) blanks running Cursor as 状态未知 / shutdown — distinct from end_round', async () => {
  let seenSignal
  const runCursor = (_b, { signal }) => new Promise((resolve) => {
    seenSignal = signal
    signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'x', durationMs: 5 }))
  })
  const f = await setup({ runCursor })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    await until(() => cursorCard(f))
    await until(() => seenSignal)
    await f.moderator.stopAll()
    const card = await ex.cursor
    assert.equal(card.data.blank, true)
    assert.equal(card.data.cursorTask.status, 'shutdown')
    assert.equal(card.text, 'DSH 关闭时任务被中止，工作区可能已有改动')
    assert.match(card.data.title, /状态未知/)
  } finally { await f.done() }
})

test('cursor: changedBetween / cursorReport / summary lines', () => {
  assert.equal(changedBetween([' M a'], null), null)
  assert.deepEqual(changedBetween([' M a', ' M b'], [' M a', 'M  b', '?? c']), ['M  b', '?? c'])
  assert.deepEqual(changedBetween([' M gone'], []), ['(clean) gone'])
  const r = cursorReport({ status: 'success', exitCode: 0, durationMs: 2400, toolCalls: 2, changedFiles: [], finalText: 'Done.' }, { briefId: 'b1', title: 'T', repo: 'S:\\r' })
  assert.match(r, /Cursor task #b1 — T/); assert.match(r, /\(no changes\)/); assert.match(r, /Done\./)
  assert.match(toolSummaryLine({ tool: 'cursor_handoff', data: { status: 'running', briefId: 'b1', briefTitle: 'Add A', title: 'Cursor 任务 #b1 · r · 进行中' } }), /开始执行：Add A$/)
  assert.match(toolSummaryLine({ tool: 'cursor_handoff', data: { status: 'cancelled', briefId: 'b1' } }), /已取消/)
  assert.match(toolSummaryLine({ tool: 'cursor_handoff', data: { status: 'fused', briefId: 'b1' } }), /已熔断/)
})

test('cursor session record: listRoomBriefs labels + continuable flags', () => {
  assert.equal(isBriefContinuable('awaiting_owner'), true)
  assert.equal(isBriefContinuable('interrupted'), true)
  assert.equal(isBriefContinuable('shutdown'), true)
  assert.equal(isBriefContinuable('fused'), true)
  assert.equal(isBriefContinuable('no_result'), true)
  assert.equal(isBriefContinuable('timeout'), true)
  assert.equal(isBriefContinuable('aborted'), true)
  assert.equal(isBriefContinuable('running'), false)
  assert.equal(isBriefContinuable('success'), false)
  assert.equal(briefStatusLabel('interrupted'), '状态未知（已中断）')
  assert.equal(briefStatusLabel('shutdown'), '状态未知（已中断）')
  assert.equal(briefStatusLabel('no_result'), '无结果')
  assert.equal(briefStatusLabel('timeout'), '超时')
  assert.equal(briefStatusLabel('aborted'), '已中止')
  assert.equal(briefStatusLabel('awaiting_owner'), '待执行')
  assert.ok(CURSOR_BRIEF_CONTINUABLE.has('interrupted'))
  assert.ok(CURSOR_BRIEF_CONTINUABLE.has('no_result'))
  const listed = listRoomBriefs({
    pendingBrief: 'b2',
    briefs: {
      b1: { title: 'Old done', status: 'success', by: 'ds', at: '2026-01-01T00:00:00.000Z', cardId: 'c1' },
      b2: { title: 'Interrupted', status: 'interrupted', by: 'gk', at: '2026-01-02T00:00:00.000Z', cardId: 'c2', msgId: 'm2' },
      b3: { title: 'Waiting', status: 'awaiting_owner', by: 'ds', at: '2026-01-03T00:00:00.000Z' },
    },
  }, { seats: SEATS })
  assert.equal(listed.pendingBrief, 'b2')
  assert.equal(listed.items.length, 3)
  assert.equal(listed.items[0].id, 'b3') // newest first by at
  assert.equal(listed.items[1].id, 'b2')
  assert.equal(listed.items[1].continuable, true)
  assert.equal(listed.items[1].statusLabel, '状态未知（已中断）')
  assert.equal(listed.items[1].byName, 'Grok')
  assert.equal(listed.items[1].pending, true)
  assert.equal(listed.items[2].continuable, false)
  assert.equal(listed.items.find((x) => x.id === 'b3').cancellable, true)
})

test('cursor session record: 继续 after recoverCursorRuns requeues interrupted → running without meta surgery', async () => {
  const gate = deferred()
  const f = await setup({ runCursor: async () => { await gate.promise; return { ok: true, status: 'success', exitCode: 0, finalText: 'ok', durationMs: 12 } } })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    await until(() => cursorCard(f))
    await until(async () => (await f.store.getRoom(f.room.id)).briefs.bt001.cardId)
    const fresh = createModerator({
      store: createStore(f.dir),
      getRoomConfig: async () => ({ seats: SEATS, userName: 'Shiro', budget: 3, tools: {}, cursorRepo: f.dir }),
      call: async () => ({ text: '[PASS]' }),
      runCursor: async () => ({ ok: true, status: 'success', exitCode: 0, finalText: 'resumed', durationMs: 9, sessionId: 's-resume' }),
      emit: () => {},
    })
    assert.equal(await fresh.recoverCursorRuns(), 1)
    const meta = await f.store.getRoom(f.room.id)
    assert.equal(meta.briefs.bt001.status, 'interrupted')
    const listed = listRoomBriefs(meta, { seats: SEATS })
    const row = listed.items.find((x) => x.id === 'bt001')
    assert.ok(row)
    assert.equal(row.continuable, true)
    assert.match(row.statusLabel, /状态未知/)
    // One-click continue ≡ 「执行 <id>」: no hand patch of meta.json
    const cont = await fresh.executeBrief(f.room.id, 'bt001')
    assert.ok(cont)
    const card = await cont
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'success')
    assert.equal(card.data.cursorTask.status, 'done')
    assert.match(card.data.title, /已完成/)
    gate.resolve(); await ex.cursor.catch(() => {})
  } finally { await f.done() }
})

test('cursor session record: 继续 after stopAll shutdown status', async () => {
  let seenSignal
  const runCursor = (_b, { signal }) => new Promise((resolve) => {
    seenSignal = signal
    signal.addEventListener('abort', () => resolve({ ok: false, status: 'aborted', exitCode: null, finalText: 'x', durationMs: 5 }))
  })
  const f = await setup({ runCursor })
  try {
    const ex = await f.moderator.post(f.room.id, '执行', { owner: true })
    await until(() => cursorCard(f))
    await until(() => seenSignal)
    await f.moderator.stopAll()
    await ex.cursor
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'shutdown')
    const listed = listRoomBriefs(await f.store.getRoom(f.room.id), { seats: SEATS })
    assert.equal(listed.items.find((x) => x.id === 'bt001').continuable, true)
    const run2 = async () => ({ ok: true, status: 'success', exitCode: 0, finalText: 'again', durationMs: 8 })
    // Re-bind runCursor by creating a sibling moderator on same store is awkward; call executeBrief on same moderator after swapping is not exposed.
    // Instead: patch status stays shutdown, executeBrief on same moderator with new runCursor via fresh instance.
    const fresh = createModerator({
      store: f.store,
      getRoomConfig: async () => ({ seats: SEATS, userName: 'Shiro', budget: 3, tools: {}, cursorRepo: f.dir }),
      call: async () => ({ text: '[PASS]' }),
      runCursor: run2,
      emit: () => {},
    })
    const card = await fresh.executeBrief(f.room.id, 'bt001')
    assert.ok(card)
    assert.equal((await f.store.getRoom(f.room.id)).briefs.bt001.status, 'success')
    assert.equal(card.data.cursorTask.status, 'done')
  } finally { await f.done() }
})
