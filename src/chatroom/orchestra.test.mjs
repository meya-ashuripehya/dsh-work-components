import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { resolveSeats } from './seats.mjs'
import { buildPrompt } from './transcript.mjs'
import { createTask, nextSpeaker, recordTurn, extendBudget, staleness } from './scheduler.mjs'
import { parseHandoff, parseMention, parseOwnerCommand, parseCursorDirective, parseStaleDecision, isPass } from './directives.mjs'
import { parseCursorLine, normalizeHandoffArgs, runCursorAgent, cursorDeeplink, jsonSafe, CURSOR_TOOL, planText, briefRelayLine } from './cursor.mjs'
import { createTelegramBots, splitForTelegram } from './telegram-bots.mjs'
import { channelTokenRefs, collectTokenValues } from '../channels/telegram/accounts.mjs'
import { isJsonValue } from '../../vendor/dsh-tools/util-values.js'

const SEATS = resolveSeats({ chatroomSeats: [
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', model: 'ds', talents: '中文写作, 数学', prefer: '算法', never: '政治' },
  { id: 'claude', name: 'Claude', provider: 'anthropic', model: 'c', talents: '代码审查' },
  { id: 'gpt', name: 'GPT', provider: 'openai', model: 'g', leader: true },
  { id: 'gemini', name: 'Gemini', provider: 'google', model: 'gm' },
  { id: 'grok', name: 'Grok', provider: 'xai', model: 'x', enabled: false },
] })
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-orch-'))

// ── 解析 ──
test('directives: mention, handoff (explicit + natural), owner commands, PASS, stale decision, cursor directive', () => {
  assert.equal(parseMention('@gemini 你来看看', SEATS).id, 'gemini')
  assert.equal(parseMention('邮件 a@b.com', SEATS), null)
  assert.equal(parseMention('没有提及', SEATS), null)
  let h = parseHandoff('我觉得这个适合 Gemini。[[NEXT: Gemini]]', SEATS, 'deepseek')
  assert.equal(h.seat.id, 'gemini'); assert.equal(h.text, '我觉得这个适合 Gemini。')
  assert.equal(parseHandoff('这个交给 Claude 来审查', SEATS, 'deepseek').seat.id, 'claude')
  assert.equal(parseHandoff('let Gemini take this one', SEATS, 'gpt').seat.id, 'gemini')
  assert.equal(parseHandoff('handing it over to GPT', SEATS, 'claude').seat.id, 'gpt')
  assert.equal(parseHandoff('[[NEXT: DeepSeek]]', SEATS, 'deepseek').seat, null) // 不能交给自己
  assert.equal(parseHandoff('[[NEXT: Nobody]] hi', SEATS, 'gpt').seat, null)
  assert.deepEqual(parseOwnerCommand('批准 +3'), { kind: 'approve', n: 3 })
  assert.deepEqual(parseOwnerCommand('批准+12'), { kind: 'approve', n: 12 })
  assert.deepEqual(parseOwnerCommand('执行'), { kind: 'execute' })
  assert.deepEqual(parseOwnerCommand('执行 babc12'), { kind: 'execute', briefId: 'babc12' })
  assert.deepEqual(parseOwnerCommand('执行babc12'), { kind: 'execute', briefId: 'babc12' })
  assert.deepEqual(parseOwnerCommand('执行#be0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.deepEqual(parseOwnerCommand('executebe0cv5nz'), { kind: 'execute', briefId: 'be0cv5nz' })
  assert.equal(parseOwnerCommand('请执行这个方案'), null)
  assert.ok(isPass('[PASS]') && isPass('') && !isPass('[PASS] 但是我还有很长很长很长的话'))
  assert.deepEqual(parseStaleDecision('DROP'), { action: 'drop' })
  assert.deepEqual(parseStaleDecision('REVISE: 新的'), { action: 'revise', text: '新的' })
  assert.deepEqual(parseStaleDecision('SEND'), { action: 'send' })
  const d = parseCursorDirective('好的。[[CURSOR_HANDOFF {"action":"brief","brief":"Do the thing {with braces}"}]] 完')
  assert.deepEqual(d.args, { action: 'brief', brief: 'Do the thing {with braces}' }); assert.equal(d.text, '好的。 完')
  assert.ok(parseCursorDirective('[[CURSOR_HANDOFF {bad json}]]').error)
  assert.equal(parseCursorDirective('nothing'), null)
})

// ── 调度 ──
test('scheduler: main first, then sequential poll; full-pass round ends; spoke → another round without back-to-back', () => {
  const t = createTask({ id: 't', seats: SEATS, mainId: 'deepseek' })
  assert.deepEqual(t.order, ['deepseek', 'claude', 'gpt', 'gemini'])
  const seq = []
  const outcomes = { claude: ['spoke', 'pass'], gpt: ['pass', 'pass'], gemini: ['pass', 'pass'], deepseek: ['spoke', 'pass'] }
  for (let id; (id = nextSpeaker(t));) { seq.push(id); recordTurn(t, id, outcomes[id].shift()) }
  // main → poll(claude spoke, gpt, gemini) → round 2 (deepseek, gpt, gemini; claude was last but is not skipped after others) …
  assert.equal(seq[0], 'deepseek')
  assert.deepEqual(seq.slice(1, 4), ['claude', 'gpt', 'gemini'])
  assert.notEqual(seq[4], 'claude')
  assert.equal(t.state, 'done')
  assert.ok(t.used <= 10)
})

test('scheduler: @main, handoff routes next speaker, budget exhaustion and 批准 +N', () => {
  const t = createTask({ id: 't', seats: SEATS, mainId: 'gemini', budget: 3 })
  assert.equal(nextSpeaker(t), 'gemini')
  recordTurn(t, 'gemini', 'spoke', { handoffTo: 'gpt' })
  assert.equal(nextSpeaker(t), 'gpt')
  recordTurn(t, 'gpt', 'spoke')
  assert.equal(nextSpeaker(t), 'deepseek')
  recordTurn(t, 'deepseek', 'spoke')
  assert.equal(nextSpeaker(t), null)
  assert.equal(t.state, 'budget')
  extendBudget(t, 2)
  assert.equal(t.state, 'running'); assert.equal(t.budget, 5)
  const a = nextSpeaker(t); recordTurn(t, a, 'pass')
  const b = nextSpeaker(t); recordTurn(t, b, 'pass')
  assert.equal(nextSpeaker(t), null); assert.equal(t.state, 'budget'); assert.equal(t.used, 5)
})

test('scheduler: staleness verdicts', () => {
  const msgs = [
    { seq: 1, kind: 'user', speaker: { id: 'user' } },
    { seq: 2, kind: 'seat', speaker: { id: 'claude' }, status: 'ok' },
    { seq: 3, kind: 'seat', speaker: { id: 'gpt' }, status: 'pass' },
  ]
  assert.equal(staleness(3, msgs, 'deepseek').verdict, 'fresh')
  assert.equal(staleness(2, msgs, 'deepseek').verdict, 'fresh') // 只有 PASS → 不算
  assert.equal(staleness(1, msgs, 'deepseek').verdict, 'review')
  assert.equal(staleness(0, msgs, 'deepseek').verdict, 'redirect')
  assert.equal(staleness(1, [...msgs, { seq: 4, kind: 'tool', speaker: { id: 'cursor' } }], 'deepseek').verdict, 'review')
})

test('transcript: role rules, roster with talents/preferences, tool output visible to everyone, leader instructions', () => {
  const msgs = [
    { seq: 1, kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: '设计一下', status: 'ok' },
    { seq: 2, kind: 'tool', tool: 'cursor_handoff', speaker: { id: 'gpt', name: 'GPT' }, text: 'done', data: { ok: true, diffStat: '1 file changed' }, status: 'ok' },
  ]
  const p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs, mainName: 'DeepSeek' })
  assert.match(p.system, /shared house/); assert.match(p.system, /in character/); assert.match(p.system, /Reply in Chinese/)
  assert.ok(!/planning|NOT the implementer|budget|turns? used/i.test(p.system))
  assert.match(p.system, /Don't rewrite this computer \(shell, file writes, settings, desktop control\)/)
  assert.match(p.system, /Reading, searching, drafting, cards, and other non-destructive room tools are fine/)
  assert.ok(!/This task was raised by Shiro \(the owner\)/.test(p.system))
  const ownerPrompt = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs, mainName: 'DeepSeek', toolsInfo: { owner: true } })
  assert.match(ownerPrompt.system, /This task was raised by Shiro \(the owner\): you may use tools that change the computer/)
  assert.ok(!/Don't rewrite this computer/.test(ownerPrompt.system))
  assert.match(p.system, /- DeepSeek — good at 中文写作, 数学; likes 算法; stays out of 政治/)
  assert.match(p.system, /- DeepSeek answers first this time\./)
  assert.ok(!/Grok/.test(p.system.split("Who's home")[1]))
  assert.ok(!/view_attachment|Pictures|Tools are optional/.test(p.system)) // 没有图片 / 工具时不提
  assert.match(p.messages[0].content, /\[tool:cursor_handoff by GPT\] done\n\{"ok":true,"diffStat":"1 file changed"\}/)
  assert.ok(!/cursor_handoff with action/.test(p.system))
  assert.match(buildPrompt({ seat: SEATS[2], seats: SEATS, userName: 'Shiro', messages: msgs }).system, /You also write the Cursor task briefs/)
})

