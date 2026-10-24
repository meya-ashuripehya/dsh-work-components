// 发布前检查（npm run check；prepublishOnly 在 build 之后跑）：
//  1. 入口与随包脚本 node --check；
//  2. lib/client.js 的 GameBot 字段与 src/components/gamebot/fields.mjs 一致；
//  3. package.json / package-lock.json / locale / icon 的发布元数据自洽；
//  4. 「通道」› Telegram：vendor/wsz987 与 npm 0.5.1 + vendor/wsz987/patches 一致（npm run vendor:channels -- --check），
//     lib/channel-telegram.mjs 带全部补丁标记，卡片字段与 src/channels/telegram 的设置键一致。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const entries = [
  'lib/index.mjs',
  'lib/local-loader-worker.mjs',
  'lib/component-sdk.mjs',
  'lib/channel-telegram.mjs',
  'lib/gmail-server.mjs',
  'lib/client.js',
  'src/components/gamebot/src/gamebot/adapters/civilization/dsh_session_io.mjs',
]
for (const rel of entries) {
  const file = join(root, rel)
  if (!existsSync(file)) { problems.push(`missing ${rel} (run npm run build)`); continue }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`node --check ${rel}: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
  }
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-gamebot-fields.mjs'), '--check'], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim())
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'vendor-channels.mjs'), '--check'], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim())
}
if (existsSync(join(root, 'lib', 'channel-telegram.mjs'))) {
  try {
    const rt = await import(new URL('../lib/channel-telegram.mjs', import.meta.url).href)
    for (const [name, ok] of Object.entries(rt.PATCH_MARKERS || {})) if (!ok) problems.push(`lib/channel-telegram.mjs: patch marker ${name} missing (re-run npm run vendor:channels && npm run build)`)
    if (!Object.keys(rt.PATCH_MARKERS || {}).length) problems.push('lib/channel-telegram.mjs exports no PATCH_MARKERS')
  } catch (error) {
    problems.push(`import lib/channel-telegram.mjs: ${error.message}`)
  }
}
{
  const { TELEGRAM_KEYS, TELEGRAM_SECRET_KEY, TELEGRAM_LEGACY_KEYS } = await import(new URL('../src/channels/telegram/index.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const legacy = new Set(TELEGRAM_LEGACY_KEYS || [])
  for (const key of [...TELEGRAM_KEYS, TELEGRAM_SECRET_KEY]) {
    if (legacy.has(key)) continue
    if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  }
  if (!client.includes('group: "通道"')) problems.push('lib/client.js lacks the 通道 group')
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json version (${lock.version} / ${lock.packages?.['']?.version}) != package.json ${pkg.version}`)
}
const repo = String(pkg.repository?.url || '')
if (!/^(git\+)?https:\/\/github\.com\/meya-ashuripehya\/dsh-work-components(\.git)?$/.test(repo)) {
  problems.push(`repository.url must point at github.com/meya-ashuripehya/dsh-work-components (trusted publishing): ${repo || '(missing)'}`)
}
if (pkg.icon) {
  const icon = join(root, pkg.icon)
  if (!existsSync(icon)) problems.push(`icon ${pkg.icon} missing`)
  else if (statSync(icon).size > 256 * 1024) problems.push(`icon ${pkg.icon} larger than 256 KiB`)
}
for (const lang of ['en', 'zh']) {
  const file = join(root, 'locale', `${lang}.json`)
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta
    if (!meta?.title || !meta?.description) problems.push(`locale/${lang}.json needs meta.title and meta.description`)
  } catch (error) {
    problems.push(`locale/${lang}.json: ${error.message}`)
  }
}
for (const need of ['locale/*.json', 'icon.svg', 'lib/index.mjs', 'lib/local-loader-worker.mjs', 'lib/component-sdk.mjs', 'lib/channel-telegram.mjs', 'lib/gmail-server.mjs', 'lib/client.js', 'cordis.patch.yml']) {
  if (!pkg.files?.includes(need)) problems.push(`package.json files[] lacks ${need}`)
}


// 发布（CI）时 npm 包必须带上桌面控制经纪人；本地开发可缺省（未装 dotnet 时 build 会跳过）。
if (process.env.CI && !existsSync(join(root, 'src', 'components', 'desktop', 'broker', 'dist', 'DSHDesktopBroker.exe'))) {
  problems.push('src/components/desktop/broker/dist/DSHDesktopBroker.exe missing (run npm run build:desktop -- --require)')
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'test-update.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push(String(error.stderr || error.stdout || error.message).trim() || 'scripts/test-update.mjs failed')
}

