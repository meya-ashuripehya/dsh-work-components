/**
 * dsh-workbench — 工作组件插件的宿主半边。
 *
 *  1. 工作组件：Office / Blender / Unity / Figma / Photoshop / Chrome / Godot 等控制其他工作软件的 MCP 服务器，统一以
 *     dsh-mcp-client 子插件挂载（定义与运行时见 ./components.mjs），开关和路径在「工作组件」设置页里，改动后立即重挂。
 *     组件（和 uv、Node.js）可以在设置页一键下载安装到插件数据目录的 tools/（见 ./tools.mjs toolsDir）。
 *     已启动的组件在 /components 请求时按需探测「已连接」（对应程序在运行且 MCP 够得着它，见 ./connect.mjs）。
 *  2. 设置：用 ctx.settings 注册 `dsh-workbench` 命名空间；没有 settings 服务时读写数据目录里的
 *     settings.json（$DSH_HOME/data/dsh-work-components，见 ./tools.mjs dataDir；与组合 config 合并），
 *     避免 Desktop 无设置服务时开关（含会话控制）重启丢失。GET /settings 返回的密钥一律打码，
 *     并经 webServer 暴露 /dsh-workbench/api/settings、/dsh-workbench/api/components、
 *     POST /dsh-workbench/api/components/<id>/install|uninstall|cancel（cancel：取消进行中 / 排队中的下载并删除该组件的工具文件）
 *     （id：uv / node / office / blender / unity / figma / photoshop / chrome / godot），
 *     POST /dsh-workbench/api/components/godot/addon { project }（把同版本的 Godot AI 插件装进 Godot 项目），
 *     以及 /dsh-workbench/assets/*（插件 assets/ 下的静态文件；不要放入第三方界面截图或标志）。
 *  3. 会话控制（通用）：撤回 / 重试（按回合就地截断多帧 zstd，保留连续 seq，并清投影缓存）、熔断（取消；自动熔断再截掉失败尾轮）；API 在 /dsh-workbench/api/session/*。
 *  4. 多模态图片：`mm_send_image`（本地文件 → attachments.saveImage → Host attachmentId）。model 侧 render 只发 text+image（DeepSeek Messages 拒 type:'mm'）；MmCard 数据走 presentationMeta.mm，客户端用 meta / image fallback。
 *
 * 前端设置页与工具卡片在 lib/client.js。
 */
import z from 'schemastery'
import { defineTool } from '@dsh/define-tool'
import { COMPONENTS, componentById, createComponentManager, contributeInfo, localComponentsDir, CONTRIBUTE_COMPARE_URL } from './components.mjs'
import { installExitHook as installGamebotExitHook, stopBody as stopGamebotBody } from './components/gamebot/process.mjs'
import { gamebotSchemaShape, legacyConfigCandidates, legacyImportPatch } from './components/gamebot/fields.mjs'
import { dataDir, dirSize, killProcessesUnder, managedPaths, migrateLegacyState, pluginRoot, settingsFilePath, toolsDir } from './tools.mjs'
import { mountSessionControls, handleSessionApi } from './session-controls/index.mjs'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

export { COMPONENTS, componentById, createComponentManager, contributeInfo, localComponentsDir, CONTRIBUTE_COMPARE_URL, dataDir, dirSize, killProcessesUnder, managedPaths, settingsFilePath, toolsDir }

export const name = 'dsh-workbench'
export const inject = ['tools', 'agents', 'sessions', 'sessionController']

const NAMESPACE = 'dsh-workbench'
const API_PREFIX = '/dsh-workbench/api'
const ASSETS_PREFIX = '/dsh-workbench/assets'
const BODY_LIMIT = 16 * 1024

// File used when ctx.settings is absent (Desktop profiles often lack the settings service): settingsFilePath() in ./tools.mjs.

function loadFileSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

async function saveFileSettings(value) {
  const file = settingsFilePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value ?? {}, null, 2) + '\n', 'utf8')
}