// ── 主持人（端到端，模拟模型 / Telegram / Cursor）──
function fixture({ script = {}, budget = 10, seats = SEATS, runCursor, hooks = {} } = {}) {
  return (async () => {
    const dir = await tmp()
    const store = createStore(dir)
    const room = await store.createRoom({})
    const seen = []
    const active = new Set()
    let maxActive = 0
    const relayed = []
    const typing = []
    const call = async ({ seat, prompt, signal, tools, onDelta }) => {
      active.add(seat.id); maxActive = Math.max(maxActive, active.size)
      seen.push({ seat: seat.id, prompt, tools })
      try {
        await hooks.before?.(seat, prompt)
        const step = script[seat.id]?.shift?.() ?? 'pass'
        if (typeof step === 'function') return await step({ seat, prompt, signal })
        if (step === 'pass') return { text: '[PASS]', usage: {} }
        if (step === 'error') throw new Error('boom')
        onDelta?.('x')
        return { text: typeof step === 'string' && step !== 'ok' ? step : `${seat.name} 回答`, usage: {} }
      } finally { active.delete(seat.id) }
    }
    const tg = {
      typing: (seat) => { typing.push(['start', seat.id]); return () => typing.push(['stop', seat.id]) },
      relay: async (seat, _room, text, o) => { relayed.push({ seat: seat?.id || null, text, prefix: o?.prefixName }); return [] },
    }
    const mod = createModerator({ store, call, tg, runCursor, getRoomConfig: () => ({ seats, userName: 'Shiro', maxTokens: 100, budget, defaultMain: 'deepseek', cursorRepo: dir }) })
    return { dir, store, room, mod, seen, relayed, typing, maxActive: () => maxActive, done: () => rm(dir, { recursive: true, force: true }) }
  })()
}

test('moderator: DeepSeek main by default, others polled one at a time, PASS silent, AI replies written then relayed via own bot', async () => {
  const f = await fixture({ script: { claude: ['pass'], gpt: ['GPT 补充一点'], gemini: ['pass', 'pass'], deepseek: ['ok', 'pass'] } })
  try {
    const { promise } = await f.mod.post(f.room.id, '你好')
    assert.equal(await promise, 'done')
    assert.deepEqual(f.seen.map((x) => x.seat).slice(0, 4), ['deepseek', 'claude', 'gpt', 'gemini'])
    assert.equal(f.maxActive(), 1)
    const msgs = await f.store.readMessages(f.room.id)
    assert.ok(msgs.some((m) => m.speaker.id === 'claude' && m.status === 'pass'))
    assert.ok(!f.relayed.some((r) => /PASS/.test(r.text)))
    assert.deepEqual(f.relayed.filter((r) => r.seat).map((r) => r.seat), ['deepseek', 'gpt'])
    assert.equal(f.relayed[0].prefix, 'Shiro') // 本地用户消息经接收机器人转发
    assert.ok(msgs.filter((m) => m.kind === 'seat').every((m) => typeof m.basedOn === 'number'))
    assert.deepEqual(f.typing.slice(0, 2), [['start', 'deepseek'], ['stop', 'deepseek']])
    assert.ok(f.seen.find((x) => x.seat === 'gpt').tools === undefined) // 无 runCursor 时不给工具
  } finally { await f.done() }
})

