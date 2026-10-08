/**
 * Smoke: built-in GameBot game cards end to end (no DSH host).
 *  - launch() all three games concurrently → one shared body (auto .venv if missing)
 *  - card settings reach the body (PATCH /v1/games/<game>) — secrets compared, never printed
 *  - per-game MCP tools/list via the exact stdio plan launch() returned
 *  - disabling every game stops the body
 * Uses :8767 and a temp GAMEBOT_CONFIG_FILE, so real config / :8766 are untouched.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const url = process.env.SMOKE_GAMEBOT_URL || 'http://127.0.0.1:8767'
const cfgFile = join(tmpdir(), `gamebot-smoke-${Date.now()}.json`)
process.env.GAMEBOT_CONFIG_FILE = cfgFile

const imp = (p) => import(pathToFileURL(join(pluginRoot, p)).href)
const { RuntimeSettingsSchema } = await imp('lib/index.mjs')
const { bodyOwned, bodyUsers } = await imp('src/components/gamebot/process.mjs')
const GAMES = ['minecraft', 'civilization', 'vision']
const comps = Object.fromEntries(await Promise.all(GAMES.map(async (g) => [g, (await imp(`src/components/gamebot-${g}/index.mjs`)).component])))

const fail = (m) => { console.error('FAIL:', m); cleanup(); process.exit(1) }
const up = async () => { try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }
function cleanup() { try { rmSync(cfgFile, { force: true }) } catch {} }

const secret = `sk-smoke-${Math.random().toString(36).slice(2, 10)}`
const base = RuntimeSettingsSchema({})
console.log('defaults: every game off =', GAMES.every((g) => base[`gamebot-${g}Enabled`] === false))
const card = {
  ...base,
  gamebotUrl: url,
  'gamebot-minecraftEnabled': true, 'gamebot-civilizationEnabled': true, 'gamebot-visionEnabled': true,
  gb_minecraft_driver: 'mineflayer', gb_minecraft_MC_USERNAME: 'SmokeBot', gb_minecraft_MC_BRIDGE_PORT: '3199',
  gb_minecraft_LLM_PROVIDER: 'custom', gb_minecraft_LLM_API_KEY: secret,
  gb_civilization_CIV_POLL_INTERVAL_S: '7', gb_civilization_LLM_MODEL: 'smoke-model',
  gb_vision_max_px: '999',
}
const expect = {
  minecraft: { driver: 'mineflayer', MC_USERNAME: 'SmokeBot', MC_BRIDGE_URL: 'http://127.0.0.1:3199', MC_DRIVER: 'mineflayer' },
  civilization: { CIV_POLL_INTERVAL_S: '7', LLM_MODEL: 'smoke-model' },
  vision: { max_px: '999' },
}

console.log(`[1] launch() all three concurrently on ${url}`)
const plans = Object.fromEntries(await Promise.all(GAMES.map(async (g) => [g, await comps[g].launch(card)])))
for (const g of GAMES) if (!plans[g].ok) fail(`${g} launch: ${plans[g].reason}`)
console.log('    users', bodyUsers(), 'owned', bodyOwned(), 'health', await up())

console.log('[2] settings round-trip (card → body)')
for (const g of GAMES) {
  const got = (await (await fetch(`${url}/v1/games/${g}`)).json()).game
  const checks = Object.entries(expect[g]).map(([k, v]) => [k, (k === 'driver' ? got.driver : got.config[k]) === v])
  if (g === 'minecraft') checks.push(['LLM_API_KEY(custom) matches card [masked]', got.config.LLM_API_KEY === secret])
  console.log(`    ${g}:`, checks.map(([k, ok]) => `${k}=${ok ? 'ok' : 'MISMATCH'}`).join(', '))
  if (checks.some(([, ok]) => !ok)) fail(`${g} round-trip`)
}

console.log('[3] per-game MCP tools/list (plan from launch())')
const counts = {}
for (const g of GAMES) {
  const r = await mcp(plans[g].config)
  if (!r.ok) fail(`${g} mcp: ${r.error}`)
  counts[g] = r.toolCount
  console.log(`    ${g}: server=${r.server} tools=${r.toolCount} list_games=${r.hasListGames} get_game.key=${r.keyMasked}`)
  if (r.hasListGames || r.keyMasked === 'LEAK') fail(`${g} scope`)
}

console.log('[4] disable minecraft + vision → body stays; disable civilization → body stops')
const off = (g) => ({ ...card, 'gamebot-minecraftEnabled': false, 'gamebot-visionEnabled': false, 'gamebot-civilizationEnabled': g !== 'civilization' ? true : false })
await comps.minecraft.launch(off()); await comps.vision.launch(off())
await new Promise((r) => setTimeout(r, 600))
if (!(await up())) fail('body stopped too early')
console.log('    users', bodyUsers(), 'health', true)
await comps.civilization.launch(off('civilization'))
await new Promise((r) => setTimeout(r, 1500))
const still = await up()
console.log('    users', bodyUsers(), 'owned', bodyOwned(), 'port up?', still)
if (still || bodyOwned()) fail('body not stopped')
cleanup()
console.log('\nSMOKE OK', JSON.stringify(counts))
process.exit(0)

function mcp(plan) {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...(plan.env || {}) } })
    let buf = Buffer.alloc(0)
    const out = {}
    const done = (r) => { clearTimeout(timer); try { child.kill() } catch {} ; resolve(r) }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 15000)
    const send = (o) => { const b = Buffer.from(JSON.stringify(o)); child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])) }
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const he = buf.indexOf('\r\n\r\n'); if (he < 0) return
        const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString())?.[1] || 0)
        if (buf.length < he + 4 + len) return
        const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString('utf8')); buf = buf.slice(he + 4 + len)
        if (msg.id === 1) { out.server = msg.result?.serverInfo?.name; send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) }
        else if (msg.id === 2) {
          const tools = msg.result?.tools || []
          out.toolCount = tools.length
          out.hasListGames = tools.some((t) => t.name === 'gamebot_list_games')
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gamebot_get_game', arguments: {} } })
        } else if (msg.id === 3) {
          const text = msg.result?.content?.[0]?.text || ''
          out.keyMasked = text.includes(secret) ? 'LEAK' : 'masked/absent'
          done({ ...out, ok: true })
        }
      }
    })
    child.on('error', (e) => done({ ok: false, error: String(e) }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
  })
}