const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export const SettingsSchema = z.object({
  uvPath: z.string().default('').description('uv 可执行文件（uvx 取同目录）。插件 tools/uv 里已下载 uv 时优先用它；否则用这里的路径，留空时查找 WinGet 安装的 uv，再退回 PATH。'),
  proxy: z.string().default('').description('下载安装工具时使用的 HTTP 代理，例如 http://127.0.0.1:7890；留空时使用环境变量 HTTPS_PROXY / HTTP_PROXY。'),
  officeEnabled: z.boolean().default(false).description('启动 OfficeMCP（仅 Windows，COM 控制 Word / Excel / PowerPoint）。'),
  officeRepo: z.string().default('').description('OfficeMCP 仓库目录。插件已下载安装 OfficeMCP（tools/officemcp）时优先用它；否则用这里的目录，留空时用插件目录旁边的 officemcp。'),
  officeFolder: z.string().default('').description('OfficeMCP 的工作根目录；留空时用它自己的默认值 D:\\@OfficeMCP（没有 D 盘时用 文档\\OfficeMCP）。'),
  blenderEnabled: z.boolean().default(false).description('启动 Blender MCP。'),
  blenderPackage: z.string().default('mcp-for-blender').description('Blender MCP 的 pip 包名（入口命令同名），「下载安装」时安装到 tools/blender。'),
  unityEnabled: z.boolean().default(false).description('启动 Unity MCP。'),
  unityPackage: z.string().default('mcpforunityserver').description('Unity MCP 的 pip 包名（入口命令 mcp-for-unity），「下载安装」时安装到 tools/unity。'),
  figmaEnabled: z.boolean().default(false).description('启动 Figma MCP（需要 Figma 桌面版）。'),
  figmaMode: z.union(['console', 'official']).default('console')
    .description('console：figma-console-mcp（经 Desktop Bridge 插件读写画布）；official：连接官方 Figma 桌面版 MCP（需付费计划的 Dev / Full 席位）。'),
  figmaToken: z.string().role('secret').default('').description('Figma 个人访问令牌（figd_ 开头），console 模式下作为 FIGMA_ACCESS_TOKEN 传给服务器，REST 类工具要用。'),
  figmaOfficialUrl: z.string().default('http://127.0.0.1:3845/mcp').description('官方 Figma 桌面版 MCP 地址（streamable HTTP）。'),
  figmaPackage: z.string().default('figma-console-mcp').description('Figma MCP 的 npm 包（可带版本），「下载安装」时安装到 tools/figma。'),
  photoshopEnabled: z.boolean().default(false).description('启动 Photoshop MCP（经 COM 控制本机 Photoshop）。'),
  photoshopPath: z.string().default('').description('Photoshop.exe 路径；留空时从注册表自动检测。'),
  photoshopPackage: z.string().default('@alisaitteke/photoshop-mcp').description('Photoshop MCP 的 npm 包（可带版本），「下载安装」时安装到 tools/photoshop。'),
  chromeEnabled: z.boolean().default(false).description('启动 Chrome DevTools MCP（控制本机 Google Chrome）。'),
  chromeConnect: z.union(['launch', 'autoConnect', 'browserUrl']).default('launch')
    .description('launch：用独立配置目录启动一个 Chrome（默认 %USERPROFILE%\\.cache\\chrome-devtools-mcp，用到时自动创建）；autoConnect：连接正在运行的 Chrome（144+，在 chrome://inspect/#remote-debugging 打开远程调试；第一次用工具时 Chrome 弹「允许调试」确认框）；browserUrl：连接 --remote-debugging-port 调试端口（需非默认 user-data-dir；inspect 开关开的端口没有 /json/version，请用 autoConnect）。'),
  chromeBrowserUrl: z.string().default('http://127.0.0.1:9222').description('browserUrl 模式下 Chrome 的调试地址（需 chrome --remote-debugging-port=9222 --user-data-dir=<非默认目录>）。'),
  chromeChannel: z.union(['stable', 'beta', 'dev', 'canary']).default('stable').description('launch / autoConnect 时使用的 Chrome 渠道。'),
  chromeHeadless: z.boolean().default(false).description('launch 模式下无头运行（不显示窗口）。'),
  chromeUserDataDir: z.string().default('').description('launch 模式下的配置目录；留空时用 chrome-devtools-mcp 自己的专用目录（登录状态会保留，不动你平时的 Chrome 配置）。'),
  chromeToolset: z.union(['standard', 'full', 'slim']).default('standard').description('standard：默认工具；full：再加内存分析、坐标点击、扩展与 PWA 等；slim：只留导航 / 执行脚本 / 截图 3 个。'),
  chromePackage: z.string().default('chrome-devtools-mcp').description('Chrome MCP 的 npm 包（可带版本），「下载安装」时安装到 tools/chrome。'),
  godotEnabled: z.boolean().default(false).description('启动 Godot MCP（godot-ai attach，经 Godot 编辑器里的 Godot AI 插件控制编辑器，需要 Godot 4.7+）。'),
  godotPackage: z.string().default('godot-ai').description('Godot MCP 的 pip 包（可带版本，如 godot-ai==4.2.3），「下载安装」时安装到 tools/godot 并固定版本；Godot 项目里的插件必须是同一版本。'),
  godotHttpPort: z.natural().min(1).max(65535).default(8000).description('godot-ai 共享后端的 HTTP 端口（attach --port），要和 Godot 编辑器设置 godot_ai/http_port 一致。'),
  godotWsPort: z.natural().min(1).max(65535).default(9500).description('Godot 编辑器插件连接的 WebSocket 端口（attach --ws-port），要和编辑器设置 godot_ai/ws_port 一致。'),
  ffmpegEnabled: z.boolean().default(false).description('启动 FFmpeg / Kinocut MCP（本机媒体转换；需要本机已安装 ffmpeg）。'),
  ffmpegPackage: z.string().default('kinocut').description('FFmpeg 组件的 pip 包名（入口命令 kino），「下载安装」时安装到 tools/ffmpeg。'),
  ffmpegPath: z.string().default('').description('可选。本机 ffmpeg 可执行文件路径；留空时从 PATH 查找。'),
  obsidianEnabled: z.boolean().default(false).description('启动 Obsidian MCP（经 Local REST API 插件读写库）。'),
  obsidianPackage: z.string().default('obsidian-mcp-server').description('Obsidian MCP 的 npm 包（可带版本），「下载安装」时安装到 tools/obsidian。'),
  obsidianApiKey: z.string().role('secret').default('').description('Obsidian Local REST API 插件的 API 密钥（Bearer Token）。'),
  obsidianBaseUrl: z.string().default('http://127.0.0.1:27123').description('Local REST API 地址，默认 HTTP http://127.0.0.1:27123；HTTPS 可用 https://127.0.0.1:27124。'),
  obsidianEnableCommands: z.boolean().default(false).description('是否允许 MCP 执行 Obsidian 命令面板命令（OBSIDIAN_ENABLE_COMMANDS）。'),
  godotProject: z.string().default('').description('Godot 项目目录（含 project.godot）；「安装插件到项目」把同版本插件装进它的 addons/godot_ai。'),

  windowsEnabled: z.boolean().default(false).description('启动 Windows-MCP（控制本机桌面：窗口、键鼠、截图、文件系统等；仅 Windows）。'),
  windowsMode: z.union(['stdio', 'http']).default('stdio')
    .description('stdio：由本插件拉起 windows-mcp（推荐）；http：连接已在运行的 Windows-MCP HTTP 服务（如计划任务 127.0.0.1:18765）。'),
  windowsUrl: z.string().default('http://127.0.0.1:18765/mcp').description('HTTP 模式下的 Windows-MCP 地址（streamable-http）。'),
  windowsPackage: z.string().default('windows-mcp').description('Windows-MCP 的 pip 包名（入口 windows-mcp），「下载安装」时安装到 tools/windows。'),
  notionEnabled: z.boolean().default(false).description('启动官方 Notion MCP（经 mcp-remote OAuth 桥；首次连接会弹出授权页）。'),
  notionUrl: z.string().default('https://mcp.notion.com/mcp').description('Notion MCP 远程地址。'),
  notionPackage: z.string().default('mcp-remote').description('OAuth 桥接用的 npm 包（默认 mcp-remote），「下载安装」时安装到 tools/notion；也可复用 %USERPROFILE%\.dsh\mcp-remote。'),
  cloudflareEnabled: z.boolean().default(false).description('启动官方 Cloudflare API MCP（经 mcp-remote OAuth 桥；scope=offline_access）。'),
  cloudflareUrl: z.string().default('https://mcp.cloudflare.com/mcp').description('Cloudflare API MCP 远程地址。'),
  cloudflarePackage: z.string().default('mcp-remote').description('OAuth 桥接用的 npm 包（默认 mcp-remote），「下载安装」时安装到 tools/cloudflare。'),
  'cloudflare-docsEnabled': z.boolean().default(false).description('启动 Cloudflare 文档 MCP（公开 HTTP，无需登录）。'),
  'cloudflare-docsUrl': z.string().default('https://docs.mcp.cloudflare.com/mcp').description('Cloudflare Docs MCP 远程地址。'),
  githubEnabled: z.boolean().default(false).description('启动官方 GitHub MCP（托管 streamable-http）。'),
  githubUrl: z.string().default('https://api.githubcopilot.com/mcp/').description('GitHub MCP 托管端点地址。'),
  githubToken: z.string().role('secret').default('').description('GitHub PAT（Bearer）。优先用本设置；留空时读环境变量 GITHUB_MCP_PAT。不要把 token 写进仓库。'),
  comfyuiEnabled: z.boolean().default(false).description('启动官方 Comfy MCP（comfy-mcp）；需本机 ComfyUI / comfy-cli。'),
  comfyuiPackage: z.string().default('comfy-mcp').description('Comfy MCP 的 pip 包名（入口 comfy-mcp），「下载安装」时安装到 tools/comfyui。'),
  comfyuiBin: z.string().default('').description('comfy-cli 的 comfy 可执行文件路径，作为 COMFY_BIN 传给服务器；留空时用环境变量 COMFY_BIN。'),
  'gamebot-minecraftEnabled': z.boolean().default(false).description('启用 GameBot · Minecraft（共享 body + 仅 Minecraft 的 MCP）。每次启动默认关闭。'),
  'gamebot-civilizationEnabled': z.boolean().default(false).description('启用 GameBot · 文明 VI（共享 body + 仅文明的 MCP）。每次启动默认关闭。'),
  'gamebot-visionEnabled': z.boolean().default(false).description('启用 GameBot · 视觉兜底（共享 body + 仅视觉桌面的 MCP）。每次启动默认关闭。'),
  gamebotUrl: z.string().default('http://127.0.0.1:8766').description('GameBot REST 地址（/health、/v1/...）；可跨重启记住。'),
  gamebotRoot: z.string().default('').description('可选：外部 GameBot 目录（含 pyproject.toml + src/gamebot）；留空用插件内嵌 src/components/gamebot。填写时也会从它的 data/game-configs.json 一次性导入旧设置。'),
  nodePath: z.string().default('').description('node 可执行文件（npm 取同目录）。插件 tools/node 里有 Node.js 时优先用它；否则用这里的路径，留空时用 PATH 里的 node，再退回 DSH 自带的运行时。'),
  npmRegistry: z.string().default('').description('npm 镜像地址，例如 https://registry.npmmirror.com；留空用 npm 自己的设置。'),
  sessionControlsEnabled: z.boolean().default(false).description('【实验性】启用会话控制（撤回 / 重试 / 暂停熔断）。默认关闭；此功能尚未开发完毕，启用后可能对对话造成不可逆破坏。设置页保留高级开关；聊天内走消息操作与输入框暂停。'),
  sessionCircuitEnabled: z.boolean().default(true).description('启用自动熔断：同一工具连打、步数过多或思考过长时取消当前回合。'),
  sessionCircuitMaxSameTool: z.natural().min(2).max(50).default(6).description('熔断：同一工具（含相同参数）连续调用达到该次数时取消。'),
  sessionCircuitMaxSteps: z.natural().min(5).max(500).default(80).description('熔断：单回合 step/start 次数上限。'),
  sessionCircuitMaxReasoningChars: z.natural().min(1000).max(5000000).default(200000).description('熔断：单回合累计思考字符上限。'),

  ...gamebotSchemaShape(z),
})