// 「笔记」：存储、三级规则、删除确认、工具注册（node:test）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'notes', 'notes.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/notes/notes.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// AI 档案注册表：resolveProfile、出厂模板种子、实体化序号（node:test）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'profiles', 'profiles.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/profiles/profiles.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 「多模态」› GPT Image 2 生图：模拟 OpenAI 兼容服务（b64_json / url / 401 / 403 / 429 / 5xx / 超时 / 网络错误 / multipart 编辑），不发真实付费请求。
try {
  const noProxy = ['127.0.0.1', 'localhost', process.env.NO_PROXY || process.env.no_proxy || ''].filter(Boolean).join(',')
  execFileSync(process.execPath, ['--test', join(root, 'src', 'gpt-image', 'gpt-image.test.mjs')], { stdio: 'pipe', env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy } })
} catch (error) {
  problems.push('src/gpt-image/gpt-image.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}
{
  const { GPT_IMAGE_KEYS } = await import(new URL('../src/gpt-image/index.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const key of GPT_IMAGE_KEYS) if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  if (!client.includes('id: "gpt-image", group: "多模态"')) problems.push('lib/client.js lacks the 多模态 › GPT Image 2 生图 feature')
  if (!client.includes('"/gpt-image/test"')) problems.push('lib/client.js lacks the 测试连接 button for GPT Image 2')
}

// 「多模态」› 视频理解：设置兼容 / 迁移、组件挂载、describe_video / watch_video 工具与状态接口（模拟 Gemini，不发真实请求）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'video', 'video.test.mjs'), join(root, 'src', 'video', 'videokey.test.mjs'), join(root, 'src', 'video', 'bucket.test.mjs'), join(root, 'src', 'video', 'credential.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/video/video.test.mjs / videokey.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}
{
  const { VIDEO_KEYS } = await import(new URL('../src/video/index.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const key of VIDEO_KEYS) if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  if (!client.includes('id: "video", group: "多模态"')) problems.push('lib/client.js lacks the 多模态 › 视频理解 feature')
  if (!client.includes('"/video/status"')) problems.push('lib/client.js lacks the 视频理解 status box')
}

// 「工作组件」› Termalin：启动方案（本机 / 托管 API 密钥）、OAuth 端点拒绝、模拟 MCP 服务器、所有者门禁（不访问 termal.in）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'components', 'termalin', 'termalin.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/components/termalin/termalin.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 「工作组件」› 游戏 › Minecraft：Minaret 模组「打包下载」（mods 目录归一、备份替换、源码哈希；不跑 Gradle）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'components', 'gamebot', 'minaret.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/components/gamebot/minaret.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'store.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'blueprint.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'preview.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'tasks.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'claims.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'materials.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'auth.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'conflicts.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'handoff.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'control.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'scaffold.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'slots.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'loop.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'red-carpet.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'safety-regression.test.mjs'), join(root, 'src', 'components', 'gamebot', 'minecraft-work', 'tools.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/components/gamebot/minecraft-work failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 「工作组件」› KiCad：启动方案（uvx / 自定义命令、环境变量）、模拟 stdio MCP 服务器、所有者门禁（不下载 kicad-mcp-pro）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'components', 'kicad', 'kicad.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/components/kicad/kicad.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 「工作组件」› Fusion / FreeCAD / MATLAB / ESP-IDF / 串口 / Rhino / Altium：启动方案、模拟 HTTP 与 stdio MCP 服务器、状态探测、所有者门禁（不访问真实服务）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'components', 'mcp6.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/components/mcp6.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 「通用 › 余额查询」：各官方服务商的解析与单位换算、打码、缓存、设置接口、balance_query 工具（node:test，模拟 fetch，不访问真实接口）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'balance', 'balance.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/balance/balance.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}
{
  const { BALANCE_KEYS } = await import(new URL('../src/balance/index.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const key of BALANCE_KEYS) if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  if (!client.includes('id: "balance", group: "通用"')) problems.push('lib/client.js lacks the 通用 › 余额查询 feature')
  if (!client.includes('"/balance/state"')) problems.push('lib/client.js lacks the 余额查询 panel')
}

// Telegram 通道：群消息映射、授权用户工具闸门、群聊预设路由（node:test）。
for (const file of ['group-inbound.test.mjs', 'owner-gate.test.mjs', 'accounts.test.mjs', 'group-conflict.test.mjs', 'dm-pending.test.mjs']) {
  try {
    execFileSync(process.execPath, ['--test', join(root, 'src', 'channels', 'telegram', file)], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`src/channels/telegram/${file} failed:\n` + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
  }
}

// 棋类 → Telegram：出图、来源识别、发图 / 改图回退、文字走子（node:test，假 Telegram API，不下载棋库）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'boards', 'telegram.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/boards/telegram.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 棋类存档：保存 / 续局 / 损坏备份 / 重开 / 终局后开新局（node:test，假棋局，不下载棋库）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'boards', 'saves.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/boards/saves.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 棋类辅助引擎：UCI / piskvork / KataGo JSON 解析、模拟进程、崩溃恢复、提示映射（node:test，模拟引擎，不下载）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'boards', 'assist', 'assist.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/boards/assist/assist.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}

// 牌类：二十一点与勒杜克、限注德州、UNO（2 至 10 人）、斗地主的规则、按游戏和会话隔离的存档、工具注册、下载许可证、Telegram 出图与授权闸门（node:test，不访问 GitHub）。
for (const file of ['rules.test.mjs', 'saves.test.mjs', 'register.test.mjs', 'download.test.mjs', 'telegram.test.mjs', 'games.test.mjs', 'uno-multi.test.mjs', 'faces.test.mjs', 'seats.test.mjs']) {
  try {
    execFileSync(process.execPath, ['--test', join(root, 'src', 'cards', file)], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`src/cards/${file} failed:\n` + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
  }
}

// 网关核验：采集器、五项判定、回合合并、开关 / API、未下载 llm-gateway-bench 时隐藏、下载后免重启生效（node:test，桩判定；设置 LLM_GATEWAY_BENCH 时另跑真实仓库）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'gateway-trust', 'trust.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/gateway-trust/trust.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}
{
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  if (client.includes('gatewayBenchPath')) problems.push('lib/client.js still references the removed gatewayBenchPath setting')
  if (!/if \(!st\.loaded \|\| !st\.installed\) return null/.test(client)) problems.push('lib/client.js must hide the 核验 toggle until llm-gateway-bench is installed')
  if (!client.includes('function trustRefreshAll(')) problems.push('lib/client.js lacks trustRefreshAll (toggle must appear after download without restart)')
  if (!/none: "var\(--dsw-alias-state-error-primary/.test(client)) problems.push('lib/client.js: 核验「无数据」must use the red error color (TRUST_STATUS_COLOR.none)')
  if (!client.includes('.dsw-trust-trigger[data-status=none]')) problems.push('lib/client.js: 核验 chip with status none must be styled red')
  if (!client.includes('trustTurnNumber(props.turn)')) problems.push('lib/client.js: TrustTurnTail must map the host turn object to its number (props.turn is an object)')
  if (!client.includes('dsh-workbench-trust-toggle')) problems.push('lib/client.js lacks the 核验 composer toggle')
}

// 聊天室：席位迁移 / DSH 目录（服务商、模型、预设人设）/ ctx.llm.stream 调用 / 记录持久化 / 主持顺序、跳过、停止（node:test，模拟 DSH 服务，不联网）。
try {
  execFileSync(process.execPath, ['--test', join(root, 'src', 'chatroom', 'chatroom.test.mjs'), join(root, 'src', 'chatroom', 'orchestra.test.mjs'), join(root, 'src', 'chatroom', 'main-answer.test.mjs'), join(root, 'src', 'chatroom', 'msg-delete.test.mjs'), join(root, 'src', 'chatroom', 'heartbeat.test.mjs')], { stdio: 'pipe' })
} catch (error) {
  problems.push('src/chatroom/chatroom.test.mjs failed:\n' + String(error.stdout || error.stderr || error.message).split('\n').filter((l) => /^not ok|Error|assert/i.test(l)).slice(0, 12).join('\n'))
}
{
  const { CHATROOM_KEYS } = await import(new URL('../src/chatroom/seats.mjs', import.meta.url).href)
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  for (const key of CHATROOM_KEYS) if (!client.includes(`key: "${key}"`)) problems.push(`lib/client.js lacks INPUT_FIELDS entry ${key}`)
  if (!client.includes('type: "seatmain"') || !client.includes('请选择主答成员')) problems.push('lib/client.js lacks 主答 seatmain picker')
  if (!client.includes('type: "hbsession"') || !client.includes('function buildHeartbeatSessionField') || !client.includes('请选择目标会话')) problems.push('lib/client.js lacks 心跳目标会话 hbsession picker')
  if (client.includes('key: "chatroomHeartbeatSessionId"') && /key: "chatroomHeartbeatSessionId"[^\n]*type: "text"/.test(client)) problems.push('lib/client.js chatroomHeartbeatSessionId must be type hbsession (not text)')
}

if (problems.length) {
  console.error('check failed:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`check ok: ${entries.length} entries parse, GameBot fields in sync, Telegram vendor/patches in sync, metadata consistent (v${pkg.version})`)
