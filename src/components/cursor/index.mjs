/**
 * 工作组件（仓库自带、已验证）：Cursor
 * ---------------------------------------------------------------------------
 * 上游：cursor-delegate-mcp（MIT）  https://github.com/andreilungeanu/cursor-delegate-mcp
 *       npm 包名：cursor-delegate-mcp   入口：src/server.js   bin：cursor-delegate-mcp
 *
 * 它做什么：把「多文件编码任务」委派给本机 Cursor 的 CLI 智能体（cursor-agent），
 * 走的是 **ACP（Agent Client Protocol）** 而不是简单的 `cursor-agent --print`：
 *   - 真会话：session/new + session/load（resumeSessionId 续聊同一会话）
 *   - 三种模式：agent（真正落盘改文件）/ plan（只出计划）/ ask（只读问答）
 *   - 每次调用可选 model / fast / effort / context，并带 contextFiles 附件
 *   - 自动批准权限请求，返回结构化结果：最终答复、改动文件清单、session id、计划
 *   - 另有 cancel（取消/杀进程）与 doctor（自检）两个工具
 *
 * 为什么选它（对比见会话记录）：功能最全 —— ACP 会话生命周期 + 真落盘实现 + 计划模式 +
 * 模型/思考档位选择 + 取消 + 自检，且有 CI、SECURITY.md、已进官方 MCP Registry，2026-10 仍在活跃维护。
 *
 * 前置条件（本组件不代装）：
 *   1) 本机已安装 Cursor CLI：`cursor-agent`（Windows：%LocalAppData%\cursor-agent\cursor-agent.cmd）
 *   2) 已登录且套餐含 agent 用量：`cursor-agent login`
 *   3) Node.js >= 20（本机 v22.23.2 满足）
 *
 * 本文件只声明「安装元数据 + 启动计划」，**不会**联网下载任何东西；
 * 真正的下载由设置页「下载安装」按钮触发 component.install 落到 tools/cursor/。
 *
 * 与已有的 dsh-cursor-acp 插件互补、不冲突：那个走 DSH 自己的 ACP 客户端；本组件把 Cursor
 * 能力暴露成 MCP 工具 mcp__cursor__delegate / mcp__cursor__cancel / mcp__cursor__doctor。
 *
 * SettingsSchema（已写入 src/index.mjs，空字符串表示用上游默认）：
 *   cursorEnabled:        z.boolean().default(false)                 // 启用键，缺省关闭
 *   cursorPackage:        z.string().default('cursor-delegate-mcp')  // npm 包名
 *   cursorAgentCommand:   z.string().default('')                     // → ACP_AGENT_COMMAND，空=按 PATH 解析 cursor-agent
 *   cursorAgentArgs:      z.string().default('')                     // → ACP_AGENT_ARGS，空=内置 ['acp']
 *   cursorTranscript:     z.string().default('')                     // → CURSOR_DELEGATE_TRANSCRIPT，ACP 转录落盘路径
 *   cursorHandshakeMs:    z.string().default('')                     // → CURSOR_DELEGATE_HANDSHAKE_MS
 *   cursorHardCapMs:      z.string().default('')                     // → CURSOR_DELEGATE_HARD_CAP_MS，空=3600000
 *   cursorIdleMs:         z.string().default('')                     // → CURSOR_DELEGATE_IDLE_MS，空=0（关闭空闲超时）
 *   cursorLogSize:        z.string().default('')                     // → ACP_LOG_SIZE
 *
 * 拟议的 INPUT_FIELDS（中文 label / desc）：
 *   { key:'cursorAgentCommand', label:'cursor-agent 路径', desc:'留空则按 PATH 解析；'
 *     + 'Windows 通常为 %LocalAppData%\\cursor-agent\\cursor-agent.cmd。填错会导致委派失败。', placeholder:'C:\\Users\\<你>\\AppData\\Local\\cursor-agent\\cursor-agent.cmd' }
 *   { key:'cursorHardCapMs', label:'单次委派硬上限（毫秒）', desc:'超过即终止该次委派；留空用上游默认 3600000（1 小时）。', placeholder:'3600000' }
 *   { key:'cursorIdleMs', label:'空闲超时（毫秒）', desc:'长时间无输出即终止；留空/0 表示不启用。', placeholder:'0' }
 *   { key:'cursorTranscript', label:'ACP 转录文件', desc:'可选。填绝对路径后，每次委派的 ACP 报文会写进该文件，便于排查。', placeholder:'C:\\Users\\<你>\\cursor-acp.log' }
 *   { key:'cursorAgentArgs', label:'cursor-agent 启动参数', desc:'高级项。留空用上游默认 acp；改错会直接连不上。', placeholder:'acp' }
 *   { key:'cursorLogSize', label:'ACP 日志条数', desc:'高级项。留空用上游默认。', placeholder:'' }
 */