/** 兼容旧导出：Office 组件的启动方案（冒烟脚本在用）。 */
export function officeLaunchPlan(cfg) {
  return componentById('office').launch(cfg)
}

/** Local components' `<id>Enabled` keys (discovered at load). Default OFF — fresh install mounts no MCP until enabled. */
function localEnabledSchemaExtras() {
  const shape = {}
  for (const c of COMPONENTS) {
    if (c.moduleSource !== 'local') continue
    const key = `${c.id}Enabled`
    shape[key] = z.boolean().default(false).description(`启用本地组件 ${c.label || c.id}（默认关闭）`)
  }
  return shape
}

const _localEnabledShape = localEnabledSchemaExtras()
/** Runtime schema: base SettingsSchema ∩ local *Enabled. Prefer this for register / API validate. */
export const RuntimeSettingsSchema = Object.keys(_localEnabledShape).length
  ? z.intersect([SettingsSchema, z.object(_localEnabledShape)])
  : SettingsSchema

/** Keep local `*Enabled` booleans that Cordis settings.register may drop from unknown keys. */
function pickLocalEnabled(from) {
  const out = {}
  if (!from || typeof from !== 'object') return out
  for (const c of COMPONENTS) {
    if (c.moduleSource !== 'local') continue
    const key = `${c.id}Enabled`
    if (Object.prototype.hasOwnProperty.call(from, key) && typeof from[key] === 'boolean') out[key] = from[key]
  }
  // Also accept any *Enabled boolean for ids that look like local comps already in from/current
  for (const [k, v] of Object.entries(from)) {
    if (!k.endsWith('Enabled') || typeof v !== 'boolean') continue
    if (Object.prototype.hasOwnProperty.call(out, k)) continue
    const id = k.slice(0, -'Enabled'.length)
    if (!id || componentById(id)?.moduleSource !== 'local') continue
    out[k] = v
  }
  return out
}