test('moderator: @Gemini becomes main; handoff routes to named AI', async () => {
  const f = await fixture({ script: { gemini: ['我先答。[[NEXT: Claude]]'], claude: ['Claude 接手'] } })
  try {
    const { promise } = await f.mod.post(f.room.id, '@Gemini 帮我看看')
    await promise
    assert.deepEqual(f.seen.slice(0, 2).map((x) => x.seat), ['gemini', 'claude'])
    const g = (await f.store.readMessages(f.room.id)).find((m) => m.speaker.id === 'gemini')
    assert.equal(g.text, '我先答。'); assert.equal(g.handoffTo, 'claude')
    assert.match(f.seen[0].prompt.system, /You answer first this time/)
  } finally { await f.done() }
})

test('moderator: budget of 10 turns is invisible to AIs; exhausted → UI-only notice; owner 批准 +N / 批准 extends silently', async () => {
  const always = Array.from({ length: 60 }, () => 'ok')
  const f = await fixture({ script: { deepseek: [...always], claude: [...always], gpt: [...always], gemini: [...always] } })
  try {
    const { promise } = await f.mod.post(f.room.id, '讨论到底')
    assert.equal(await promise, 'budget')
    const st = f.mod.status(f.room.id).task
    assert.equal(st.used, 10); assert.equal(st.state, 'budget')
    assert.equal(f.seen.length, 10) // 不再请主答汇报
    for (const x of f.seen) assert.ok(!/budget|turns? used|批准|回合/i.test(x.prompt.system + JSON.stringify(x.prompt.messages)))
    let msgs = await f.store.readMessages(f.room.id)
    assert.equal(msgs.at(-1).kind, 'system'); assert.equal(msgs.at(-1).text, '本轮已达回合上限（10/10），回复「批准 +N」继续。')
    assert.ok(f.relayed.some((r) => r.seat === null && /回合上限/.test(r.text))) // Telegram 群也收到
    // 非所有者的「批准」只是普通消息
    const before = msgs.length
    await f.mod.post(f.room.id, '批准 +2', { owner: false, source: 'telegram', fromId: '42', userName: 'Mallory', run: false })
    msgs = await f.store.readMessages(f.room.id)
    assert.equal(msgs.at(-1).kind, 'user'); assert.equal(msgs.at(-1).text, '批准 +2'); assert.equal(msgs.length, before + 1)
    assert.equal(f.mod.status(f.room.id).task.budget, 10)
    // 所有者：不写入用户消息，只有一条系统提示；继续 2 个回合
    const r = await f.mod.post(f.room.id, '批准＋２', { owner: true })
    assert.equal(r.message, null); assert.equal(r.control, 'approve')
    assert.equal(await r.promise, 'budget')
    assert.equal(f.mod.status(f.room.id).task.used, 12)
    assert.equal(f.seen.length, 12)
    msgs = await f.store.readMessages(f.room.id)
    assert.ok(!msgs.some((m) => m.kind === 'user' && /批准＋２/.test(m.text)))
    assert.ok(msgs.some((m) => m.kind === 'system' && /已批准追加 2 个回合（10\/12）/.test(m.text)))
    // 只说「批准」= 追加 3 个回合；之后 AI 的提示词里仍看不到任何批准 / 预算内容
    const r2 = await f.mod.post(f.room.id, '批准', { owner: true })
    assert.equal(await r2.promise, 'budget')
    assert.equal(f.mod.status(f.room.id).task.used, 15)
    const last = f.seen.at(-1).prompt
    const seenText = last.system + last.messages.map((m) => m.content).join('\n')
    assert.ok(!/已批准|回合上限|budget|批准＋２/i.test(seenText))
    assert.equal((seenText.match(/批准/g) || []).length, 1) // 只有 Mallory 的普通消息
  } finally { await f.done() }
})

test('moderator: staleness — only AI messages arrived → speaker chooses SEND/REVISE/DROP; new user message → dropped and redirected', async () => {
  let gate
  const f = await fixture({
    seats: SEATS.slice(0, 2),
    script: {
      deepseek: [async () => { await new Promise((r) => { gate = r }); return { text: 'DeepSeek 旧稿' } }, 'REVISE: DeepSeek 新稿', 'pass', 'pass'],
      claude: ['pass', 'pass', 'pass'],
    },
  })
  try {
    const { promise } = await f.mod.post(f.room.id, '问题一')
    await new Promise((r) => setTimeout(r, 20))
    // 生成期间一条 AI 消息进入房间（例如工具输出）
    await f.store.append(f.room.id, { kind: 'seat', speaker: { id: 'claude', name: 'Claude' }, text: '我插一句', status: 'ok' })
    gate()
    await promise
    const msgs = await f.store.readMessages(f.room.id)
    const ds = msgs.filter((m) => m.speaker.id === 'deepseek' && m.status === 'ok')
    assert.equal(ds[0].text, 'DeepSeek 新稿')
    assert.match(f.seen[1].prompt.messages.at(-1).content, /Your unsent draft was:\n<<<\nDeepSeek 旧稿[\s\S]*SEND[\s\S]*DROP[\s\S]*REVISE/)
  } finally { await f.done() }

  let gate2
  const g = await fixture({ seats: SEATS.slice(0, 2), script: { deepseek: [async () => { await new Promise((r) => { gate2 = r }); return { text: '对问题一的回答' } }, '对问题二的回答', 'pass'], claude: ['pass', 'pass'] } })
  try {
    const { promise } = await g.mod.post(g.room.id, '问题一')
    await new Promise((r) => setTimeout(r, 20))
    const second = await g.mod.post(g.room.id, '算了，问题二')
    assert.equal(second.started, false)
    gate2()
    await promise
    const msgs = await g.store.readMessages(g.room.id)
    assert.ok(msgs.some((m) => m.status === 'dropped' && m.text === '对问题一的回答'))
    assert.ok(msgs.some((m) => m.status === 'ok' && m.text === '对问题二的回答'))
    assert.ok(!g.relayed.some((r) => r.text === '对问题一的回答'))
  } finally { await g.done() }
})

