/**
 * 工作组件：matlab（MathWorks 官方 matlab-mcp-server，Go 可执行文件，stdio）
 * 参数（README「Arguments」）：--matlab-root、--initial-working-folder、--matlab-display-mode、
 * --matlab-session-mode、--disable-telemetry。许可：只能按 MathWorks 软件许可协议与 MATLAB 一起使用，不得多人共用。
 */
import { existsSync } from 'node:fs'
import { OFF, IS_WIN, stdio } from '../shared.mjs'
import { findOnPath, probeCommon, unquote } from '../launch-util.mjs'

export const id = 'matlab'
export const app = { name: 'MATLAB', exe: 'MATLAB.exe', match: /^matlab$/i }
export const EXE_NAMES = IS_WIN ? ['matlab-mcp-server-windows-x64.exe', 'matlab-mcp-server.exe'] : ['matlab-mcp-server']
export const DISPLAY_MODES = ['desktop', 'nodesktop']
export const SESSION_MODES = ['auto', 'new', 'existing']

export const meta = {
  id: 'matlab', title: 'MATLAB', group: '工作组件', url: 'https://github.com/matlab/matlab-mcp-server', serverName: 'matlab',
  summary: 'MathWorks 官方 MATLAB MCP Server（stdio）。只能按 MathWorks 许可与 MATLAB 一起使用。仅所有者可用。',
}

export function planFor(cfg, { exists = existsSync, env = process.env } = {}) {
  if (!cfg.matlabEnabled) return OFF
  let exe = unquote(cfg.matlabServerPath)
  let source = 'setting'
  if (exe) { if (!exists(exe)) return { ok: false, reason: `未找到 MATLAB MCP Server：${exe}` } }
  else {
    exe = findOnPath(EXE_NAMES, { env, exists })
    source = 'system'
    if (!exe) return { ok: false, reason: '未找到 MATLAB MCP Server：请从 GitHub Releases 下载 matlab-mcp-server-windows-x64.exe，并在设置中填写路径。' }
  }
  const session = SESSION_MODES.includes(cfg.matlabSessionMode) ? cfg.matlabSessionMode : 'auto'
  const args = [`--matlab-session-mode=${session}`]
  // existing 模式不能与 matlab-root / initial-working-folder / matlab-display-mode 同时使用（README）
  if (session !== 'existing') {
    const root = unquote(cfg.matlabRoot)
    if (root) args.push(`--matlab-root=${root}`)
    const wf = unquote(cfg.matlabWorkFolder)
    if (wf) args.push(`--initial-working-folder=${wf}`)
    args.push(`--matlab-display-mode=${DISPLAY_MODES.includes(cfg.matlabDisplayMode) ? cfg.matlabDisplayMode : 'desktop'}`)
  }
  if (!cfg.matlabTelemetry) args.push('--disable-telemetry=true')
  return { ok: true, source, config: stdio('matlab', exe, args) }
}

export const component = {
  id: 'matlab', label: 'MATLAB', url: meta.url, serverName: 'matlab',
  summary: 'MATLAB 官方 MCP Server（stdio）。',
  keys: ['matlabEnabled', 'matlabServerPath', 'matlabRoot', 'matlabWorkFolder', 'matlabDisplayMode', 'matlabSessionMode', 'matlabTelemetry'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note() { return '需要 MATLAB R2021a 或更新版本。MATLAB MCP Server 只能按 MathWorks 软件许可协议与 MATLAB 一起使用，且不得多人共用。evaluate_matlab_code 会运行任意 MATLAB 代码。' },
}

export async function probe(ctx) {
  // 服务器会在首次调用工具时自行启动 MATLAB，所以不要求 MATLAB 已在运行
  return probeCommon(ctx, this, { label: 'MATLAB MCP', extra: `会话模式 ${SESSION_MODES.includes(ctx.cfg?.matlabSessionMode) ? ctx.cfg.matlabSessionMode : 'auto'}` })
}

export default component