/** Game-group enable keys: session-only. URL/root still persist. */
const EPHEMERAL_ENABLED_KEYS = ['gamebot-minecraftEnabled', 'gamebot-civilizationEnabled', 'gamebot-visionEnabled', 'gamebotEnabled']

function withEphemeralEnabledOff(value) {
  const out = { ...(value || {}) }
  for (const k of EPHEMERAL_ENABLED_KEYS) out[k] = false
  return out
}

function persistableSettings(value) {
  // Never sticky-on game features across host restarts.
  return withEphemeralEnabledOff(value)
}

export const Config = RuntimeSettingsSchema

/** Settings keys declared with role('secret') (tokens, API keys, passwords). */
export const SECRET_KEYS = Object.entries(SettingsSchema.dict || {})
  .filter(([, s]) => s?.meta?.role === 'secret')
  .map(([k]) => k)
/** Stand-in returned for a saved secret. Posting it back means "keep the saved value"; '' clears it. */
export const SECRET_MASK = '__dsh_secret_saved__'

/** Copy of settings safe to send to the browser: saved secrets become SECRET_MASK. */
export function maskSecrets(value) {
  const out = { ...(value || {}) }
  for (const k of SECRET_KEYS) if (typeof out[k] === 'string' && out[k] !== '') out[k] = SECRET_MASK
  return out
}

