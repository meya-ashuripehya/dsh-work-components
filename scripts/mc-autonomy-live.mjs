/** Opt-in, isolated acceptance harness. Uses the production host loop and real model HTTP adapter.
 * Does not reload DSH, edit its settings, or spawn NPCs. Join with game commands.
 * Run: node scripts/mc-autonomy-live.mjs <existing isolated output directory>
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createMcControlHost } from '../src/components/gamebot/mc-host.mjs'
import { ensureMemberToken } from '../src/components/gamebot/process.mjs'
import { createStore } from '../src/chatroom/store.mjs'
import { readLivePresets } from './mc-live-presets.mjs'
import { createDshCatalog } from '../src/dsh-catalog.mjs'
import { baselineHost } from './mc-live-baseline.mjs'

const root = process.argv[2] && resolve(process.argv[2])
if (!root) throw new Error('Pass a dedicated acceptance output directory')
const durationSeconds = Number(process.argv[3] || 600)
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) throw new Error('Acceptance duration must be 1–1800 seconds (default 600)')
mkdirSync(root, { recursive: true })
const project = resolve(import.meta.dirname, '..')
const python = join(project, 'src/components/gamebot/.venv/Scripts/python.exe')
const config = JSON.parse(readFileSync('C:/Users/10917/.dsh/data/dsh-work-components/settings.json', 'utf8'))
const requestedSeats = ['seat-5']
const seats = requestedSeats.map((id) => config.chatroomSeats.find((s) => s.id === id && s.enabled !== false))
if (seats.some((s) => !s) || seats[0].provider !== 'google-vertex-vision') throw new Error('Configured Gemini seat-5 required')
const presetService = readLivePresets('C:/Users/10917/.dsh/profiles/desktop/cordis.patch.yml', seats.map((s) => s.preset))
const context = { agentPresets: presetService }
const catalog = createDshCatalog(context)
for (const seat of seats) if (seat.preset) await catalog.presetPersona(seat.preset)
const cfg = { ...config, gamebotUrl: 'http://127.0.0.1:18766', 'gamebot-minecraftEnabled': true, mcRoomSeatIds: seats.map((s) => s.id), chatroomSeats: seats }
if (process.env.MC_ACCEPTANCE_WS_URL) cfg.gb_minecraft_NEOFORGE_WS_URL = process.env.MC_ACCEPTANCE_WS_URL
const tokenFile = ensureMemberToken(root)
const env = { ...process.env, PYTHONPATH: join(project, 'src/components/gamebot/src'), PYTHONIOENCODING: 'utf-8', GAMEBOT_PORT: '18766', GAMEBOT_HOST: '127.0.0.1', GAMEBOT_MEMBER_TOKEN_FILE: tokenFile, GAMEBOT_CONFIG_FILE: join(root, 'game-configs.json'), GAMEBOT_MEMORY_DIR: join(root, 'memory') }
if (process.platform === 'win32') {
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(project, 'scripts/mc-live-watchdog.ps1'), '-TargetPid', String(process.pid), '-Seconds', String(durationSeconds), '-Root', root], { stdio: 'ignore', windowsHide: true }).unref()
  for (let n = 0; n < 30 && !existsSync(join(root, 'watchdog-ready.json')); n++) await new Promise((r) => setTimeout(r, 100))
  if (!existsSync(join(root, 'watchdog-ready.json'))) throw new Error('Independent watchdog did not confirm readiness; no AI started')
}
env.GAMEBOT_CLAIM_KEY_FILE = join(root, 'minecraft-work', 'claim.key')
const body = spawn(python, ['-m', 'gamebot'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
body.stderr.on('data', () => {})
let host, report, stopTimer, stopped = false
const models = new Set()
const injectedFaults = new Map()
const store = createStore(join(root, 'chatroom'))
let room
try { room = await store.getRoom(JSON.parse(readFileSync(join(root, 'live-room.json'), 'utf8')).id) } catch {}
if (!room?.id) {
  room = await store.createRoom({ title: 'Minecraft autonomy acceptance' })
  writeFileSync(join(root, 'live-room.json'), JSON.stringify({ id: room.id }))
  await store.append(room.id, { kind: 'user', speaker: { id: 'user', name: 'Shiro' }, text: process.env.MC_ACCEPTANCE_INSTRUCTION || '本轮只测 Gemini 的持续任务，不测试聊天。请用 explore_area 独自探索120秒并返回；任务执行中不要重复提交，不调用say。' })
}
function callModel({ seat, prompt, tools, signal }) {
  const startedAt = new Date().toISOString()
  const fault = injectedFaults.get(seat.name)
  injectedFaults.delete(seat.name)
  if (fault === 'fail_next') return Promise.reject(new Error('acceptance injected model failure'))
  if (fault === 'hang_next') return new Promise(() => {}) // deliberately ignores abort; host must bound it
  return new Promise((resolveCall, reject) => {
    const child = spawn(python, [join(project, 'scripts/mc-live-model.py')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    models.add(child)
    let output = ''
    const cancel = () => { child.kill(); reject(new Error('cancelled')) }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('exit', (code) => {
      models.delete(child); signal?.removeEventListener('abort', cancel)
      try {
        const result = JSON.parse(output)
        if (code || result.error) reject(new Error('real model request failed: ' + (result.error || code)))
        else {
          writeFileSync(join(root, 'model-usage.jsonl'), JSON.stringify({ startedAt, at: new Date().toISOString(), inputChars: prompt.system.length + prompt.messages.reduce((sum, m) => sum + m.content.length, 0), usage: result.usage }) + '\n', { flag: 'a' })
          resolveCall(result)
        }
      } catch { reject(new Error('invalid model result')) }
    })
    child.stdin.end(JSON.stringify({ seat, prompt, tools }))
  })
}
async function stop() {
  if (stopped) return
  stopped = true; await host?.dispose()
  clearTimeout(stopTimer)
  // Windows venv launchers may own a second Python process. Stop the whole test tree.
  for (const child of [...models, body]) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill()
  }
  clearInterval(report)
  writeFileSync(join(root, 'acceptance-stopped.json'), JSON.stringify({ at: new Date().toISOString(), stopped: true }))
}
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
stopTimer = setTimeout(() => { void stop() }, durationSeconds * 1000)
for (let n = 0; n < 60; n++) {
  try { await fetch(cfg.gamebotUrl + '/openapi.json'); break } catch { await new Promise((r) => setTimeout(r, 250)) }
}
if (stopped) process.exit(0)
if (process.env.MC_ACCEPTANCE_WS_URL) {
  const configured = await fetch(cfg.gamebotUrl + '/v1/games/minecraft', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ driver: 'minaret', config: { NEOFORGE_WS_URL: process.env.MC_ACCEPTANCE_WS_URL } }) })
  if (!configured.ok) { await stop(); throw Error('Isolated bridge configuration failed') }
}
const factory = process.env.MC_ACCEPTANCE_BASELINE_ROOT ? await baselineHost(process.env.MC_ACCEPTANCE_BASELINE_ROOT) : createMcControlHost
host = factory({ ctx: context, getConfig: () => cfg, store, roomId: () => room.id, dataRoot: () => root, callModel,
  taskDecisionIntervalMs: Number(process.env.MC_ACCEPTANCE_DECISION_INTERVAL_MS) || 60000 })
await host.sync()
if (stopped) process.exit(0)
writeFileSync(join(root, 'acceptance-run.json'), JSON.stringify({ startedAt: new Date().toISOString(), stopWithinSeconds: durationSeconds, seats: requestedSeats }))
console.log(JSON.stringify({ root, roomId: room.id, seats: seats.map((s) => ({ id: s.id, name: s.name, model: s.model })), join: seats.map((s) => `/minaret agent spawn ${s.id} ${s.name}`) }))
let handlingCommand = false
report = setInterval(async () => {
  const status = seats.map((s) => ({ id: s.id, ...host.view(s.id) }))
  writeFileSync(join(root, 'status.json'), JSON.stringify(status, null, 2))
  writeFileSync(join(root, 'status.jsonl'), JSON.stringify({ at: new Date().toISOString(), seats: status }) + '\n', { flag: 'a' })
  // Optional local acceptance control. Only explicit, bounded operations; no code evaluation.
  const commandFile = join(root, 'acceptance-command.json')
  if (!handlingCommand && existsSync(commandFile)) {
    handlingCommand = true
    try {
      const command = JSON.parse(readFileSync(commandFile, 'utf8'))
      unlinkSync(commandFile)
      if (!requestedSeats.includes(command.seat)) throw new Error('unknown acceptance seat')
      let result
      if (command.operation === 'stop') { await stop(); return }
      if (command.operation === 'takeover') result = await host.takeover(command.seat)
      else if (command.operation === 'resume') result = host.resume(command.seat)
      else if (['fail_next', 'hang_next'].includes(command.operation)) {
        injectedFaults.set(seats.find((s) => s.id === command.seat).name, command.operation)
        result = { ok: true, acceptanceOnly: true }
      }
      else throw new Error('unknown acceptance operation')
      writeFileSync(join(root, 'acceptance-command-result.json'), JSON.stringify({ at: new Date().toISOString(), operation: command.operation, seat: command.seat, result }))
    } catch { console.log('acceptance command rejected') }
    finally { handlingCommand = false }
  }
}, 1000)