test('moderator: GPT leader cursor_handoff (native tool call) → brief awaiting owner; 执行 only by owner; result JSON lossless in room', async () => {
  const runs = []
  const runCursor = async (b, { onProgress }) => { runs.push(b); onProgress({ kind: 'tool', text: 'read src/a.mjs' }); return { ok: true, status: 'success', exitCode: 0, sessionId: 'sess-1', finalText: 'Done.', diffStat: ' a.mjs | 2 +-\n 1 file changed', toolCalls: 1 } }
  const f = await fixture({
    runCursor,
    script: {
      deepseek: ['方案 A', 'pass'], claude: ['同意', 'pass'], gemini: ['同意', 'pass'],
      gpt: [() => ({ text: '大家都同意，我来写任务书。', toolCalls: [{ id: 'c1', name: 'cursor_handoff', arguments: JSON.stringify({ action: 'brief', title: 'Add A', brief: 'Implement plan A in src/a.mjs. Do not commit.' }) }] }), 'pass'],
    },
  })
  try {
    const { promise } = await f.mod.post(f.room.id, '定方案')
    await promise
    assert.deepEqual(f.seen.find((x) => x.seat === 'gpt').tools, [CURSOR_TOOL])
    assert.equal(f.seen.find((x) => x.seat === 'claude').tools, undefined)
    let meta = await f.store.getRoom(f.room.id)
    const id = meta.pendingBrief
    assert.ok(id); assert.equal(meta.briefs[id].status, 'awaiting_owner')
    let msgs = await f.store.readMessages(f.room.id)
    const brief = msgs.find((m) => m.kind === 'brief')
    assert.match(brief.deeplink, /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=Implement/)
    assert.ok(f.relayed.some((r) => /任务书 #.*待所有者回复「执行」/.test(r.text)))
    assert.ok(f.relayed.some((r) => /📋 任务书/.test(r.text) && /Implement plan A in src\/a\.mjs/.test(r.text)), 'brief body should reach Telegram')
    // 非所有者「执行」
    await f.mod.post(f.room.id, '执行', { owner: false, source: 'telegram', fromId: '1', userName: 'X' })
    assert.equal(runs.length, 0)
    const ex = await f.mod.post(f.room.id, '执行', { owner: true, source: 'telegram', fromId: '9000000001' })
    await ex.cursor
    assert.equal(runs.length, 1); assert.equal(runs[0].brief, 'Implement plan A in src/a.mjs. Do not commit.')
    meta = await f.store.getRoom(f.room.id)
    assert.equal(meta.briefs[id].status, 'success'); assert.equal(meta.briefs[id].sessionId, 'sess-1')
    // 交卷后唤醒的一轮跑完
    for (let i = 0; i < 200 && f.mod.status(f.room.id).running; i++) await new Promise((r) => setTimeout(r, 10))
    msgs = await f.store.readMessages(f.room.id)
    const result = msgs.find((m) => m.kind === 'tool' && m.data?.cursorTask)
    assert.equal(result.speaker.id, 'gpt'); assert.equal(result.data.cursorTask.status, 'done')
    assert.ok(isJsonValue(result.data)); assert.equal(result.data.diffStat, ' a.mjs | 2 +-\n 1 file changed'); assert.equal(result.data.sessionId, 'sess-1')
    assert.match(result.data.title, /^Cursor 任务 #.+ · .+ · 已完成$/)
    assert.equal(msgs.find((m) => m.kind === 'brief').briefStatus, 'success')
    const tgLine = f.relayed.find((r) => /已完成，退出码/.test(r.text)).text
    assert.match(tgLine, /已完成，退出码 0；1 file changed/); assert.ok(!tgLine.includes('\n'))
    assert.ok(!f.relayed.some((r) => /交卷/.test(r.text)))
    // 卡片对所有 AI 可见（无结果文件时报告直接进提示词），交卷提示也可见
    const p = buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: msgs })
    const all = p.messages.map((x) => x.content).join('\n')
    assert.match(all, /\[card by GPT · Cursor 任务 #[^\]]*已完成\][\s\S]*Done\./)
    assert.match(all, /handed in its sheet/)
  } finally { await f.done() }
})

test('cursor: handoff args, stream-json parsing, deeplink, jsonSafe', () => {
  assert.ok(normalizeHandoffArgs({ action: 'x', brief: 'long enough brief' }).error)
  assert.ok(normalizeHandoffArgs({ action: 'brief', brief: 'long enough brief' }).error) // 无仓库
  const h = normalizeHandoffArgs('{"action":"read","brief":"Summarise the store module","repo":"S:\\\\r"}')
  assert.equal(h.action, 'read'); assert.equal(h.repo, 'S:\\r')
  assert.match(planText(h), /READ-ONLY TASK/)
  assert.equal(parseCursorLine('{"type":"system","subtype":"init","session_id":"abc"}').sessionId, 'abc')
  const tc = parseCursorLine('{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a.txt"}}}}')
  assert.equal(tc.tool, 'read'); assert.equal(tc.summary, 'a.txt')
  const r = parseCursorLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"abc"}')
  assert.equal(r.success, true); assert.equal(r.result, 'ok')
  assert.equal(parseCursorLine('S:\\Anaconda\\lib\\site-packages\\requests warning'), null)
  assert.equal(cursorDeeplink('a b&c'), 'cursor://anysphere.cursor-deeplink/prompt?text=a%20b%26c')
  assert.match(briefRelayLine({ briefId: 'b1', title: 'T', text: 'Do the thing' }), /📋 任务书 #b1 · T[\s\S]*Do the thing/)
  assert.deepEqual(jsonSafe({ a: undefined, b: NaN, c: [1] }), { b: null, c: [1] })
})

test('cursor: runCursorAgent with a fake agent — stdin plan, completion = result + exit, session id, diff stat, timeout kill', async () => {
  const dir = await tmp()
  try {
    const fake = join(dir, 'fake-agent.mjs')
    await writeFile(fake, `
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
  if (process.argv.includes('--hang')) { setInterval(()=>{}, 1000); return }
  console.error('S:\\\\Anaconda\\\\lib\\\\site-packages\\\\requests\\\\__init__.py:78: RequestsDependencyWarning: x')
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'s-42'}))
  console.log(JSON.stringify({type:'tool_call',subtype:'started',tool_call:{writeToolCall:{args:{path:'x.txt'}}}}))
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'got '+input.length+' chars: '+(input.includes('中文')?'utf8 ok':'bad'),session_id:'s-42'}))
});`)
    const progress = []
    const spawnImpl = (cmd, args, o) => require_spawn()(process.execPath, [fake, ...args], { ...o, shell: false })
    const res = await runCursorAgent({ agentPath: 'cursor-agent', handoff: { action: 'brief', title: 't', repo: dir, brief: '中文 plan '.repeat(2000) }, onProgress: (p) => progress.push(p), spawnImpl })
    assert.equal(res.status, 'success'); assert.equal(res.exitCode, 0); assert.equal(res.sessionId, 's-42')
    assert.match(res.finalText, /utf8 ok/); assert.ok(Number(res.finalText.match(/got (\d+)/)[1]) > 8192)
    assert.ok(progress.some((p) => p.kind === 'tool' && /write x.txt/.test(p.text)))
    assert.ok(!/Anaconda/.test(res.stderrTail || '')); assert.ok(isJsonValue(res))
    const hang = await runCursorAgent({ agentPath: 'x', handoff: { action: 'brief', title: 't', repo: dir, brief: 'hang please', resume: '' }, timeoutMs: 300, spawnImpl: (c, a, o) => require_spawn()(process.execPath, [fake, '--hang'], { ...o, shell: false }) })
    assert.equal(hang.status, 'timeout')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
import { spawn as nodeSpawn } from 'node:child_process'
function require_spawn() { return nodeSpawn }

test('telegram bots: relay via each AI\'s own bot, fallback with name prefix, typing, single ingest bot, bound chats only, own bots ignored; shared token delegates to channel', async () => {
  const calls = []
  const updates = [
    { update_id: 1, message: { message_id: 1, chat: { id: -1001, type: 'supergroup' }, from: { id: 9000000001, first_name: 'Shiro' }, text: '大家好' } },
    { update_id: 2, message: { message_id: 2, chat: { id: -999, type: 'group' }, from: { id: 5, first_name: 'X' }, text: '别的群' } },
    { update_id: 3, message: { message_id: 3, chat: { id: -1001, type: 'supergroup' }, from: { id: 111, is_bot: true, first_name: 'DS' }, text: '我自己的' } },
  ]
  let served = false
  const fetchImpl = async (url, init) => {
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(url)
    const body = JSON.parse(init.body)
    calls.push({ token, method, body })
    if (method === 'getUpdates') {
      if (token === tokens.CHATROOM_BOT_DEEPSEEK_TOKEN && !served) {
        served = true
        return { json: async () => ({ ok: true, result: updates }) }
      }
      await new Promise((r, j) => init.signal?.addEventListener('abort', () => j(new Error('aborted'))))
    }
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 111, username: 'ds_bot', can_read_all_group_messages: true } }) }
    return { json: async () => ({ ok: true, result: { message_id: 9 } }) }
  }
  const tokens = { CHATROOM_BOT_DEEPSEEK_TOKEN: '111:aaaaaaaaaaaaaaaaaaaaaaaa', CHATROOM_BOT_CLAUDE_TOKEN: '222:bbbbbbbbbbbbbbbbbbbbbbbb' }
  const seats = resolveSeats({ chatroomSeats: [{ id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true } }, { id: 'claude', name: 'Claude', telegram: { ingest: true } }, { id: 'gpt', name: 'GPT' }] })
  assert.equal(seats.filter((s) => s.telegram.ingest).length, 1)
  const inbound = []
  const bots = createTelegramBots({ resolveToken: async (r) => tokens[r], getSeats: () => seats, fetchImpl, onInbound: (u) => inbound.push(u) })
  await bots.relay(seats[1], ['-1001'], 'Claude 的话')
  assert.deepEqual(calls.at(-1), { token: tokens.CHATROOM_BOT_CLAUDE_TOKEN, method: 'sendMessage', body: { chat_id: '-1001', text: 'Claude 的话', disable_web_page_preview: true } })
  await bots.relay(seats[2], ['-1001'], 'GPT 没有机器人', { prefixName: 'GPT' })
  assert.equal(calls.at(-1).token, tokens.CHATROOM_BOT_DEEPSEEK_TOKEN); assert.equal(calls.at(-1).body.text, '[GPT] GPT 没有机器人')
  const stop = bots.typing(seats[0], ['-1001'])
  await new Promise((r) => setTimeout(r, 10)); stop()
  assert.ok(calls.some((c) => c.method === 'sendChatAction' && c.body.action === 'typing'))
  await bots.startIngest(() => new Set(['-1001']))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(inbound.map((u) => `${u.chatId}:${u.fromId}:${u.text}`), ['-1001:9000000001:大家好'])
  assert.ok(calls.some((c) => c.method === 'getUpdates' && c.token === tokens.CHATROOM_BOT_DEEPSEEK_TOKEN))
  bots.stopIngest()
  // 通道已占用同一令牌 → 委托，不自拉，不报错
  const b2 = createTelegramBots({
    resolveToken: async (r) => tokens[r], getSeats: () => seats, fetchImpl, onInbound: () => {},
    channelOwnsToken: async (t) => t === tokens.CHATROOM_BOT_DEEPSEEK_TOKEN,
  })
  const st = await b2.startIngest(() => new Set())
  assert.equal(st.error, '')
  assert.equal(st.mode, 'delegated')
  assert.equal(st.polling, false)
  b2.stopIngest()
  assert.equal(splitForTelegram('a'.repeat(9000)).length, 3)
})

// ── 发现群聊 / 群内 /bind ──
import { parseGroupCommand } from './telegram-bots.mjs'
import { createChatroomFeature } from './index.mjs'
import { createDiscovered } from './discovered.mjs'

test('group commands: /bind, /bind 房间名, /bind@bot, /unbind; other bots\' commands ignored', () => {
  assert.deepEqual(parseGroupCommand('/bind'), { cmd: 'bind', arg: '' })
  assert.deepEqual(parseGroupCommand('/bind 方案讨论'), { cmd: 'bind', arg: '方案讨论' })
  assert.deepEqual(parseGroupCommand('/bind@DsBot 圆桌', 'dsbot'), { cmd: 'bind', arg: '圆桌' })
  assert.equal(parseGroupCommand('/bind@OtherBot', 'dsbot'), null)
  assert.deepEqual(parseGroupCommand('/unbind'), { cmd: 'unbind', arg: '' })
  assert.equal(parseGroupCommand('请 /bind'), null)
  assert.equal(parseGroupCommand('/binding'), null)
})

test('intake routing: my_chat_member and unbound messages are only discovered, never ingested; commands go to onCommand', async () => {
  const seen = { disc: [], cmd: [], in: [] }
  const seats = resolveSeats({ chatroomSeats: [{ id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'T' } }] })
  const bots = createTelegramBots({
    resolveToken: async () => '111:aaaaaaaaaaaaaaaaaaaaaaaa',
    getSeats: () => seats,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/getMe')) return { json: async () => ({ ok: true, result: { id: 111, username: 'ds_bot' } }) }
      return { json: async () => ({ ok: true, result: {} }) }
    },
    onDiscover: (d) => seen.disc.push(d), onCommand: (c) => seen.cmd.push(c), onInbound: (u) => seen.in.push(u),
  })
  await bots.check(seats[0])
  bots.setBound(() => new Set(['-1002']))
  const g = { id: -1001, type: 'supergroup', title: '测试群' }
  await bots.handleUpdate({ update_id: 1, my_chat_member: { chat: g, from: { id: 9000000001, first_name: 'Shiro' }, date: 1760000000, new_chat_member: { status: 'member' } } })
  await bots.handleUpdate({ update_id: 2, message: { chat: g, from: { id: 5, first_name: 'X' }, text: '未绑定群的消息', date: 1760000001 } })
  await bots.handleUpdate({ update_id: 3, message: { chat: g, from: { id: 9000000001 }, text: '/bind 圆桌' } })
  await bots.handleUpdate({ update_id: 4, message: { chat: { id: -1002, type: 'group', title: 'B' }, from: { id: 7 }, text: '已绑定群' } })
  await bots.handleUpdate({ update_id: 5, message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '私聊' } })
  assert.deepEqual(seen.disc.map((d) => `${d.chatId}:${d.via}:${d.title}`), ['-1001:my_chat_member:测试群', '-1001:message:测试群', '-1001:message:测试群'])
  assert.equal(seen.disc[0].addedBy, 'Shiro'); assert.equal(seen.disc[0].addedById, '9000000001')
  assert.deepEqual(seen.cmd.map((c) => `${c.cmd}:${c.arg}:${c.chatId}:${c.bound}`), ['bind:圆桌:-1001:false'])
  assert.deepEqual(seen.in.map((u) => `${u.chatId}:${u.text}`), ['-1002:已绑定群'])
})