/** Drop masked secrets from an incoming patch so the saved value stays. */
function unmaskPatch(patch) {
  const out = { ...(patch || {}) }
  for (const k of SECRET_KEYS) if (out[k] === SECRET_MASK) delete out[k]
  return out
}


const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}


/**
 * MmBlock UI shape for multimodal cards (presentationMeta / toolview only — NOT model content).
 * DeepSeek Messages serialize rejects unknown user/tool-result types with UNSUPPORTED_CONTENT
 * (`user/tool-result content mm`). Keep type:'mm' out of output.render; put it in presentationMeta.
 *   type: 'mm'
 *   kind: 'image' | 'video' | 'webpage' | 'document'
 *   status: 'pending' | 'ready' | 'error' | 'canceled'
 *   progress?: number (0..1 or 0..100)
 *   title?: string
 *   caption?: string
 *   error?: string
 *   asset?: { attachment: ImageRef }
 *   source?: { url?: string, href?: string }
 * Frontend lib/client.js: settled MmCard via conversation.chat.turnTail (turn data mmCards);
 * toolview shows pending/compact only. Prefers meta.mm, then content type:'mm' (legacy),
 * then type:'image'. video/webpage/document remain stubs.
 */
function mmImageBlock(image, opts = {}) {
  return {
    type: 'mm',
    kind: 'image',
    status: opts.status || 'ready',
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.caption === undefined ? {} : { caption: opts.caption }),
    ...(opts.error === undefined ? {} : { error: opts.error }),
    ...(opts.progress === undefined ? {} : { progress: opts.progress }),
    asset: { attachment: imageRef(image) },
  }
}

function imageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

/** Local image types accepted by mm_send_image (v1; no remote URLs). */
const IMAGE_EXT_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const IMAGE_MAX_BYTES = 25 * 1024 * 1024

/**
 * Best-effort width/height from common image headers (fallback if saveImage omits dims).
 * @returns {{ width: number, height: number } | null}
 */
function sniffImageDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    const w = buf.readInt32LE(18)
    const h = Math.abs(buf.readInt32LE(22))
    if (w > 0 && h > 0) return { width: w, height: h }
  }
  // JPEG SOF
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  // WebP (RIFF....WEBP)
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const tag = buf.toString('ascii', 12, 16)
    if (tag === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (tag === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    if (tag === 'VP8X' && buf.length >= 30) {
      const w = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16)
      const h = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16)
      return { width: w, height: h }
    }
  }
  return null
}

/**
 * Resolve + validate a local image path for mm_send_image.
 * Rejects empty paths, remote URLs, missing/non-file paths, bad extensions, oversized files.
 */
