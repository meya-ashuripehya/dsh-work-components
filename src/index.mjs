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
 *     GET/POST /dsh-workbench/api/update/check|apply|ignore|status（自更新检测与应用；状态在数据目录 update-state.json），
 *     以及 /dsh-workbench/assets/*（插件 assets/ 下的静态文件；不要放入第三方界面截图或标志）。
 *  3a. 网关核验（通用）：聊天输入栏「核验」开关（按会话保存）；开启后每回合的模型调用经 llm/stream 只读采集，
 *     用设置页下载到 <数据目录>/tools/llm-gateway-bench 的 llm-gateway-bench（未下载时不显示开关，下载后无需重启）判定回包模型、流式真实性、Token 计数、中文完整性、缓存，
 *     结果在 /dsh-workbench/api/trust/*，客户端在「用量」右侧显示。
 *  3. 会话控制（通用）：撤回 / 重试（按回合就地截断多帧 zstd，保留连续 seq，并清投影缓存）、熔断（取消；自动熔断再截掉失败尾轮）；API 在 /dsh-workbench/api/session/*。
 *  4. 多模态图片：`mm_send_image`（本地文件 → attachments.saveImage → Host attachmentId）。model 侧 render 只发 text+image（DeepSeek Messages 拒 type:'mm'）；MmCard 数据走 presentationMeta.mm，客户端用 meta / image fallback。
 *     本地文件：`mm_send_file` 走同一套 MmCard。图片复用 kind:image，视频为 kind:video，其余为 kind:document。PDF、Markdown、Word、Excel、PowerPoint 抽出正文放进卡片。模型只看到文字；Telegram 仍按文档发送。群聊里只有授权用户能调用。
 *     地图工具（默认关闭）：设置页保存高德 Key 后注册 geo_resolve / place_search / place_detail / route / weather / map_card。
 *     route 在页面上发出可点击的路线图，打开高德导航页；另返回可在手机打开的分享链接（iOS 与 Android）与 amapuri 深链（Android、HarmonyOS）。
 *     可将分享链接通过 Telegram 或复制交给手机，不写入高德账号收藏夹。
 *     map_card 为 kind:place：页面预览可打开高德标点，Telegram 改发原生命置（WGS-84）。
 *     日历（默认开启）：calendar_show / calendar_event_save / calendar_event_delete。阴阳历与法定节假日离线计算，
 *     日程写在数据目录 calendar/events.json。天气预报走 Open-Meteo，只认设置里的城市名，未填写时不请求。
 *     笔记（默认关闭）：note_browse / note_search / note_get / note_save / note_delete / note_category_save /
 *     note_category_delete。三级结构（类型 › 类别 › 笔记），写在数据目录 notes/notes.json；只经工具召回，不注入提示。
 *     棋类（默认关闭）：board_open / board_look / board_play / board_close / board_reset / board_hint；每种棋的存档在 boards/saves/。棋盘项目克隆在数据目录 boards/，
 *     辅助引擎（Pikafish / Stockfish / Rapfi / KataGo）在设置页按需下载到 boards/assist/，作为独立进程运行，装了才在 board_* 结果里附 hints。
 *     预览在 /dsh-workbench/boards/play。用户名留空时按 user。
 *     牌类（默认关闭）：card_open / card_look / card_play / card_close / card_reset。
 *     可打二十一点、勒杜克、限注德州、UNO 和斗地主。规则源按需下载到数据目录 cards/，不随包分发；
 *     存档按游戏和桌面会话或 Telegram 聊天分开，在 cards/saves/。
 *     预览在 /dsh-workbench/cards/play。对手暗牌在公开前不会出现在工具结果或图片里。
 *     图片字节直接 saveImage，不读环境变量、不落地图文件。
 *     GPT Image 2 生图（默认关闭）：设置页保存 API Key 后注册 image_generate / image_edit（OpenAI 兼容 Images API），
 *     图片写入数据目录 images/<日期>/；「测试连接」只请求 GET {base}/models。两个工具不在 Telegram OPEN_TOOLS，仅授权用户可用。
 *     聊天室（默认关闭）：设置里的席位列表（DSH 服务商 + 模型 + 可选预设人设）与用户同处一个房间轮流发言，记录只追加写在数据目录 chatroom/rooms/；
 *     调用经 DSH 服务商层 ctx.llm.stream，本插件不保存密钥；服务商在 DSH「设置 › 模型」中添加。
 *     核心在 ./chatroom/（不依赖界面，第二阶段 Telegram 群桥复用），接口 /dsh-workbench/api/chatroom/*。
 *     设置项 mapBypassProxy（默认开启）让高德请求直连，不使用系统代理。
 *
 * 前端设置页与工具卡片在 lib/client.js。
 */