test('feature: discovered list (lossless JSON), owner-only /bind and /unbind with replies, one-click bind and ignore', async () => {
  const dir = await tmp()
  const replies = []
  let cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '9000000001', chatroomSeats: [] }
  const feat = createChatroomFeature(null, () => cfg, { dir, llm: null, presets: null })
  feat.bots.reply = async (chatId, text) => { replies.push([chatId, text]); return true }
  const call = async (method, sub, body) => {
    let status, json
    await feat.handleApi({ method, headers: {}, url: sub, on() {} }, { writeHead() {}, write() {}, end() {}, on() {} }, sub, { sendJson: (_, s, j) => { status = s; json = j }, readBody: async () => JSON.stringify(body || {}) })
    return { status, json }
  }
  try {
    const room = await feat.store.createRoom({ title: '圆桌' })
    await feat.discovered.record({ chatId: '-1001001', title: '测试群', type: 'supergroup', via: 'my_chat_member', addedBy: 'Shiro', addedById: '9000000001', active: true })
    await feat.discovered.record({ chatId: '-1003003', title: '另一个群', via: 'message', active: true })
    let list = (await call('GET', '/chatroom/discovered')).json.groups
    assert.deepEqual(list.map((g) => `${g.chatId}:${g.status}`).sort(), ['-1001001:new', '-1003003:new'])
    assert.ok(isJsonValue(list))
    // 非所有者 /bind：忽略，不回复
    assert.deepEqual(await feat.groupCommand({ cmd: 'bind', arg: '', chatId: '-1001001', title: '测试群', fromId: '5' }), { ignored: true })
    assert.equal(replies.length, 0)
    // 所有者 /bind（唯一房间 → 默认）
    assert.equal((await feat.groupCommand({ cmd: 'bind', arg: '', chatId: '-1001001', title: '测试群', fromId: '9000000001' })).ok, true)
    assert.deepEqual((await feat.store.getRoom(room.id)).telegramChatIds, ['-1001001'])
    assert.deepEqual(await feat.boundChatIds(), ['-1001001'])
    assert.match(replies.at(-1)[1], /已将本群「测试群」绑定到房间「圆桌」/)
    list = (await call('GET', '/chatroom/discovered')).json.groups
    assert.equal(list.find((g) => g.chatId === '-1001001').status, 'bound')
    // /unbind
    await feat.groupCommand({ cmd: 'unbind', arg: '', chatId: '-1001001', fromId: '9000000001' })
    assert.deepEqual((await feat.store.getRoom(room.id)).telegramChatIds || [], [])
    assert.match(replies.at(-1)[1], /已解除/)
    // 两个房间时无名 /bind 要求指定
    await feat.store.createRoom({ title: '第二间' })
    await feat.groupCommand({ cmd: 'bind', arg: '', chatId: '-1001001', fromId: '9000000001' })
    assert.match(replies.at(-1)[1], /请指定房间/)
    // 一键绑定 / 忽略
    const b = await call('POST', '/chatroom/discovered/-1003003/bind', { roomId: room.id })
    assert.equal(b.status, 200); assert.deepEqual(b.json.room.telegramChatIds, ['-1003003'])
    const ig = await call('POST', '/chatroom/discovered/-1001001/ignore', {})
    assert.equal(ig.json.groups.find((g) => g.chatId === '-1001001').status, 'ignored')
    // 再次被拉进群 → 重新待处理
    await feat.discovered.record({ chatId: '-1001001', via: 'my_chat_member', active: true })
    assert.equal((await feat.discovered.list()).find((g) => g.chatId === '-1001001').status, 'new')
  } finally { await feat.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('chatroom may share a channel bot token: polls when channel does not own it; hub delivers when delegated', async () => {
  const cfg = {
    telegramEnabled: false,
    chatroomSeats: [{ id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'CHATROOM_BOT_DEEPSEEK_TOKEN' } }],
    telegramBots: [
      { id: 'main', tokenRef: 'TELEGRAM_BOT_TOKEN', enabled: true },
      { id: 'chatgpt', tokenRef: 'TELEGRAM_BOT_CHATGPT_TOKEN', enabled: true },
    ],
  }
  const tokens = {
    TELEGRAM_BOT_TOKEN: '111:aaaaaaaaaaaaaaaaaaaaaaaa',
    TELEGRAM_BOT_CHATGPT_TOKEN: '222:bbbbbbbbbbbbbbbbbbbbbbbb',
    CHATROOM_BOT_DEEPSEEK_TOKEN: '111:aaaaaaaaaaaaaaaaaaaaaaaa',
  }
  const values = await collectTokenValues(channelTokenRefs(cfg), async (ref) => tokens[ref])
  assert.deepEqual(values, ['111:aaaaaaaaaaaaaaaaaaaaaaaa', '222:bbbbbbbbbbbbbbbbbbbbbbbb'])
  let getUpdates = 0
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop()
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 111, username: 'ds_bot' } }) }
    if (method === 'getUpdates') {
      getUpdates++
      await new Promise((r, j) => init.signal?.addEventListener('abort', () => j(new Error('aborted'))))
    }
    return { json: async () => ({ ok: true, result: {} }) }
  }
  const bots = createTelegramBots({
    resolveToken: async (ref) => tokens[ref],
    getSeats: () => resolveSeats(cfg),
    channelOwnsToken: async () => false,
    fetchImpl,
    onInbound: () => {},
  })
  const st = await bots.startIngest(() => new Set())
  assert.equal(st.error, '')
  assert.equal(st.mode, 'polling')
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(getUpdates >= 1)
  bots.stopIngest()

  const inbound = []
  const { rawHub } = await import('../telegram/raw-hub.mjs')
  const b2 = createTelegramBots({
    resolveToken: async (ref) => tokens[ref],
    getSeats: () => resolveSeats(cfg),
    channelOwnsToken: async () => true,
    fetchImpl,
    hub: rawHub,
    onInbound: (u) => inbound.push(u),
  })
  const st2 = await b2.startIngest(() => new Set(['-1001']))
  assert.equal(st2.mode, 'delegated')
  await rawHub.publish(tokens.CHATROOM_BOT_DEEPSEEK_TOKEN, {
    update_id: 9,
    message: { message_id: 90, chat: { id: -1001, type: 'supergroup' }, from: { id: 9000000001, first_name: 'Shiro' }, text: '委托来的' },
  }, { accountId: 'main' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(inbound.map((u) => u.text), ['委托来的'])
  b2.stopIngest()
})

