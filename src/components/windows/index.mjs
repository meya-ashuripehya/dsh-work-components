/**
 * 工作组件：windows（Windows-MCP）
 * @see ../../../docs/component-module.md
 * 上游：https://github.com/CursorTouch/Windows-MCP （PyPI windows-mcp）
 */
import { installVenvTool, packageName } from '../../tools.mjs'
import { IS_WIN, managedEntry, NOT_INSTALLED, OFF, resolveUvx, stdio, http, systemUvToolExe } from '../shared.mjs'
import { mcpNotReady, result } from '../../connect-lib.mjs'

export const id = 'windows'

/** 本机桌面即目标；无独立「应用进程」可匹配。 */
export const app = { name: 'Windows 桌面', exe: 'explorer.exe', match: /^explorer$/ }

export const meta = {
  id: 'windows',
  title: 'Windows',
  group: '工作组件',
  url: 'https://github.com/CursorTouch/Windows-MCP',
  serverName: 'windows',
  summary: '控制本机 Windows 桌面（Windows-MCP）：窗口、键鼠、截图、文件系统、注册表、PowerShell 等。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'windows',
  label: 'Windows',
  url: 'https://github.com/CursorTouch/Windows-MCP',
  serverName: 'windows',
  summary: '控制本机 Windows 桌面（Windows-MCP）：窗口、键鼠、截图、文件系统、注册表、PowerShell 等。',
  keys: ['windowsEnabled', 'windowsMode', 'windowsUrl', 'windowsPackage', 'uvPath'],
  spec: (cfg) => cfg.windowsPackage || 'windows-mcp',
  installed(cfg) {
    const spec = this.spec(cfg)
    return !!managedEntry('windows', spec, 'windows-mcp') || !!systemUvToolExe('windows-mcp', 'windows-mcp')
  },
  // HTTP 模式连接已在运行的 Windows-MCP，无需安装。
  needsInstall(cfg) { return cfg.windowsMode !== 'http' },
  install(cfg, task, hooks) {
    const spec = this.spec(cfg)
    return installVenvTool(task, { id: 'windows', spec, entry: 'windows-mcp', beforeReplace: hooks.beforeReplace })
  },
  launch(cfg) {
    if (!cfg.windowsEnabled) return OFF
    if (!IS_WIN) return { ok: false, reason: 'Windows-MCP 只在 Windows 上可用' }
    if (cfg.windowsMode === 'http') {
      const url = String(cfg.windowsUrl || 'http://127.0.0.1:18765/mcp').trim()
      let u
      try { u = new URL(url) } catch { return { ok: false, reason: `HTTP 地址无效：${url}` } }
      if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: `只支持 http(s)：${url}` }
      return { ok: true, source: 'remote', config: http('windows', url) }
    }
    const spec = this.spec(cfg)
    const args = ['serve', '--transport', 'stdio']
    const exe = managedEntry('windows', spec, 'windows-mcp')
    if (exe) return { ok: true, source: 'managed', config: stdio('windows', exe, args) }
    const sys = systemUvToolExe('windows-mcp', 'windows-mcp')
    if (sys) return { ok: true, source: 'system', config: stdio('windows', sys, args) }
    const uvx = resolveUvx(cfg)
    if (!uvx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
    return { ok: true, source: uvx.source, viaUvx: true, config: stdio('windows', uvx.path, [spec, ...args]) }
  },
  note(cfg) {
    if (cfg.windowsMode === 'http') {
      return 'HTTP 模式：需本机已有 Windows-MCP 在监听（例如计划任务启动的 127.0.0.1:18765）。改用「stdio」可由本插件直接拉起，不必再开独立服务。'
    }
    return null
  },
}

export async function probe(ctx) {
  if (ctx.cfg.windowsMode === 'http') {
    let u
    try { u = new URL(String(ctx.cfg.windowsUrl || 'http://127.0.0.1:18765/mcp').trim()) } catch {
      return result('unreachable', 'HTTP 地址无效', 'socket')
    }
    const host = (u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '')
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    const ok = await ctx.env.tcpOpen(host === 'localhost' ? '127.0.0.1' : host, port)
    if (!ok) return result('no-app', `无法连接 Windows-MCP HTTP ${u.host}：请确认计划任务 / 服务已启动，或改用 stdio 模式由插件启动`, 'socket')
    return result('connected', `Windows-MCP HTTP ${u.host} 可连接`, 'socket')
  }
  const nr = mcpNotReady(ctx, this); if (nr) return nr
  return result('connected', 'Windows-MCP（stdio）已挂载', 'mcp')
}

export default component