import { installNpmTool, managedNpmEntry, npmLaunch, OFF } from '../shared.mjs'
import { appRunning, callMcpTool, mcpNotReady, noAppFor, result, toolFailed } from '../../connect-lib.mjs'

/** 组件 id：必须与文件夹名、component.id 三者一致（小写 kebab，未占用任何 bundled id）。 */
export const id = 'cursor'

/** 上游仓库 / 组件元信息。serverName 决定工具前缀 mcp__cursor__，选定后不要改。 */
export const meta = {
  id,
  title: 'Cursor',
  group: '工作组件',
  url: 'https://github.com/andreilungeanu/cursor-delegate-mcp',
  serverName: 'cursor',
  summary:
    '把编码任务委派给本机 Cursor 的 CLI 智能体（cursor-delegate-mcp，经 ACP）：agent/plan/ask 三种模式、'
    + '真落盘改文件、可续会话、可选模型与思考档位、返回改动文件清单，另有取消与自检。需先装好并登录 cursor-agent。',
}

/**
 * 进程探测用的目标程序。
 * 注意：cursor-agent 是 CLI —— Windows 上它是 cursor-agent.cmd，实际子进程名是 node.exe，
 * 无法按名字匹配，所以这里只认 Cursor 桌面版进程；CLI 是否可用由 probe 里的 doctor 工具判定。
 * match 对着 listProcesses() 返回的「小写、已去 .exe」进程名。
 */
export const app = {
  name: 'Cursor 桌面版',
  exe: 'Cursor.exe（桌面版）/ cursor-agent（CLI）',
  match: /^(cursor|cursor-?insiders)$/,
}

/** 取字符串设置项，去空白；空串视为未设置。 */
function text(value) {
  return String(value ?? '').trim()
}

/** 取数字类设置项，仅在是正整数时转成字符串塞进环境变量。 */
function num(value) {
  const s = text(value)
  if (!s) return ''
  return /^\d+$/.test(s) ? s : ''
}

