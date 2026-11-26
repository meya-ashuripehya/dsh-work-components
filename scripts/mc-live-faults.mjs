/** Fault injection into the isolated adapter, with the real world and other model running. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2])
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const trace = () => readFileSync(join(root, 'minecraft-control-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = fn(); if (result) return result; await delay(500) }
  throw new Error('acceptance observation timed out')
}
const result = { scope: 'Injected failure and abort-ignoring stall in isolated model adapter; not an actual provider outage.', checks: [] }
for (const operation of ['fail_next', 'hang_next']) {
  const issued = new Date().toISOString()
  writeFileSync(join(root, 'acceptance-command.json'), JSON.stringify({ operation, seat: 'seat-5' }))
  const accepted = await until(() => {
    try { const r = read('acceptance-command-result.json'); return r.operation === operation && r.at >= issued && r.result?.ok && r } catch {}
  }, 20000)
  console.log(JSON.stringify({ operation, accepted: accepted.at }))
  const failure = await until(() => trace().find((r) => r.memberId === 'seat-5' && r.event === 'runTurn.error' && r.ts >= accepted.at))
  const rows = trace()
  const start = rows.filter((r) => r.memberId === 'seat-5' && r.event === 'runTurn.start' && r.ts <= failure.ts).at(-1)
  const elapsed = Date.parse(failure.ts) - Date.parse(start.ts)
  const otherRounds = rows.filter((r) => r.memberId === 'seat-1' && r.event === 'runTurn.end' && r.ts >= start.ts && r.ts <= failure.ts).length
  const staleActions = rows.filter((r) => r.memberId === 'seat-5' && r.event === 'action.done' && r.ts >= start.ts && r.ts <= failure.ts).length
  const resumedStart = await until(() => trace().find((r) => r.memberId === 'seat-5' && r.event === 'runTurn.start' && r.ts > failure.ts), 45000)
  const resumedModel = await until(() => trace().find((r) => r.memberId === 'seat-5' && r.event === 'model.done' && r.ts >= resumedStart.ts), 95000)
  await until(() => trace().find((r) => r.memberId === 'seat-5' && r.event === 'runTurn.end' && r.ts >= resumedModel.ts), 40000)
  const check = { operation, started: start.ts, failed: failure.ts, elapsedMs: elapsed, retryDelayMs: Date.parse(resumedStart.ts) - Date.parse(failure.ts), recoveredModelAt: resumedModel.ts,
    noWorldActionFromFailedDecision: staleActions === 0,
    ...(operation === 'hang_next' ? { boundedAt90Seconds: elapsed >= 89000 && elapsed <= 95000, otherSeatCompletedDuringStall: otherRounds > 0, otherSeatRounds: otherRounds } : {}) }
  result.checks.push(check)
  writeFileSync(join(root, 'model-fault-check.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(check))
}
if (result.checks.some((c) => Object.values(c).some((v) => v === false))) process.exitCode = 1