function loadLocalImageFile(rawPath) {
  const input = String(rawPath ?? '').trim()
  if (!input) throw new Error('path must be a non-empty local file path')
  if (/^(https?|ftp|data):/i.test(input)) {
    throw new Error('remote URLs are not supported in v1; pass a local file path')
  }
  let full = input
  if (/^file:/i.test(input)) {
    try {
      full = decodeURIComponent(new URL(input).pathname)
      // Windows file:///C:/... → /C:/... → C:/...
      if (/^\/[A-Za-z]:\//.test(full)) full = full.slice(1)
    } catch {
      throw new Error('invalid file: URL')
    }
  }
  full = resolve(full)
  if (!existsSync(full)) throw new Error('image file not found: ' + full)
  const st = statSync(full)
  if (!st.isFile()) throw new Error('path is not a file: ' + full)
  if (st.size <= 0) throw new Error('image file is empty: ' + full)
  if (st.size > IMAGE_MAX_BYTES) throw new Error('image too large (' + st.size + ' bytes); max ' + IMAGE_MAX_BYTES)
  const ext = extname(full).toLowerCase()
  const mediaType = IMAGE_EXT_MEDIA[ext]
  if (!mediaType) {
    throw new Error('unsupported image type "' + (ext || '(none)') + '"; allowed: ' + Object.keys(IMAGE_EXT_MEDIA).join(' '))
  }
  const data = readFileSync(full)
  const sniffed = sniffImageDims(data)
  return {
    full,
    name: basename(full),
    mediaType,
    data,
    bytes: data.length,
    width: sniffed && sniffed.width,
    height: sniffed && sniffed.height,
  }
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 只读提供插件 assets/ 下的静态文件（路径不能跳出该目录）。 */
function sendAsset(res, reqPath) {
  const name = decodeURIComponent(reqPath).replace(/^\/+/, '')
  if (!name || name.includes('\0') || name.split(/[\\/]/).some((p) => p === '..')) {
    res.writeHead(400); res.end('bad path'); return
  }
  const root = join(pluginRoot(), 'assets')
  const full = resolve(root, name)
  const rel = relative(root, full)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); res.end('not found'); return
  }
  const type = ASSET_TYPES[extname(full).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
  createReadStream(full).pipe(res)
}

export function apply(ctx, config) {
  // ── 旧版本写在包目录里的状态 → 数据目录（每项只做一次；不记录任何值）──
  try {
    const did = migrateLegacyState((m) => ctx.logger?.warn?.(`dsh-workbench: ${m}`))
    if (did.length) ctx.logger?.info?.(`dsh-workbench: migrated legacy state (${did.join(', ')}) → ${dataDir()}`)
  } catch (error) {
    ctx.logger?.warn?.('dsh-workbench: legacy state migration failed', error)
  }
  // ── 设置：优先 ctx.settings（可持久、可热改）；否则文件 + 组合配置 ──
  let current = RuntimeSettingsSchema(config ?? {})
  let scope = null
  /** True when we persist via the data-dir settings.json (no settings service). */
  let filePersist = false
  const components = createComponentManager(ctx, () => current)
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settings && typeof settings.register === 'function') {
    try {
      scope = settings.register(NAMESPACE, RuntimeSettingsSchema, { base: config ?? {}, applies: 'live' })
      current = scope.get()
      scope.watch?.((next) => { current = next; components.sync() })
    } catch (error) {
      ctx.logger?.warn?.('dsh-workbench: settings.register failed, fallback to file/composition config', error)
      scope = null
    }
  }
  if (!scope) {
    const saved = loadFileSettings()
    if (saved) {
      const localEnabled = pickLocalEnabled({ ...current, ...saved })
      current = RuntimeSettingsSchema({ ...current, ...saved, ...localEnabled })
    }
    filePersist = true
  }
  // GameBot：只有填了外部 gamebotRoot 时，才从它的 data/game-configs.json 一次性导入每个游戏的设置
  // （之后卡片是唯一来源）。不记录任何值。
  if (current.gamebotImported !== true && String(current.gamebotRoot || '').trim()) {
    try {
      const got = legacyImportPatch(legacyConfigCandidates(current.gamebotRoot))
      const patch = { ...(got?.patch || {}), gamebotImported: true }
      current = RuntimeSettingsSchema({ ...current, ...patch })
      if (scope) { try { void scope.update?.(patch) } catch {} }
      else if (filePersist) { try { void saveFileSettings(persistableSettings(current)) } catch {} }
      if (got) ctx.logger?.info?.(`dsh-workbench: imported GameBot settings from ${got.file} (${Object.keys(got.patch).length} fields)`)
    } catch (error) {
      ctx.logger?.warn?.('dsh-workbench: GameBot legacy settings import failed', error)
    }
  }
  // Game-group：每次宿主启动强制关闭（不跨重启粘滞）；URL/root 仍可从上面的合并结果保留。
  {
    const forced = withEphemeralEnabledOff(current)
    const changed = EPHEMERAL_ENABLED_KEYS.some((k) => current[k] === true)
    current = RuntimeSettingsSchema(forced)
    if (changed) {
      if (scope) {
        try { void scope.update?.(Object.fromEntries(EPHEMERAL_ENABLED_KEYS.map((k) => [k, false]))) } catch {}
      } else if (filePersist) {
        try { void saveFileSettings(persistableSettings(current)) } catch {}
      }
    }
  }
  const settingsPersisted = () => scope !== null || filePersist

  // ── 工作组件：各自 fork 一个 dsh-mcp-client 子插件（不写进 profile，随本插件卸载）──
  components.sync()
  ctx.effect?.(() => {
    // GameBot body 是本插件拉起的子进程：宿主退出时同步结束它；插件卸载时等它真正退出。
    const offExit = installGamebotExitHook()
    return async () => {
      offExit()
      components.dispose()
      try { await stopGamebotBody() } catch {}
    }
  }, 'dsh-workbench: components')

  const sessionControls = mountSessionControls(ctx, () => current)
  ctx.effect?.(() => () => sessionControls.dispose?.(), 'dsh-workbench: session-controls')

  // ── 设置页 API + 静态 assets（同源；目录里只放本仓库有权分发的文件）──
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const offApi = webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local')
          const sub = url.pathname.slice(API_PREFIX.length) || '/'
          if (sub === '/settings' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, persisted: settingsPersisted(), settingsFile: scope ? null : settingsFilePath(), secretMask: SECRET_MASK, value: maskSecrets(current) })
          }
          if (sub === '/settings' && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            const patch = unmaskPatch(JSON.parse(await readBody(req) || '{}'))
            const localEnabled = pickLocalEnabled({ ...current, ...patch })
            const next = RuntimeSettingsSchema({ ...current, ...patch, ...localEnabled })
            // 启动门控：未安装 / 正在安装的组件不能从停用改为启用（builtin 组件不受限）。
            const blocked = await components.enableBlocked(current, next)
            if (blocked) return sendJson(res, 409, { ok: false, error: blocked })
            if (scope) {
              await scope.update({ ...patch, ...localEnabled })
              current = { ...scope.get(), ...pickLocalEnabled({ ...scope.get(), ...localEnabled }) }
            } else {
              current = { ...next, ...localEnabled }
              if (filePersist) {
                try {
                  await saveFileSettings(persistableSettings(current))
                } catch (error) {
                  ctx.logger?.warn?.('dsh-workbench: failed to write settings file', error)
                  return sendJson(res, 500, { ok: false, error: 'settings file write failed: ' + String(error && error.message || error) })
                }
              }
            }
            await components.sync()
            return sendJson(res, 200, { ok: true, persisted: settingsPersisted(), settingsFile: scope ? null : settingsFilePath(), secretMask: SECRET_MASK, value: maskSecrets(current) })
          }
          if (sub === '/components' && req.method === 'GET') {
            // 顺带探测已启动组件的连接（有缓存、不并发）；最多等 1.5 秒，没探完的下次请求再带上。
            await components.refreshConnections({ waitMs: 1500 })
            return sendJson(res, 200, {
              ok: true,
              toolsDir: toolsDir(),
              dataDir: dataDir(),
              localComponentsDir: localComponentsDir(),
              contributeCompareUrl: CONTRIBUTE_COMPARE_URL,
              components: await components.list(),
            })
          }
          const addon = /^\/components\/([\w-]+)\/addon$/.exec(sub)
          if (addon && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            const body = JSON.parse(await readBody(req) || '{}')
            const result = await components.installAddon(addon[1], body.project)
            return sendJson(res, 200, { ok: true, result, message: result.message, component: (await components.list()).find((c) => c.id === addon[1]) })
          }
          const action = /^\/components\/([\w-]+)\/(install|uninstall|cancel)$/.exec(sub)
          if (action && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            const [, id, verb] = action
            if (verb === 'install') {
              const { component } = await components.install(id)
              return sendJson(res, 202, { ok: true, component })
            }
            if (verb === 'cancel') return sendJson(res, 200, { ok: true, component: await components.cancel(id) })
            return sendJson(res, 200, { ok: true, component: await components.uninstall(id) })
          }
          const contrib = /^\/components\/([\w-]+)\/contribute$/.exec(sub)
          if (contrib && req.method === 'GET') {
            const info = components.contribute(contrib[1])
            if (!info) return sendJson(res, 404, { ok: false, error: `${contrib[1]} 不是本地组件，或没有贡献信息` })
            return sendJson(res, 200, { ok: true, ...info })
          }
          if (sub === '/health') return sendJson(res, 200, { ok: true, name, persisted: settingsPersisted() })
          if (sub.startsWith('/session')) {
            const handled = await handleSessionApi(ctx, sessionControls.circuit, req, res, sub, { sendJson, readBody, getConfig: () => current })
            if (handled !== false) return
          }
          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          return sendJson(res, error?.status ?? 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
      const offAssets = webCtx.webServer.register({
        kind: 'prefix',
        path: ASSETS_PREFIX,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405); res.end('method not allowed'); return
            }
            const url = new URL(req.url ?? '/', 'http://local')
            const sub = url.pathname.slice(ASSETS_PREFIX.length) || '/'
            if (sub === '/' || sub === '') { res.writeHead(404); res.end('not found'); return }
            if (req.method === 'HEAD') {
              // 只确认存在，不传内容
              const name = decodeURIComponent(sub).replace(/^\/+/, '')
              const full = resolve(join(pluginRoot(), 'assets'), name)
              const rel = relative(join(pluginRoot(), 'assets'), full)
              if (rel.startsWith('..') || !existsSync(full)) { res.writeHead(404); res.end(); return }
              const type = ASSET_TYPES[extname(full).toLowerCase()] || 'application/octet-stream'
              res.writeHead(200, { 'content-type': type, 'content-length': String(statSync(full).size), 'cache-control': 'public, max-age=86400' })
              res.end(); return
            }
            return sendAsset(res, sub)
          } catch (error) {
            res.writeHead(500); res.end(String(error?.message ?? error))
          }
        },
      })
      return () => { offApi?.(); offAssets?.() }
    }, 'dsh-workbench: settings api')
  })

  // ── 多模态图片：mm_send_image。attachments 门控同原生 read_image ──
  ctx.inject(['attachments'], (imgCtx) => {
    imgCtx.tools.register(defineTool({
      name: 'mm_send_image',
      description: 'Send a local image file as a multimodal card in the chat. Pass an absolute or workspace-relative path to a png/jpg/webp/gif/bmp file; optionally set title and caption. Does not fetch remote URLs.',
      parameters: {
        path: { type: 'string', required: true, description: 'Local image file path (png/jpg/jpeg/webp/gif/bmp). Not a remote URL.' },
        title: { type: 'string', description: 'Optional card title (defaults to the file name).' },
        caption: { type: 'string', description: 'Optional caption shown under the image.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string' },
            caption: { type: 'string' },
            image: IMAGE_VALUE_SCHEMA,
          },
        },
        render: (_args, value) => {
          // Model-facing only: DeepSeek Messages accepts text|image in tool-result.
          // type:'mm' → LlmError UNSUPPORTED_CONTENT ("user/tool-result content mm").
          const title = value.title || value.image.name || value.path
          const dims = value.image.mediaType + ', ' + value.image.width + 'x' + value.image.height + ' px, ' + value.image.bytes + ' bytes.'
          return [
            {
              type: 'text',
              text: 'Sent local image "' + title + '": ' + dims,
            },
            // Official attachment path (same as read_image): image block + attachmentId.
            { type: 'image', attachment: imageRef({ ...value.image, name: title }) },
          ]
        },
        presentationMeta: (_args, value) => {
          // UI-only replayable facts for MmCard (persisted on tool/result.meta; not in API history).
          const title = value.title || value.image.name || value.path
          const caption = value.caption
            || (value.image.mediaType + ', ' + value.image.width + 'x' + value.image.height + ' px, ' + value.image.bytes + ' bytes.')
          return {
            path: value.path,
            title,
            ...(value.caption ? { caption: value.caption } : {}),
            mm: mmImageBlock(value.image, { status: 'ready', title, caption }),
          }
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const loaded = loadLocalImageFile(args.path)
        const title = String(args.title ?? '').trim() || loaded.name
        const captionRaw = String(args.caption ?? '').trim()
        const attachments = imgCtx.get('attachments')
        if (!attachments) throw new Error('no attachment service is mounted')
        const ref = await attachments.saveImage({
          data: loaded.data,
          mediaType: loaded.mediaType,
          name: loaded.name,
        })
        const width = Number(ref.width ?? loaded.width ?? 0) || 0
        const height = Number(ref.height ?? loaded.height ?? 0) || 0
        return {
          path: loaded.full,
          title,
          ...(captionRaw ? { caption: captionRaw } : {}),
          image: {
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType || loaded.mediaType,
            bytes: ref.bytes ?? loaded.bytes,
            width,
            height,
            ...(ref.name === undefined && !loaded.name ? {} : { name: ref.name || loaded.name }),
          },
        }
      },
    }))



  })
}