/** 从工具返回的文本里抠出第一个 JSON 对象。 */
function parseJson(raw) {
  const s = text(raw)
  if (!s) return null
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 诊断文本过长时截断，避免探测结果里塞进整段日志。 */
function clip(raw, max = 240) {
  const s = text(raw).replace(/\s+/g, ' ')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 只读探测。不会拉起 Cursor 桌面版，也不启动智能体回合：
 * `doctor`（非 deep）只做启动器解析 + `cursor-agent --version` 版本探测，不带 ACP 握手。
 *
 * 流程（CLI 型目标的例外分支）：mcpNotReady → doctor 工具 → 成功即 connected
 * （即使没有 Cursor 桌面版进程，CLI 照样能独立工作）；仅当工具失败且也没有匹配进程时才 no-app。
 */
export async function probe(ctx) {
  const procs = await ctx.procs()
  const ideRunning = appRunning(procs, app)

  const notReady = mcpNotReady(ctx, component)
  if (notReady) return notReady

  const r = await callMcpTool(ctx.tools, component.serverName, 'doctor', { deep: false })
  if (!r?.ok) {
    const why = r?.error || (r?.missing ? '委派工具未注册' : '未知错误')
    if (ideRunning) return toolFailed(r, `Cursor 桌面版在运行，但委派桥接不可用：${why}`, 'tool:doctor')
    return noAppFor(app, `；委派桥接不可用：${why}`)
  }

  const info = parseJson(r.text)
  if (!info) return result('unreachable', `Cursor 诊断返回无法解析：${clip(r.text)}`, 'tool:doctor')

  const agent = info.agent || {}
  if (agent.found === false) {
    const why = agent.error || `未解析到启动器（${agent.command || 'cursor-agent acp'}）`
    if (ideRunning) {
      return result('unreachable', `Cursor 桌面版在运行，但未找到可用的 cursor-agent CLI：${why}`, 'tool:doctor')
    }
    return noAppFor(app, `；未找到可用的 cursor-agent CLI：${why}`)
  }

  const ver = agent.version ? `cursor-agent ${agent.version}` : 'cursor-agent 版本未报告'
  const ide = ideRunning ? 'Cursor 桌面版在运行' : '未见 Cursor 桌面版进程（CLI 可独立运行）'
  return result('connected', `委派桥接就绪：${ver}；${ide}`, 'tool:doctor')
}

/** 注册给宿主的组件对象。 */
export const component = {
  id,
  label: meta.title,
  url: meta.url,
  serverName: meta.serverName,
  summary: meta.summary,

  /**
   * 变更后需要重挂 MCP 的设置键。
   * 这些键都在 SettingsSchema 里，改动后重挂 MCP。空字符串表示用上游默认。
   */
  keys: [
    'cursorEnabled',
    'cursorPackage',
    'cursorAgentCommand',
    'cursorAgentArgs',
    'cursorTranscript',
    'cursorHandshakeMs',
    'cursorHardCapMs',
    'cursorIdleMs',
    'cursorLogSize',
    'nodePath',
    'npmRegistry',
  ],

  /** npm 包组件。 */
  runtime: 'node',

  /** npm 包名（spec），设置项 cursorPackage 可覆盖。 */
  spec: (cfg) => text(cfg.cursorPackage) || 'cursor-delegate-mcp',

  /** 包内可执行文件（package.json 的 bin 名），install 时用它解析入口。 */
  bin: 'cursor-delegate-mcp',

  /** 是否已落到运行时目录 tools/cursor/（读 .dsh-workbench.json 标记）。 */
  installed: (cfg) => !!managedNpmEntry(id, component.spec(cfg)),

  /**
   * 设置页「下载安装」入口。只声明，不在本任务里执行：
   * 由宿主在用户点按钮时调用，产物落在 tools/cursor/（toolsDir()）。
   */
  async install(cfg, task, hooks) {
    return installNpmTool(component, cfg, task, hooks)
  },

  /**
   * 启动计划。
   * 关闭判定：仅显式 true 才挂载；缺键 / false 都返回 OFF。
   */
  launch(cfg) {
    if (cfg.cursorEnabled !== true) return OFF

    const env = {}
    const command = text(cfg.cursorAgentCommand)
    if (command) env.ACP_AGENT_COMMAND = command
    const agentArgs = text(cfg.cursorAgentArgs)
    if (agentArgs) env.ACP_AGENT_ARGS = agentArgs
    const transcript = text(cfg.cursorTranscript)
    if (transcript) env.CURSOR_DELEGATE_TRANSCRIPT = transcript
    const logSize = num(cfg.cursorLogSize)
    if (logSize) env.ACP_LOG_SIZE = logSize
    const handshakeMs = num(cfg.cursorHandshakeMs)
    if (handshakeMs) env.CURSOR_DELEGATE_HANDSHAKE_MS = handshakeMs
    const hardCapMs = num(cfg.cursorHardCapMs)
    if (hardCapMs) env.CURSOR_DELEGATE_HARD_CAP_MS = hardCapMs
    const idleMs = num(cfg.cursorIdleMs)
    if (idleMs) env.CURSOR_DELEGATE_IDLE_MS = idleMs

    // 该 MCP 服务器是纯 stdio、不接命令行参数，全部配置走环境变量。
    return npmLaunch(component, cfg, [], env)
  },

  /** 设置页展示的说明文案。 */
  note() {
    return [
      '需要本机已安装并登录 Cursor CLI：cursor-agent（Windows 装在 %LocalAppData%\\cursor-agent\\），',
      '先在终端跑一次 `cursor-agent login`。登录的是 CLI，和 Cursor 桌面版的登录是两套凭据。',
      '',
      '挂载后提供三个工具（前缀 mcp__cursor__）：',
      '  · delegate —— 委派编码任务（参数 spec / mode=agent|plan|ask / workspace / model / fast / effort / context / contextFiles / resumeSessionId）',
      '  · cancel   —— 按 sessionId 取消进行中的委派（force 可强杀进程）',
      '  · doctor   —— 自检（deep=true 会做一次 ACP 握手并列出可用模型与模式）',
      '',
      '默认值：model=composer-2.5，fast=false，effort 不传，mode=agent（agent 模式会真的改文件）。',
      '用量口径：Composer / Grok 走 Cursor 的「Cursor Models」额度池，与第三方模型额度分开计。',
      '',
      '若委派失败，先调 doctor（deep=true）看 agent.found 与可用模型清单；',
      '若提示找不到 cursor-agent，用「cursor-agent 路径」设置项填绝对路径。',
    ].join('\n')
  },
}

export default component