test('intake: @ member switches receiver; reply-to counts; out-of-group mention sends failure notice; /bind once via dedupe', async () => {
  const calls = []
  const seats = resolveSeats({ chatroomSeats: [
    { id: 'deepseek', name: 'DeepSeek', telegram: { ingest: true, tokenRef: 'T1' } },
    { id: 'claude', name: 'Claude', telegram: { ingest: false, tokenRef: 'T2' } },
  ] })
  const tokens = { T1: '111:aaa', T2: '222:bbb' }
  const memberStatus = { '222': 'left' }
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop()
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ method, body, token: (url.match(/bot([^/]+)/) || [])[1] })
    if (method === 'getMe') {
      const id = url.includes('111:') ? 111 : 222
      return { json: async () => ({ ok: true, result: { id, username: id === 111 ? 'ds_bot' : 'claude_bot', can_read_all_group_messages: true } }) }
    }
    if (method === 'getChatMember') {
      const st = memberStatus[String(body.user_id)] || 'left'
      return { json: async () => ({ ok: true, result: { status: st, user: { id: body.user_id } } }) }
    }
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
  const inbound = []
  const cmds = []
  const bots = createTelegramBots({
    resolveToken: async (r) => tokens[r], getSeats: () => seats, fetchImpl,
    onInbound: (u) => inbound.push(u),
    onCommand: (c) => cmds.push(c),
    channelOwnsToken: async () => false,
  })
  bots.setBound(() => new Set(['-1001']))
  // 预热 client username
  await bots.check(seats[0]); await bots.check(seats[1])

  // 普通消息：主接收处理
  await bots.handleUpdate({
    message: { message_id: 1, chat: { id: -1001, type: 'supergroup' }, from: { id: 9, first_name: 'U' }, text: 'hi' },
  }, { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.deepEqual(inbound.map((u) => u.text), ['hi'])

  // 非主接收收到普通消息 → 丢弃
  await bots.handleUpdate({
    message: { message_id: 2, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: 'nope' },
  }, { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.deepEqual(inbound.map((u) => u.text), ['hi'])

  // @claude 但 claude 不在群 → 主接收发失败提示，不当内容
  const t = '请 @claude_bot 来'
  await bots.handleUpdate({
    message: {
      message_id: 3, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: t,
      entities: [{ type: 'mention', offset: t.indexOf('@'), length: '@claude_bot'.length }],
    },
  }, { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  assert.equal(inbound.length, 1)
  assert.ok(calls.some((c) => c.method === 'sendMessage' && /无法将接收切换到 @claude_bot/.test(c.body.text)))

  // claude 在群，且由 claude 收到 → 接收；主接收同条丢弃
  memberStatus['222'] = 'member'
  bots._test.members.clear()
  const t2 = '请 @claude_bot 来'
  inbound.length = 0
  await bots.handleUpdate({
    message: {
      message_id: 4, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: t2,
      entities: [{ type: 'mention', offset: t2.indexOf('@'), length: '@claude_bot'.length }],
    },
  }, { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  await bots.handleUpdate({
    message: {
      message_id: 4, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: t2,
      entities: [{ type: 'mention', offset: t2.indexOf('@'), length: '@claude_bot'.length }],
    },
  }, { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  // message_id 4 第一次被主接收丢弃（switch），未写入 dedupe 前… 实际上主接收在 switch 且自己不是目标时 return，仍可能已 dedupe.seen
  // 去重在命令/入站之前：两条同 message_id 第二条被去重。为测切换，用不同 message_id。
  inbound.length = 0
  bots._test.dedupe.clear()
  await bots.handleUpdate({
    message: {
      message_id: 5, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: t2,
      entities: [{ type: 'mention', offset: t2.indexOf('@'), length: '@claude_bot'.length }],
    },
  }, { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.deepEqual(inbound.map((u) => `${u.viaSeatId}:${u.text}`), ['claude:' + t2])

  // 回复 claude 的消息
  inbound.length = 0
  bots._test.dedupe.clear()
  await bots.handleUpdate({
    message: {
      message_id: 6, chat: { id: -1001, type: 'supergroup' }, from: { id: 9 }, text: '继续',
      reply_to_message: { from: { id: 222, is_bot: true, username: 'claude_bot' } },
    },
  }, { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.equal(inbound[0]?.via, 'reply')

  // 未绑定群 /bind 去重：两个 bot 各收一次只处理一次
  bots.setBound(() => new Set())
  bots._test.dedupe.clear()
  cmds.length = 0
  const bindMsg = { message_id: 7, chat: { id: -2002, type: 'group', title: '新群' }, from: { id: 9000000001 }, text: '/bind' }
  await bots.handleUpdate({ message: bindMsg }, { receivingSeatId: 'deepseek', botUsername: 'ds_bot' })
  await bots.handleUpdate({ message: bindMsg }, { receivingSeatId: 'claude', botUsername: 'claude_bot' })
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].cmd, 'bind')
})

test('feature: binding refuses groups already configured in the Telegram channel (/bind, one-click bind, room save)', async () => {
  const dir = await tmp()
  const replies = []
  const cfg = { chatroomEnabled: true, chatroomOwnerTelegramId: '9000000001', chatroomSeats: [], telegramGroupIds: '1007007007007, -42424242' }
  const feat = createChatroomFeature(null, () => cfg, { dir, llm: null, presets: null })
  feat.bots.reply = async (chatId, text) => { replies.push([chatId, text]); return true }
  const call = async (method, sub, body) => {
    let status, json
    await feat.handleApi({ method, headers: {}, url: sub, on() {} }, { writeHead() {}, write() {}, end() {}, on() {} }, sub, { sendJson: (_, s, j) => { status = s; json = j }, readBody: async () => JSON.stringify(body || {}) })
    return { status, json }
  }
  try {
    const room = await feat.store.createRoom({ title: '圆桌' })
    // /bind：-100 前缀与通道里的写法不同也算同一个群；机器人回复原因，不绑定
    assert.equal((await feat.groupCommand({ cmd: 'bind', arg: '', chatId: '-1007007007007', fromId: '9000000001' })).ok, false)
    assert.match(replies.at(-1)[1], /群聊 -1007007007007 已在 Telegram 通道中配置，请先从通道移除/)
    assert.deepEqual((await feat.store.getRoom(room.id)).telegramChatIds || [], [])
    // 发现新群一键绑定
    const b = await call('POST', '/chatroom/discovered/-42424242/bind', { roomId: room.id })
    assert.notEqual(b.status, 200); assert.match(b.json.error, /已在 Telegram 通道中配置/)
    // 房间设置保存
    const p = await call('PUT', `/chatroom/rooms/${room.id}`, { telegramChatIds: ['-1003003003003', '-42424242'] })
    assert.notEqual(p.status, 200); assert.match(p.json.error, /群聊 -42424242 已在 Telegram 通道中配置/)
    assert.deepEqual((await feat.store.getRoom(room.id)).telegramChatIds || [], [])
    // 不冲突的照常绑定；通道保存前的检查能查到它
    assert.equal((await call('PUT', `/chatroom/rooms/${room.id}`, { telegramChatIds: ['-1003003003003'] })).status, 200)
    assert.deepEqual(await feat.roomConflictsFor('3003003003, -1009'), [{ chatId: '3003003003', roomId: room.id, roomTitle: '圆桌' }])
  } finally { await feat.dispose(); await rm(dir, { recursive: true, force: true }) }
})
