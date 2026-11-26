/** Opt-in real-game takeover and outbound private-message isolation check. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = resolve(process.argv[2])
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const token = readFileSync(join(root, 'data/member-token'), 'utf8').trim()
async function command(operation) {
  const started = Date.now()
  writeFileSync(join(root, 'acceptance-command.json'), JSON.stringify({ operation, seat: 'seat-5' }))
  for (let n = 0; n < 25; n++) {
    await delay(1000)
    try {
      const result = read('acceptance-command-result.json')
      if (Date.parse(result.at) >= started && result.operation === operation) {
        if (!result.result?.ok) throw new Error('control operation failed')
        return result
      }
    } catch (e) { if (e.message === 'control operation failed') throw e }
  }
  throw new Error('control operation timed out')
}
async function request(suffix, body) {
  const r = await fetch('http://127.0.0.1:18766/v1/minecraft/members/seat-5' + suffix, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-gamebot-member-token': token },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`member API HTTP ${r.status}`)
  return r.json()
}
const traceRows = () => readFileSync(join(root, 'minecraft-control-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const takeover = await command('takeover')
const before = traceRows().filter((r) => r.memberId === 'seat-5' && r.event === 'runTurn.start').length
await delay(12000)
const after = traceRows().filter((r) => r.memberId === 'seat-5' && r.event === 'runTurn.start').length
const obs = await request('/observe')
const marker = `PRIVATE-OUTBOUND-CHECK-${randomUUID()}`
let privateDelivery
try {
  privateDelivery = await request('/actions', { action: 'say', params: { audience: 'private', target: 'Shiro', text: marker, world_id: obs.extras.world_id, dimension: obs.extras.minecraft.player.dimension } })
  await delay(4000)
} finally { await command('resume') }
const room = read('live-room.json')
const publicText = readFileSync(join(root, 'chatroom/rooms', room.id, 'messages.jsonl'), 'utf8')
const memory = readFileSync(join(root, 'minecraft-autonomy.json'), 'utf8')
await delay(5000)
const resumed = traceRows().some((r) => r.memberId === 'seat-5' && r.event === 'runTurn.start' && Date.parse(r.ts) > Date.parse(takeover.at))
const result = { at: new Date().toISOString(), takeoverStoppedNewDecisions: before === after, privateDeliveryOk: privateDelivery.ok === true,
  outboundPrivateAbsentFromPublicRoom: !publicText.includes(marker), outboundPrivateAbsentFromPersistentMemory: !memory.includes(marker), resumedFreshDecision: resumed,
  scope: 'Real-game manual takeover/resume and outbound private delivery only; player-origin private replies remain unverified.' }
writeFileSync(join(root, 'recovery-check.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
if (Object.entries(result).some(([, v]) => v === false)) process.exitCode = 1
