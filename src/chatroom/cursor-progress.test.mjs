import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createChatroomTools } from './chatroom-tools.mjs'
import { createStore } from './store.mjs'
import { createModerator } from './moderator.mjs'
import { buildPrompt } from './transcript.mjs'
import { cursorStepTracker, stepCountsLine, runCursorAgent, parseCursorLine, toolSummaryLine } from './cursor.mjs'

// Cursor 任务卡片的「执行明细」：进度事件 → 卡片数据（最近 200 步、按工具计数、最新一步），节流推送，落盘，AI 只看计数摘要
const SEATS = [{ id: 'ds', name: 'DeepSeek', provider: 'deepseek', model: 'd' }, { id: 'gk', name: 'Grok', provider: 'xai', model: 'g', leader: true }]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(10) } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

async function setup({ runCursor, now }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cp-'))
  const store = createStore(dir)
  const toolkit = createChatroomTools({ roomDir: (id) => join(dir, 'rooms', id), getTools: () => ({ schemas: () => [], get: () => null }), getLlm: () => null, getSettings: () => ({}), providers: async () => ({ available: true, providers: [] }) })
  const calls = []
  const events = []
  const relays = []
  const tg = { typing: () => () => {}, relay: async (seat, _r, text) => { relays.push(text); return [] } }
  const cfg = { seats: SEATS, userName: 'Shiro', budget: 3, maxTokens: 100, ownerId: '1', defaultMain: 'ds', tools: {}, cursorRepo: dir }
  const moderator = createModerator({ store, getRoomConfig: async () => cfg, call: async (o) => { calls.push(o); return { text: '[PASS]', usage: {} } }, toolkit, tg, runCursor, emit: (_, e) => events.push(e), ...(now ? { now } : {}) })
  const room = await store.createRoom({ title: 'cursor' })
  const repo = join(dir, 'ws')
  const msg = await store.append(room.id, { kind: 'brief', briefId: 'bp001', briefStatus: 'awaiting_owner', action: 'brief', repo, title: 'Add A', speaker: { id: 'ds', name: 'ds' }, text: 'Implement A.' })
  await store.patchMeta(room.id, (m) => { m.briefs = { bp001: { action: 'brief', title: 'Add A', brief: 'Implement A.', repo, status: 'awaiting_owner', by: 'ds', msgId: msg.id } }; m.pendingBrief = 'bp001' })
  return { dir, store, moderator, calls, events, relays, room, done: () => rm(dir, { recursive: true, force: true }) }
}
const cardOf = async (f) => (await f.store.readMessages(f.room.id)).find((m) => m.kind === 'tool' && m.data?.cursorTask)
const promptOf = async (f) => buildPrompt({ seat: SEATS[1], seats: SEATS, userName: 'Shiro', messages: await f.store.readMessages(f.room.id) }).messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

test('cursor steps: tracker keeps the last 200, counts per tool, short latest step; compact AI line', () => {
  let t = Date.parse('2026-10-16T01:00:00Z')
  const tr = cursorStepTracker({ now: () => t })
  assert.equal(tr.add({ kind: 'session', text: 's1' }), null)
  assert.equal(tr.add({ kind: 'say', text: '   ' }), null)
  for (let i = 0; i < 230; i++) { t += 1000; tr.add({ kind: 'tool', tool: i % 3 ? 'grep' : 'read', target: 'S:\\ExampleWorkspace\\ExampleProject\\app' + i }) }
  tr.add({ kind: 'say', text: '我先看看  目录\n结构' })
  tr.add({ kind: 'thinking', text: '先推断入口文件' })
  tr.add({ kind: 'tool', text: 'shell npm test -- --watch=false' }) // 旧格式（只有 text）也能拆出工具名
  const s = tr.snapshot()
  assert.equal(s.steps.length, 200); assert.equal(s.stepsTotal, 233)
  assert.deepEqual(s.stepCounts, { read: 77, grep: 153, shell: 1 })
  assert.equal(s.lastStep, 'shell npm test -- --watch=false')
  assert.deepEqual(s.steps.at(-3), { t: s.steps.at(-3).t, k: 'say', text: '我先看看 目录 结构' })
  assert.deepEqual(s.steps.at(-2), { t: s.steps.at(-2).t, k: 'thinking', text: '先推断入口文件' })
  assert.equal(s.steps.at(-1).target, 'npm test -- --watch=false')
  tr.add({ kind: 'tool', tool: 'grep', target: 'S:\\ExampleWorkspace\\ExampleProject\\app' })
  assert.equal(tr.snapshot().lastStep, 'grep app')
  assert.equal(stepCountsLine(tr.snapshot().stepCounts), 'Cursor steps: grep×154, read×77, shell×1 (232 tool calls)')
  assert.equal(stepCountsLine({}), '')
  // 路径参数
  assert.equal(parseCursorLine('{"type":"tool_call","subtype":"started","tool_call":{"globToolCall":{"args":{"globPattern":"**/*.ts"}}}}').summary, '**/*.ts')
  assert.equal(parseCursorLine('{"type":"thinking","subtype":"delta","text":"hmm"}').text, 'hmm')
  assert.equal(parseCursorLine('{"type":"thinking","subtype":"completed"}').type, 'thinking')
})