import z from 'schemastery'
import { defineTool } from '@dsh/define-tool'
import { COMPONENTS, componentById, createComponentManager, contributeInfo, localComponentsDir, CONTRIBUTE_COMPARE_URL } from './components.mjs'
import { installExitHook as installGamebotExitHook, stopBody as stopGamebotBody } from './components/gamebot/process.mjs'
import { gamebotSchemaShape, legacyConfigCandidates, legacyImportPatch } from './components/gamebot/fields.mjs'
import { dataDir, dirSize, killProcessesUnder, managedPaths, migrateLegacyState, pluginRoot, settingsFilePath, toolsDir } from './tools.mjs'
import { checkForUpdate, getUpdateJob, ignoreVersion, startApplyUpdate } from './updater.mjs'
import { mountSessionControls, handleSessionApi } from './session-controls/index.mjs'
import { createTelegramChannel, telegramSchemaShape, TELEGRAM_BOTS_KEY } from './channels/telegram/index.mjs'
import { classifyPreview, loadLocalFile, mmFileBlock, registerFilePreview, streamFilePreview, textPreview } from './channels/telegram/files.mjs'
import { extractContentPreview } from './channels/telegram/office-preview.mjs'
import { createMapFeature } from './map/index.mjs'
import { createGptImageFeature, handleGptImageApi } from './gpt-image/index.mjs'
import { handleCalendarApi } from './calendar/api.mjs'
import { createCalendarFeature } from './calendar/index.mjs'
import { handleNotesApi } from './notes/api.mjs'
import { createNotesFeature } from './notes/index.mjs'
import { handleBoardsApi, handleBoardsPage } from './boards/api.mjs'
import { createBoardsFeature } from './boards/index.mjs'
import { handleCardsApi, handleCardsPage } from './cards/api.mjs'
import { createCardsFeature } from './cards/index.mjs'
import { createDshCatalog } from './dsh-catalog.mjs'
import { createGatewayTrust } from './gateway-trust/index.mjs'
import { chatroomSchemaShape, createChatroomFeature, migrateLegacyChatroom, LEGACY_CHATROOM_KEYS, CHATROOM_SEATS_KEY } from './chatroom/index.mjs'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { imageSize } from 'image-size'

export { COMPONENTS, componentById, createComponentManager, contributeInfo, localComponentsDir, CONTRIBUTE_COMPARE_URL, dataDir, dirSize, killProcessesUnder, managedPaths, settingsFilePath, toolsDir }

export const name = 'dsh-workbench'
export const inject = ['tools', 'agents', 'sessions', 'sessionController']

