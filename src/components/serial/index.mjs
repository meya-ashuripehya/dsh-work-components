/**
 * 工作组件：serial（社区 es617/serial-mcp-server，MIT，stdio，pyserial）
 * 默认 uvx --from serial-mcp-server serial_mcp。工具名分隔符固定为「_」（模型接口不接受带点的工具名）。
 * 插件默认关闭（插件会运行任意 Python 代码）；追踪默认关闭，免得在 DSH 的工作目录写 .serial_mcp。
 */
import { OFF } from '../shared.mjs'
import { commandPlan, probeCommon } from '../launch-util.mjs'

export const id = 'serial'
export const app = { name: '串口', exe: '—', match: /$^/ }
export const DEFAULT_COMMAND = 'uvx --from serial-mcp-server serial_mcp'

export const meta = {
  id: 'serial', title: '串口', group: '工作组件', url: 'https://github.com/es617/serial-mcp-server', serverName: 'serial',
  summary: '串口 MCP（社区 serial-mcp-server，MIT）：列出串口、收发数据、控制 DTR / RTS。可配合 ESP-IDF 使用。仅所有者可用。',
}

export function planFor(cfg, deps = {}) {
  if (!cfg.serialEnabled) return OFF
  const env = { SERIAL_MCP_TOOL_SEPARATOR: '_', SERIAL_MCP_TRACE: '0' }
  const plugins = String(cfg.serialPlugins || '').trim()
  if (plugins) {
    if (!/^(all|[A-Za-z0-9_\-]+(\s*,\s*[A-Za-z0-9_\-]+)*)$/.test(plugins)) return { ok: false, reason: `插件名单无效：${plugins}` }
    env.SERIAL_MCP_PLUGINS = plugins.replace(/\s+/g, '')
  }
  return commandPlan('serial', String(cfg.serialCommand || '').trim() || DEFAULT_COMMAND, { ...deps, cfg, env })
}

export const component = {
  id: 'serial', label: '串口', url: meta.url, serverName: 'serial',
  summary: '串口 MCP（serial-mcp-server，stdio）。',
  keys: ['serialEnabled', 'serialCommand', 'serialPlugins'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note() { return '向串口写数据会直接作用于真实设备。串口被本服务占用时，其他程序（含 idf.py monitor）无法同时打开。' },
}

export async function probe(ctx) { return probeCommon(ctx, this, { label: '串口 MCP' }) }

export default component