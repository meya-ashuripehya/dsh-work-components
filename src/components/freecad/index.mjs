/**
 * 工作组件：freecad（社区 neka-nat/freecad-mcp，MIT；stdio 服务器 + FreeCAD 内的 MCP Addon）
 * 默认命令 uvx freecad-mcp；选项 --host、--only-text-feedback；令牌经环境变量 FREECAD_MCP_TOKEN 传入。
 */
import { OFF } from '../shared.mjs'
import { commandPlan, probeCommon } from '../launch-util.mjs'

export const id = 'freecad'
export const app = { name: 'FreeCAD', exe: 'FreeCAD.exe', match: /^freecad$/i }
export const DEFAULT_COMMAND = 'uvx freecad-mcp'
export const RPC_PORT = 9875
const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1'])

export const meta = {
  id: 'freecad', title: 'FreeCAD', group: '工作组件', url: 'https://github.com/neka-nat/freecad-mcp', serverName: 'freecad',
  summary: 'FreeCAD MCP（社区，MIT）：FreeCAD 中运行 MCP Addon 的 RPC 服务器，插件只启动用户的 uvx freecad-mcp。仅所有者可用。',
}

export function planFor(cfg, deps = {}) {
  if (!cfg.freecadEnabled) return OFF
  const host = String(cfg.freecadHost || '').trim()
  const args = []
  if (!LOCAL.has(host)) {
    if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return { ok: false, reason: `主机名无效：${host}` }
    args.push('--host', host)
  }
  if (cfg.freecadTextOnly) args.push('--only-text-feedback')
  const env = {}
  const token = String(cfg.freecadToken || '').trim()
  if (token) env.FREECAD_MCP_TOKEN = token
  return commandPlan('freecad', String(cfg.freecadCommand || '').trim() || DEFAULT_COMMAND, { ...deps, cfg, args, env })
}

export const component = {
  id: 'freecad', label: 'FreeCAD', url: meta.url, serverName: 'freecad',
  summary: 'FreeCAD MCP（社区，stdio，uvx freecad-mcp）。',
  keys: ['freecadEnabled', 'freecadCommand', 'freecadHost', 'freecadTextOnly', 'freecadToken'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note() { return '需在 FreeCAD 中安装 MCP Addon，切到 MCP Addon 工作台并点「Start RPC Server」（可勾选 Auto-Start Server）。execute_code 可在 FreeCAD 中运行任意 Python。' },
}

export async function probe(ctx) {
  const host = String(ctx.cfg?.freecadHost || '').trim()
  const local = LOCAL.has(host)
  return probeCommon(ctx, this, { app: local ? app : undefined, label: 'FreeCAD MCP', port: local ? { host: 'localhost', port: RPC_PORT, hint: '请在 FreeCAD 的 MCP Addon 工作台点「Start RPC Server」' } : undefined })
}

export default component