/**
 * 工作组件：rhino
 *   - official（默认）：McNeel 官方 Rhino MCP Platform（RhinoAI，MIT）。Rhino 8 包管理器安装插件，
 *     stdio 路由 rhino-mcp-router --default-version 8（完整命令由 Rhino 命令 MCPConnect 打印）。
 *   - community：jingcheng-chen/rhinomcp（MIT），uvx rhinomcp，经 TCP 127.0.0.1:1999 连 Rhino 插件（Rhino 中运行 mcpstart）。
 */
import { OFF } from '../shared.mjs'
import { commandPlan, probeCommon } from '../launch-util.mjs'

export const id = 'rhino'
export const app = { name: 'Rhino', exe: 'Rhino.exe', match: /^rhino$/i }
export const SOURCES = ['official', 'community']
export const VERSIONS = ['8', '9']

export const meta = {
  id: 'rhino', title: 'Rhino', group: '工作组件', url: 'https://github.com/mcneel/RhinoAI', serverName: 'rhino',
  summary: 'Rhino MCP：默认官方 Rhino MCP Platform（rhino-mcp-router，Rhino 8），可改用社区 rhinomcp。仅所有者可用。',
}

export const sourceOf = (cfg) => (cfg?.rhinoSource === 'community' ? 'community' : 'official')
const portOf = (cfg) => { const n = Number(String(cfg?.rhinoPort || '').trim() || 1999); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null }

export function planFor(cfg, deps = {}) {
  if (!cfg.rhinoEnabled) return OFF
  const custom = String(cfg.rhinoCommand || '').trim()
  if (sourceOf(cfg) === 'official') {
    const ver = VERSIONS.includes(String(cfg.rhinoVersion)) ? String(cfg.rhinoVersion) : '8'
    if (custom) return commandPlan('rhino', custom, { ...deps, cfg })
    return commandPlan('rhino', 'rhino-mcp-router', { ...deps, cfg, args: ['--default-version', ver] })
  }
  const port = portOf(cfg)
  if (!port) return { ok: false, reason: `端口无效：${cfg.rhinoPort}` }
  const env = { RHINO_MCP_HOST: '127.0.0.1', RHINO_MCP_PORT: String(port) }
  if (cfg.rhinoScripts === false) Object.assign(env, { RHINO_MCP_ENABLE_RUN_COMMAND: '0', RHINO_MCP_ENABLE_RHINOSCRIPT: '0', RHINO_MCP_ENABLE_CSHARP: '0' })
  return commandPlan('rhino', custom || 'uvx rhinomcp', { ...deps, cfg, env })
}

export const component = {
  id: 'rhino', label: 'Rhino', url: meta.url, serverName: 'rhino',
  summary: 'Rhino MCP（官方路由或社区 rhinomcp，stdio）。',
  keys: ['rhinoEnabled', 'rhinoSource', 'rhinoCommand', 'rhinoVersion', 'rhinoPort', 'rhinoScripts'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note(cfg) {
    return sourceOf(cfg) === 'official'
      ? '官方：在 Rhino 8 运行 PackageManager 安装 Rhino-MCP-Platform，再运行 MCPConnect 查看路由命令；不在 PATH 时把完整命令填入「启动命令」。'
      : '社区：在 Rhino 8 包管理器安装 rhinomcp，每次打开 Rhino 后运行 mcpstart。只运行一个 RhinoMCP 服务器。'
  },
}

export async function probe(ctx) {
  const cfg = ctx.cfg || {}
  const community = sourceOf(cfg) === 'community'
  return probeCommon(ctx, this, {
    app, label: community ? 'RhinoMCP（社区）' : 'Rhino MCP（官方）',
    port: community && portOf(cfg) ? { host: 'localhost', port: portOf(cfg), hint: '请在 Rhino 命令行运行 mcpstart' } : undefined,
  })
}

export default component