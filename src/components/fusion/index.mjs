/**
 * 工作组件：fusion（Autodesk Fusion 内置的官方 Fusion MCP Server，本机 streamable-http）
 * 文档：https://help.autodesk.com/view/ADSKMCP/ENU/ ；在 Fusion「Preferences → General → API → Fusion MCP Server」开启，
 * 默认 http://127.0.0.1:27182/mcp（端口以 Fusion 中显示为准）。插件不安装任何东西。
 */
import { http, OFF } from '../shared.mjs'
import { result } from '../../connect-lib.mjs'
import { checkUrl, probeCommon } from '../launch-util.mjs'

export const id = 'fusion'
export const app = { name: 'Autodesk Fusion', exe: 'Fusion360.exe', match: /^fusion360$/i }
export const DEFAULT_URL = 'http://127.0.0.1:27182/mcp'

export const meta = {
  id: 'fusion', title: 'Autodesk Fusion', group: '工作组件', url: 'https://help.autodesk.com/view/ADSKMCP/ENU/', serverName: 'fusion',
  summary: 'Fusion 内置的官方 MCP Server（本机 HTTP，默认端口 27182）。需在 Fusion 首选项中开启。仅所有者可用。',
}

export const component = {
  id: 'fusion', label: 'Autodesk Fusion', url: meta.url, serverName: 'fusion',
  summary: 'Autodesk Fusion 官方 MCP（本机 HTTP）。',
  keys: ['fusionEnabled', 'fusionUrl'],
  installed() { return true },
  launch(cfg) {
    if (!cfg.fusionEnabled) return OFF
    const c = checkUrl(cfg.fusionUrl, DEFAULT_URL)
    if (c.reason) return { ok: false, reason: c.reason }
    return { ok: true, source: 'remote', config: http('fusion', c.url) }
  },
  note() {
    return '请在 Fusion「Preferences → General → API」勾选 Fusion MCP Server 并点「Apply」。服务器没有只读模式：fusion_mcp_read 等工具只读，fusion_mcp_execute / fusion_mcp_update 会改动设计。'
  },
}

export async function probe(ctx) {
  const c = checkUrl(ctx.cfg?.fusionUrl, DEFAULT_URL)
  if (c.reason) return result('unreachable', c.reason, 'config')
  const port = Number(c.u.port) || (c.u.protocol === 'https:' ? 443 : 80)
  return probeCommon(ctx, this, { app, label: 'Fusion MCP', port: { host: c.u.hostname, port, hint: '请在 Fusion 首选项中开启 Fusion MCP Server，并确认端口一致' } })
}

export default component