const NAMESPACE = 'dsh-workbench'
const API_PREFIX = '/dsh-workbench/api'
const ASSETS_PREFIX = '/dsh-workbench/assets'
// 设置页 POST /settings 回传完整设置（席位、GameBot 字段等，已超过 16 KB），上限放宽到 1 MiB。
const BODY_LIMIT = 1024 * 1024

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
  desktopEnabled: z.boolean().default(false).description('启动桌面控制（按控件操作键鼠和截图；仅 Windows）。插件自带，打开即可，无需下载。不含文件、注册表和 PowerShell。'),
  desktopDock: z.boolean().default(false).description('右侧停靠：开启后，本窗口以最小宽度停靠于屏幕右侧，当前操作的窗口自动铺满左侧。关闭后恢复各窗口原有位置。'),
  notionEnabled: z.boolean().default(false).description('启动官方 Notion MCP（经 mcp-remote OAuth 桥；首次连接会弹出授权页）。'),
  notionUrl: z.string().default('https://mcp.notion.com/mcp').description('Notion MCP 远程地址。'),
  notionPackage: z.string().default('mcp-remote').description('OAuth 桥接用的 npm 包（默认 mcp-remote），「下载安装」时安装到 tools/notion；也可复用 %USERPROFILE%\.dsh\mcp-remote。'),
  gmailEnabled: z.boolean().default(false).description('启动 Gmail（IMAP/SMTP）。地址和密码留空时沿用本机 TRIX 邮件已保存的 Gmail。'),
  gmailAddress: z.string().default('').description('Gmail 地址。留空则使用 TRIX 邮件里已保存的地址。'),
  gmailAppPassword: z.string().role('secret').default('').description('应用专用密码。留空则使用 TRIX 邮件里已保存的密码。'),
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
  'gamebot-visionEnabled': z.boolean().default(false).description('启用 GameBot · 视觉（共享 body + 仅视觉桌面的 MCP）。每次启动默认关闭。'),
  gamebotUrl: z.string().default('http://127.0.0.1:8766').description('GameBot REST 地址（/health、/v1/...）；可跨重启记住。'),
  gamebotRoot: z.string().default('').description('可选：外部 GameBot 目录（含 pyproject.toml + src/gamebot）；留空用插件内嵌 src/components/gamebot。填写时也会从它的 data/game-configs.json 一次性导入旧设置。'),
  nodePath: z.string().default('').description('node 可执行文件（npm 取同目录）。插件 tools/node 里有 Node.js 时优先用它；否则用这里的路径，留空时用 PATH 里的 node，再退回 DSH 自带的运行时。'),
  npmRegistry: z.string().default('').description('npm 镜像地址，例如 https://registry.npmmirror.com；留空用 npm 自己的设置。'),
  sessionControlsEnabled: z.boolean().default(false).description('【实验性】启用会话控制（撤回 / 重试 / 暂停熔断）。默认关闭；此功能尚未开发完毕，启用后可能对对话造成不可逆破坏。设置页保留高级开关；聊天内走消息操作与输入框暂停。'),
  sessionCircuitEnabled: z.boolean().default(true).description('启用自动熔断：同一工具连打、步数过多或思考过长时取消当前回合。'),
  sessionCircuitMaxSameTool: z.natural().min(2).max(50).default(6).description('熔断：同一工具（含相同参数）连续调用达到该次数时取消。'),
  sessionCircuitMaxSteps: z.natural().min(5).max(500).default(80).description('熔断：单回合 step/start 次数上限。'),
  sessionCircuitMaxReasoningChars: z.natural().min(1000).max(5000000).default(200000).description('熔断：单回合累计思考字符上限。'),

  mapEnabled: z.boolean().default(false).description('启用地图工具（地理编码、地点检索、路线规划、天气预报、静态地图卡片、可点击路线图）。路线图打开高德导航页，分享链接可发至手机，不写入高德账号收藏夹。默认关闭。'),
  gaodeApiKey: z.string().role('secret').default('').description('高德 Web 服务 Key。只保存在本设置里，不读取环境变量。'),
  gptImageEnabled: z.boolean().default(false).description('启用 GPT Image 2 生图工具（image_generate / image_edit）。默认关闭。关闭后工具从会话中卸下，已生成的图片仍保留在数据目录 images/。'),
  gptImageApiKey: z.string().role('secret').default('').description('GPT Image 2 生图使用的 API Key。只保存在本设置里，不读取环境变量，不会在接口或日志中以明文返回。'),
  gptImageBaseUrl: z.string().default('https://api.openai.com/v1').description('OpenAI 兼容接口的 Base URL，默认 https://api.openai.com/v1。'),
  gptImageModel: z.string().default('gpt-image-2').description('生图模型名称，默认 gpt-image-2。'),
  gptImageSize: z.string().default('auto').description('默认图片尺寸：auto、1024x1024、1536x1024 或 1024x1536。工具调用时可单独指定。'),
  gptImageQuality: z.string().default('auto').description('默认图片质量：auto、low、medium 或 high。工具调用时可单独指定。'),
  gptImageTimeoutSec: z.natural().min(30).max(900).default(300).description('单次生图请求的超时时间（秒），30–900，默认 300。'),
  mapBypassProxy: z.boolean().default(true).description('绕过代理。开启后高德请求使用独立直连，不附带下载代理或环境变量中的 HTTP 代理。默认开启。'),

  calendarEnabled: z.boolean().default(true).description('启用日历工具（公历、农历、节气、法定节假日、日程、天气预报）。默认开启。关闭后卸下工具，已保存的日程仍保留。'),
  notesEnabled: z.boolean().default(false).description('启用笔记工具：智能体把总结出的要点与知识库中没有的新知识按「类型 › 类别 › 笔记」三级整理，并在后续任务中检索复用。默认关闭。关闭后卸下工具，已保存的笔记仍保留。'),
  boardsEnabled: z.boolean().default(false).description('启用棋类工具：当前会话里的 AI 用 board_open / board_look / board_play / board_close / board_reset / board_hint 下中国象棋、国际象棋、五子棋或围棋。默认关闭。关闭后卸下工具并结束当前棋局，已下载的棋盘项目仍保留。'),
  boardsHintMs: z.number().default(1000).description('辅助引擎每次分析的时长（毫秒），100–10000，默认 1000。只在下载了辅助引擎时生效。'),
  boardsPlayerName: z.string().default('').description('棋盘上你的名字。留空或只有空白时按 user。显示在棋盘你这一侧，并写进人落子后发给 AI 的那句话。'),
  cardsEnabled: z.boolean().default(false).description('启用牌类工具：当前会话里的 AI 用 card_open / card_look / card_play / card_close / card_reset 打二十一点、勒杜克、限注德州、UNO 或斗地主。默认关闭。关闭后卸下工具并收起当前牌桌，已下载的规则源和各会话存档仍保留。'),
  cardsUnoPlayers: z.number().default(4).description('UNO 人数（含您本人），可设 2 至 10 人，默认 4 人。其余座位由插件内置的对手补齐。仅对新开的牌局生效；已有存档按存档中的人数续局。'),
  cardsPlayerName: z.string().default('').description('牌桌上你的名字。留空或只有空白时按 user。你出牌后发给 AI 的句子会带上这个名字。'),
  calendarCity: z.string().default('').description('日历天气预报使用的城市名，例如成都。留空则不请求天气。数据来自 Open-Meteo，不使用高德 Key。请求沿用当前进程的代理。'),

  ...chatroomSchemaShape(z),

  ...telegramSchemaShape(z),

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
 *   kind: 'image' | 'place' | 'calendar' | 'video' | 'webpage' | 'document'
 *   status: 'pending' | 'ready' | 'error' | 'canceled'
 *   progress?: number (0..1 or 0..100)
 *   title?: string
 *   caption?: string
 *   error?: string
 *   asset?: { attachment: ImageRef }
 *   source?: { url?: string, href?: string }
 * Frontend lib/client.js: settled MmCard via conversation.chat.turnTail (turn data mmCards);
 * toolview shows pending/compact only. Prefers meta.mm, then content type:'mm' (legacy),
 * then type:'image'. kind 'place' opens an Amap marker page. kind 'video' and 'document'
 * preview mm_send_file; webpage remains a stub.
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
  let width
  let height
  try {
    const dims = imageSize(data)
    width = dims?.width
    height = dims?.height
  } catch {
    // 损坏或未知格式：保持宽高为 undefined，不中断 mm_send_image
  }
  return {
    full,
    name: basename(full),
    mediaType,
    data,
    bytes: data.length,
    width,
    height,
  }
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        // 不 destroy：断开连接时浏览器只报「Failed to fetch」；丢弃剩余数据，由调用方回 413。
        chunks.length = 0
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 本机开关：显示设置页中隐藏的实验性功能（不写进设置、不进 git）。 */
function showExperimental() {
  if (process.env.DSH_WORK_SHOW_EXPERIMENTAL === '1') return true
  try { return existsSync(join(dataDir(), 'show-experimental')) } catch { return false }
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
  // 「通道」分组：Telegram（默认关闭；启用后才动态加载 lib/channel-telegram.mjs）。
  const telegramSave = { bots: null }
  const telegram = createTelegramChannel(ctx, () => current, {
    persistBots: (bots) => {
      if (!telegramSave.bots) throw Object.assign(new Error('当前环境无法保存设置'), { status: 501 })
      return telegramSave.bots(bots)
    },
  })
  const map = createMapFeature(ctx, () => current)
  const gptImage = createGptImageFeature(ctx, () => current)
  const calendar = createCalendarFeature(ctx, () => current)
  const notes = createNotesFeature(ctx, () => current)
  const boards = createBoardsFeature(ctx, () => current)
  const cards = createCardsFeature(ctx, () => current)
  const dshCatalog = createDshCatalog(ctx)
  // 网关核验：会话级开关，llm/stream 只读采集 + llm-gateway-bench 判定（见 ./gateway-trust）。
  const gatewayTrust = createGatewayTrust(ctx, () => current)
  const chatroom = createChatroomFeature(ctx, () => current, { saveSeats: (seats) => applyPatch({ [CHATROOM_SEATS_KEY]: seats }), savePatch: (patch) => applyPatch(patch) })
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settings && typeof settings.register === 'function') {
    try {
      scope = settings.register(NAMESPACE, RuntimeSettingsSchema, { base: config ?? {}, applies: 'live' })
      current = scope.get()
      scope.watch?.((next) => { current = next; components.sync(); void telegram.sync(); void map.sync(); void gptImage.sync(); void calendar.sync(); void notes.sync(); void boards.sync(); void cards.sync(); void chatroom.sync() })
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

  /** 程序内写设置（不经设置页表单）：ctx.settings 范围或数据目录 settings.json。 */
  async function applyPatch(patch) {
    if (scope) {
      await scope.update(patch)
      current = { ...scope.get(), ...pickLocalEnabled(current) }
    } else {
      current = RuntimeSettingsSchema({ ...current, ...patch })
      if (filePersist) await saveFileSettings(persistableSettings(current))
    }
    await chatroom.sync()
  }
  telegramSave.bots = (bots) => applyPatch({ [TELEGRAM_BOTS_KEY]: bots })
  // 聊天室旧版设置（固定四席位 + 插件内 API Key）→ 席位数组；旧键（含密钥）从设置中清除，密钥不迁移。
  {
    const legacy = migrateLegacyChatroom(current)
    if (legacy.present.length) {
      const cleared = Object.fromEntries(legacy.present.map((k) => [k, /ApiKey$|BaseUrl$|Proxy$/.test(k) ? '' : undefined]))
      const patch = legacy.seats ? { [CHATROOM_SEATS_KEY]: legacy.seats } : {}
      current = RuntimeSettingsSchema({ ...current, ...patch })
      for (const k of legacy.present) delete current[k]
      const snapshot = current
      void (async () => {
        if (scope) await scope.update({ ...cleared, ...patch })
        else if (filePersist) await saveFileSettings(persistableSettings(snapshot))
        ctx.logger?.info?.(`dsh-workbench: chatroom settings migrated (${legacy.seats ? legacy.seats.length + ' seats' : 'seats kept'}; ${legacy.present.length} legacy keys removed; keys not migrated)`)
      })().catch((error) => ctx.logger?.warn?.('dsh-workbench: chatroom settings migration persist failed', error?.message || error))
    }
  }

  // ── 工作组件：各自 fork 一个 dsh-mcp-client 子插件（不写进 profile，随本插件卸载）──
  components.sync()
  void telegram.sync()
  void map.sync()
  void gptImage.sync()
  void calendar.sync()
  void notes.sync()
  void boards.sync()
  void cards.sync()
  void chatroom.sync()
  // 宿主的凭据服务可能晚于本插件就绪：就绪时重新同步一次 Telegram（令牌从 credentials 读取）。
  ctx.inject?.(['credentials'], (credCtx) => {
    credCtx.effect?.(() => { void telegram.resync() }, 'dsh-workbench: telegram credentials')
  })
  ctx.effect?.(() => {
    // GameBot body 是本插件拉起的子进程：宿主退出时同步结束它；插件卸载时等它真正退出。
    const offExit = installGamebotExitHook()
    return async () => {
      offExit()
      components.dispose()
      try { await telegram.dispose() } catch {}
      try { await map.dispose() } catch {}
      try { await gptImage.dispose() } catch {}
      try { await calendar.dispose() } catch {}
      try { await notes.dispose() } catch {}
      try { await boards.dispose() } catch {}
      try { await cards.dispose() } catch {}
      try { await chatroom.dispose() } catch {}
      try { await stopGamebotBody() } catch {}
    }
  }, 'dsh-workbench: components')

  ctx.effect?.(() => {
    const off = gatewayTrust.install()
    return async () => { off(); try { await gatewayTrust.flush() } catch {} gatewayTrust.dispose() }
  }, 'dsh-workbench: gateway-trust')

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
            return sendJson(res, 200, { ok: true, persisted: settingsPersisted(), settingsFile: scope ? null : settingsFilePath(), secretMask: SECRET_MASK, showExperimental: showExperimental(), value: await telegram.decorateSettings(maskSecrets(current), SECRET_MASK) })
          }
          if (sub === '/settings' && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            // Telegram 令牌：写进宿主凭据（credentials 引用），不进插件设置。
            const patch = unmaskPatch(await telegram.absorbSecretPatch(JSON.parse(await readBody(req) || '{}'), SECRET_MASK))
            // 聊天室席位只经 PUT /chatroom/seats 改（表单回传的是旧快照）；旧版聊天室键（含密钥）不再接受。
            delete patch[CHATROOM_SEATS_KEY]
            delete patch[TELEGRAM_BOTS_KEY]
            delete patch.chatroomRules // 只经 PUT /chatroom/config 保存
            for (const k of LEGACY_CHATROOM_KEYS) delete patch[k]
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
            await telegram.sync()
            await map.sync()
            await gptImage.sync()
            await calendar.sync()
            await notes.sync()
            await boards.sync()
            await cards.sync()
            await chatroom.sync()
            return sendJson(res, 200, { ok: true, persisted: settingsPersisted(), settingsFile: scope ? null : settingsFilePath(), secretMask: SECRET_MASK, showExperimental: showExperimental(), value: await telegram.decorateSettings(maskSecrets(current), SECRET_MASK) })
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
              components: [...await components.list(), await telegram.item()],
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
          if (sub === '/update/check' && (req.method === 'GET' || req.method === 'POST')) {
            const urlObj = new URL(req.url ?? '/', 'http://local')
            let force = urlObj.searchParams.get('force') === '1' || urlObj.searchParams.get('force') === 'true'
            if (req.method === 'POST') {
              if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
              try {
                const body = JSON.parse(await readBody(req) || '{}')
                if (body && body.force) force = true
              } catch { /* ignore body parse */ }
            }
            const result = await checkForUpdate({ force, cfg: current })
            return sendJson(res, result.ok === false ? 502 : 200, result)
          }
          if (sub === '/update/apply' && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            let targetVersion = undefined
            try {
              const body = JSON.parse(await readBody(req) || '{}')
              if (body && body.version) targetVersion = String(body.version)
            } catch { /* ignore */ }
            const started = startApplyUpdate({ targetVersion })
            return sendJson(res, 202, { ok: true, ...started })
          }
          if (sub === '/update/ignore' && req.method === 'POST') {
            if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
            const body = JSON.parse(await readBody(req) || '{}')
            return sendJson(res, 200, ignoreVersion(body.version))
          }
          if (sub === '/update/status' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, job: getUpdateJob() })
          }
          if (sub === '/health') return sendJson(res, 200, { ok: true, name, persisted: settingsPersisted() })
          if (sub.startsWith('/gpt-image/')) {
            const handled = await handleGptImageApi(req, res, sub, { sendJson, getConfig: () => current, feature: gptImage })
            if (handled !== false) return
          }
          if (sub === '/calendar' || sub.startsWith('/calendar/')) {
            const handled = await handleCalendarApi(req, res, sub, { sendJson, readBody, getConfig: () => current })
            if (handled !== false) return
          }
          if (sub === '/notes' || sub.startsWith('/notes/')) {
            const handled = await handleNotesApi(req, res, sub, { sendJson, readBody })
            if (handled !== false) return
          }
          if (sub === '/dsh/presets' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...await dshCatalog.presets() })
          }
          if (sub === '/telegram/bots' || sub.startsWith('/telegram/bots/')) {
            if (await telegram.handleApi(req, res, sub, { sendJson, readBody })) return
          }
          if (sub === '/chatroom' || sub.startsWith('/chatroom/')) {
            if (await chatroom.handleApi(req, res, sub, { sendJson, readBody })) return
          }
          if (sub === '/boards' || sub.startsWith('/boards/')) {
            const handled = await handleBoardsApi(req, res, sub, { sendJson, readBody, getConfig: () => current })
            if (handled !== false) return
          }
          if (sub === '/cards' || sub.startsWith('/cards/')) {
            const handled = await handleCardsApi(req, res, sub, { sendJson, readBody, getConfig: () => current })
            if (handled !== false) return
          }
          const filePreview = /^\/file-preview\/([a-f0-9]{32})$/.exec(sub)
          if (filePreview && (req.method === 'GET' || req.method === 'HEAD')) {
            if (req.headers['sec-fetch-site'] === 'cross-site') {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('cross-site request refused')
              return
            }
            return streamFilePreview(req, res, filePreview[1])
          }
          if (sub.startsWith('/trust/')) {
            const handled = await gatewayTrust.handleApi(req, res, sub, { sendJson, readBody })
            if (handled !== false) return
          }
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
      const offBoards = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-workbench/boards',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://local')
            const sub = url.pathname.slice('/dsh-workbench/boards'.length) || '/'
            if (handleBoardsPage(req, res, sub)) return
            res.writeHead(404); res.end('not found')
          } catch (error) {
            res.writeHead(500); res.end(String(error?.message ?? error))
          }
        },
      })
      const offCards = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-workbench/cards',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://local')
            const sub = url.pathname.slice('/dsh-workbench/cards'.length) || '/'
            if (handleCardsPage(req, res, sub)) return
            res.writeHead(404); res.end('not found')
          } catch (error) {
            res.writeHead(500); res.end(String(error?.message ?? error))
          }
        },
      })
      return () => { offApi?.(); offAssets?.(); offBoards?.(); offCards?.() }
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

    imgCtx.tools.register(defineTool({
      name: 'mm_send_file',
      description: 'Send a local file into this chat as a multimodal card. The DSH window previews it by type (image, video, audio, PDF, text; other types show a typed file card). On a Telegram session the same file is delivered as a document, up to 50MB. Pass an absolute or workspace-relative path. Does not fetch remote URLs. In a group, only an authorized user can call this.',
      parameters: {
        path: { type: 'string', required: true, description: 'Local file path. Not a remote URL. Maximum 50MB.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            name: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            mimeType: { type: 'string', required: true },
            previewKind: { type: 'string', required: true },
            previewId: { type: 'string', required: true },
            text: { type: 'string' },
            preview: { type: 'string' },
            attachmentId: { type: 'string', required: true },
            image: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: 'Sent file "' + value.name + '" (' + value.bytes + ' bytes, ' + value.previewKind + ').',
        }],
        presentationMeta: (_args, value) => ({
          path: value.path,
          title: value.name,
          telegramFile: {
            ...(value.attachmentId ? { attachmentId: value.attachmentId } : {}),
            name: value.name,
            bytes: value.bytes,
            path: value.path,
          },
          mm: mmFileBlock(value),
        }),
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const loaded = loadLocalFile(args.path)
        const previewKind = classifyPreview(loaded.name)
        const previewId = registerFilePreview({
          path: loaded.full,
          name: loaded.name,
          mimeType: loaded.mimeType,
          bytes: loaded.bytes,
        })
        const extracted = extractContentPreview(loaded.data, loaded.name)
        const text = extracted?.text || textPreview(loaded.data, previewKind)
        const previewBody = {}
        if (extracted?.rows) previewBody.rows = extracted.rows
        if (extracted?.slides) previewBody.slides = extracted.slides
        const preview = Object.keys(previewBody).length ? JSON.stringify(previewBody) : ''
        const attachments = imgCtx.get('attachments')
        let attachmentId = ''
        let image
        if (previewKind === 'image' && attachments && typeof attachments.saveImage === 'function') {
          try {
            const ref = await attachments.saveImage({
              data: loaded.data,
              mediaType: loaded.mediaType,
              name: loaded.name,
            })
            const id = String(ref?.attachmentId ?? '').trim()
            if (id) {
              image = {
                attachmentId: id,
                mediaType: ref.mediaType || loaded.mimeType,
                bytes: Number(ref.bytes ?? loaded.bytes),
                width: Number(ref.width ?? 0) || 0,
                height: Number(ref.height ?? 0) || 0,
                ...(ref.name || loaded.name ? { name: ref.name || loaded.name } : {}),
              }
            }
          } catch { /* 图片附件存不下时，卡片改走预览地址 */ }
        }
        if (attachments && typeof attachments.saveFile === 'function') {
          try {
            const ref = await attachments.saveFile({ data: loaded.data, name: loaded.name })
            attachmentId = String(ref?.attachmentId ?? '').trim()
          } catch (error) {
            const code = error && error.code
            const message = String(error?.message ?? error)
            if (code !== 'ATTACHMENT_FILES_UNSUPPORTED' && !message.includes('verbatim files')) throw error
          }
        }
        return {
          path: loaded.full,
          name: loaded.name,
          bytes: loaded.bytes,
          mimeType: loaded.mimeType,
          previewKind,
          previewId,
          ...(text ? { text } : {}),
          ...(preview ? { preview } : {}),
          attachmentId,
          ...(image ? { image } : {}),
        }
      },
    }))
  })
}
