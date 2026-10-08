/**
 * 工作组件：obsidian
 *
 * 上游：cyanheads/obsidian-mcp-server — https://github.com/cyanheads/obsidian-mcp-server
 * npm：obsidian-mcp-server（`npx -y obsidian-mcp-server` / 装进 tools/obsidian）
 * 选型理由：在 Local REST API 之上暴露 14 个工具（读写/搜索/章节补丁/frontmatter/标签等），
 * 维护活跃；比仅 7 工具的 mcp-obsidian（Python）更全。插件自带 MCP HTTP 端点可作为备选，
 * 但本组件走可装进 tools/ 的 stdio 包，与 Chrome/Figma 一致。
 *
 * 安装：设置页「下载安装」→ tools/obsidian（npm）。
 * 本机前提：Obsidian 应用打开，并安装启用社区插件「Local REST API」
 * （https://github.com/coddingtonbear/obsidian-local-rest-api，建议开 Non-encrypted HTTP）。
 *
 * 拟议 SettingsSchema 键（CN）：
 * - obsidianEnabled（启用）：默认关
 * - obsidianPackage（npm 包名）：默认 obsidian-mcp-server，可带版本
 * - obsidianApiKey（API 密钥）：Local REST API 插件设置页中的 Bearer Token，必填才能启动
 * - obsidianBaseUrl（API 地址）：默认 http://127.0.0.1:27123（HTTP）；HTTPS 可用 https://127.0.0.1:27124
 * - obsidianEnableCommands（允许执行命令面板）：可选，对应 OBSIDIAN_ENABLE_COMMANDS
 * - nodePath（node 路径）：共用
 *
 * @see ../../../docs/component-module.md
 */
import { installNpmTool, managedNpmEntry, npmLaunch, OFF } from '../shared.mjs'
import { appRunning, mcpNotReady, noAppFor, result } from '../../connect-lib.mjs'

export const id = 'obsidian'

export const app = { name: 'Obsidian', exe: 'Obsidian.exe', match: /^obsidian$/ }

export const meta = {
  id: 'obsidian',
  title: 'Obsidian',
  group: '工作组件',
  url: 'https://github.com/cyanheads/obsidian-mcp-server',
  serverName: 'obsidian',
  summary: '读写本机 Obsidian 库（obsidian-mcp-server，经 Local REST API 插件）。需要 Obsidian 开着并启用该插件。',
}

function baseUrl(cfg) {
  return String(cfg.obsidianBaseUrl || 'http://127.0.0.1:27123').trim().replace(/\/+$/, '')
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'obsidian',
  label: 'Obsidian',
  url: 'https://github.com/cyanheads/obsidian-mcp-server',
  serverName: 'obsidian',
  runtime: 'node',
  summary: '读写本机 Obsidian 库（obsidian-mcp-server，经 Local REST API 插件）。需要 Obsidian 开着并启用该插件。',
  keys: ['obsidianEnabled', 'obsidianPackage', 'obsidianApiKey', 'obsidianBaseUrl', 'obsidianEnableCommands', 'nodePath'],
  spec: (cfg) => cfg.obsidianPackage || 'obsidian-mcp-server',
  bin: 'obsidian-mcp-server',
  installed(cfg) { return !!managedNpmEntry('obsidian', this.spec(cfg)) },
  install(cfg, task, hooks) { return installNpmTool(this, cfg, task, hooks) },
  launch(cfg) {
    if (!cfg.obsidianEnabled) return OFF
    const key = String(cfg.obsidianApiKey || '').trim()
    if (!key) {
      return {
        ok: false,
        reason: '请填写 Obsidian Local REST API 的 API 密钥（Obsidian → 设置 → 社区插件 → Local REST API）',
      }
    }
    const env = {
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'info',
      OBSIDIAN_API_KEY: key,
      OBSIDIAN_BASE_URL: baseUrl(cfg),
      OBSIDIAN_VERIFY_SSL: 'false',
    }
    if (cfg.obsidianEnableCommands) env.OBSIDIAN_ENABLE_COMMANDS = 'true'
    return npmLaunch(this, cfg, [], env)
  },
  note() {
    return '需要 Obsidian 桌面版，并安装启用社区插件「Local REST API」（建议开启 Non-encrypted HTTP，默认 http://127.0.0.1:27123）。在插件设置里复制 API 密钥填到下方。「下载安装」只装 MCP 桥接包，不会替你装 Obsidian 或插件。'
  },
}

export async function probe(ctx) {
  if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
  let u
  try {
    u = new URL(baseUrl(ctx.cfg))
  } catch {
    return result('unreachable', 'Obsidian API 地址无效', 'socket')
  }
  const hostRaw = (u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '')
  const host = hostRaw === 'localhost' ? '127.0.0.1' : hostRaw
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  const open = await ctx.env.tcpOpen(host, port)
  if (!open) {
    return result(
      'unreachable',
      `Obsidian 正在运行，但无法连接 Local REST API ${host}:${port}：请确认已启用该插件并开启「Non-encrypted (HTTP) Server」（或改用 HTTPS 地址 https://127.0.0.1:27124）`,
      'socket',
    )
  }
  const nr = mcpNotReady(ctx, this)
  if (nr) return nr
  return result('connected', `Local REST API ${host}:${port} 可连接，Obsidian MCP 已就绪`, 'socket')
}

export default component