test('cursor steps: the runner reports tool calls with tool/target and the assistant text before them (say, not for Telegram)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cpa-'))
  try {
    const fake = join(dir, 'fake-agent.mjs')
    await writeFile(fake, `
process.stdin.resume(); process.stdin.on('end',()=>{
  const o=(x)=>console.log(JSON.stringify(x))
  o({type:'system',subtype:'init',session_id:'s-1'})
  o({type:'thinking',subtype:'delta',text:'先想一下'})
  o({type:'thinking',subtype:'delta',text:' 从哪里搜'})
  o({type:'thinking',subtype:'completed'})
  o({type:'assistant',message:{content:[{type:'text',text:'先搜索一下'}]}})
  o({type:'assistant',message:{content:[{type:'text',text:' 入口。'}]}})
  o({type:'tool_call',subtype:'started',tool_call:{grepToolCall:{args:{pattern:'main',path:'S:/x/app'}}}})
  o({type:'tool_call',subtype:'completed',tool_call:{grepToolCall:{args:{pattern:'main',path:'S:/x/app'}}}})
  o({type:'tool_call',subtype:'started',tool_call:{shellToolCall:{args:{command:'npm   test'}}}})
  o({type:'result',subtype:'success',is_error:false,result:'done',session_id:'s-1'})
})`)
    const progress = []
    const res = await runCursorAgent({ agentPath: 'cursor-agent', handoff: { action: 'brief', title: 't', repo: dir, brief: 'plan plan plan' }, onProgress: (p) => progress.push(p), spawnImpl: (c, a, o) => spawn(process.execPath, [fake, ...a], { ...o, shell: false }) })
    assert.equal(res.status, 'success')
    assert.deepEqual(progress.filter((p) => p.kind !== 'session'), [
      { kind: 'thinking', text: '先想一下 从哪里搜' },
      { kind: 'say', text: '先搜索一下 入口。' },
      { kind: 'tool', tool: 'grep', target: 'S:/x/app', text: 'grep S:/x/app' },
      { kind: 'tool', tool: 'shell', target: 'npm test', text: 'shell npm test' },
    ])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('cursor steps: live card updates are throttled (~1/s, progress-flagged), persisted, kept after finish; AIs see only counts; Telegram unchanged', async () => {
  const gate = deferred()
  const mid = deferred()
  const runCursor = async (_b, { onProgress }) => {
    onProgress({ kind: 'session', text: 's1' })
    for (let i = 0; i < 250; i++) onProgress({ kind: 'tool', tool: 'grep', target: 'S:\\SECRETPATH\\app' + i, text: 'grep S:\\SECRETPATH\\app' + i })
    onProgress({ kind: 'say', text: '正在检查 SAYTEXT' })
    await sleep(1300)
    onProgress({ kind: 'tool', tool: 'read', target: 'S:\\SECRETPATH\\a.mjs', text: 'read S:\\SECRETPATH\\a.mjs' })
    mid.resolve()
    await gate.promise
    return { ok: true, status: 'success', exitCode: 0, sessionId: 's1', finalText: 'Report body.', durationMs: 5000 }
  }
  const f = await setup({ runCursor })
  try {
    const ex = await f.moderator.post(f.room.id, '执行 bp001', { owner: true })
    await mid.promise
    await sleep(1200)
    const live = f.events.filter((e) => e.type === 'message-update' && e.progress === true)
    assert.ok(live.length >= 1 && live.length <= 4, 'throttled: ' + live.length) // 252 个事件 → 几次更新
    const last = live.at(-1).message.data.cursorTask
    assert.equal(last.status, 'running'); assert.equal(last.steps.length, 200); assert.equal(last.lastStep, 'read a.mjs')
    assert.equal(f.events.filter((e) => e.type === 'cursor-progress').length, 253)
    // 运行中：AI 只看到「仍在进行」，没有明细
    let p = await promptOf(f)
    assert.match(p, /Cursor is still working on it/); assert.ok(!p.includes('SECRETPATH')); assert.ok(!p.includes('SAYTEXT'))
    gate.resolve()
    const card = await ex.cursor
    const t = card.data.cursorTask
    assert.equal(t.status, 'done'); assert.equal(t.steps.length, 200); assert.equal(t.stepsTotal, 252)
    assert.deepEqual(t.stepCounts, { grep: 250, read: 1 })
    assert.equal(t.steps.at(-2).k, 'say'); assert.equal(t.steps.at(-1).tool, 'read')
    // 落盘：面板重载后仍在
    const disk = (await cardOf(f)).data.cursorTask
    assert.equal(disk.steps.length, 200); assert.equal(disk.stepsTotal, 252); assert.equal(disk.status, 'done')
    // AI：只有一行计数摘要
    await until(() => !f.moderator.status(f.room.id).running)
    p = await promptOf(f)
    assert.match(p, /\(Cursor steps: grep×250, read×1 \(251 tool calls\)\)/)
    assert.ok(!p.includes('SECRETPATH')); assert.ok(!p.includes('SAYTEXT'))
    for (const c of f.calls) { const s = JSON.stringify(c.prompt || {}); assert.ok(!s.includes('SECRETPATH')); assert.ok(!s.includes('SAYTEXT')) }
    // Telegram：仍是原来的 ⏳ 节流行（20 秒一次）+ 结束摘要；不含助手文字
    assert.equal(f.relays.filter((r) => r.startsWith('⏳ Cursor #bp001')).length, 1)
    assert.ok(!f.relays.some((r) => r.includes('SAYTEXT')))
    assert.ok(!toolSummaryLine(card).includes('SECRETPATH'))
    // 结束后不再有进度推送
    const n = f.events.filter((e) => e.progress === true).length
    await sleep(1100)
    assert.equal(f.events.filter((e) => e.progress === true).length, n)
  } finally { await f.done() }
})

test('cursor steps: written to disk about every 10 s while running; a cancelled task keeps its steps on the blank card', async () => {
  let clock = Date.now()
  const runCursor = async (_b, { onProgress, signal }) => {
    onProgress({ kind: 'tool', tool: 'glob', target: '**/*.mjs' })
    clock += 11000
    onProgress({ kind: 'tool', tool: 'edit', target: 'S:\\w\\b.mjs' })
    await new Promise((r) => signal.addEventListener('abort', r))
    return { ok: false, status: 'aborted' }
  }
  const f = await setup({ runCursor, now: () => clock })
  try {
    const ex = await f.moderator.post(f.room.id, '执行 bp001', { owner: true })
    const onDisk = await until(async () => { const c = await cardOf(f); return c?.data?.cursorTask?.stepsTotal === 2 ? c : null }, 4000)
    assert.equal(onDisk.data.cursorTask.status, 'running'); assert.equal(onDisk.data.cursorTask.lastStep, 'edit b.mjs')
    await f.moderator.cancelBrief?.(f.room.id, 'bp001') ?? f.moderator.stop(f.room.id)
    const card = await ex.cursor
    assert.equal(card.data.blank, true); assert.equal(card.data.cursorTask.status, 'cancelled')
    assert.deepEqual(card.data.cursorTask.stepCounts, { glob: 1, edit: 1 }); assert.equal(card.data.cursorTask.steps.length, 2)
    const p = await promptOf(f)
    assert.match(p, /came back blank/); assert.ok(!p.includes('b.mjs'))
  } finally { await f.done() }
})