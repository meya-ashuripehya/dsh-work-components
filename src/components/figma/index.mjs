/**
 * 工作组件：figma
 * @see ../../../docs/component-module.md
 */
import { FIGMA_OFFICIAL_URL, http, installNpmTool, managedNpmEntry, npmLaunch, OFF } from '../shared.mjs'
import { appRunning, callMcpTool, mcpNotReady, noAppFor, result, toolFailed } from '../../connect-lib.mjs'

export const id = 'figma'

export const app = { name: 'Figma 桌面版', exe: 'Figma.exe', match: /^figma( beta)?$/ }

export const meta = {
  id: 'figma',
  title: 'Figma',
  group: '工作组件',
  url: 'https://github.com/southleft/figma-console-mcp',
  serverName: 'figma',
  summary: '读写 Figma 设计稿（figma-console-mcp，经 Figma 桌面版里的 Desktop Bridge 插件）；也可以改连官方 Figma 桌面版 MCP。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'figma',
    label: 'Figma',
    url: 'https://github.com/southleft/figma-console-mcp',
    serverName: 'figma',
    runtime: 'node',
    summary: '读写 Figma 设计稿（figma-console-mcp，经 Figma 桌面版里的 Desktop Bridge 插件）；也可以改连官方 Figma 桌面版 MCP。',
    keys: ['figmaEnabled', 'figmaMode', 'figmaToken', 'figmaOfficialUrl', 'figmaPackage', 'nodePath'],
    spec: (cfg) => cfg.figmaPackage || 'figma-console-mcp',
    bin: 'figma-console-mcp',
    installed(cfg) { return !!managedNpmEntry('figma', this.spec(cfg)) },
    // 官方桌面版 MCP 模式直接连接 HTTP 地址，无需安装。
    needsInstall(cfg) { return cfg.figmaMode !== 'official' },
    install(cfg, task, hooks) { return installNpmTool(this, cfg, task, hooks) },
    launch(cfg) {
      if (!cfg.figmaEnabled) return OFF
      if (cfg.figmaMode === 'official') {
        const url = String(cfg.figmaOfficialUrl || FIGMA_OFFICIAL_URL).trim()
        let u
        try { u = new URL(url) } catch { return { ok: false, reason: `官方 MCP 地址无效：${url}` } }
        if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: `官方 MCP 地址只支持 http(s)：${url}` }
        return { ok: true, source: 'remote', config: http('figma', url) }
      }
      const env = {}
      if (cfg.figmaToken && cfg.figmaToken.trim()) env.FIGMA_ACCESS_TOKEN = cfg.figmaToken.trim()
      return npmLaunch(this, cfg, [], env)
    },
  }

export async function probe(ctx) {
    if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
    if (ctx.cfg.figmaMode === 'official') {
      let u
      try { u = new URL(String(ctx.cfg.figmaOfficialUrl || 'http://127.0.0.1:3845/mcp').trim()) } catch { return result('unreachable', '官方 MCP 地址无效', 'socket') }
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const ok = await ctx.env.tcpOpen(host === 'localhost' ? '127.0.0.1' : host, port)
      if (!ok) return result('unreachable', `Figma 正在运行，但无法连接官方 MCP 地址 ${u.host}：请在 Figma 桌面版 Dev Mode 中启用「桌面版 MCP 服务器」`, 'socket')
      return result('connected', `官方 MCP 地址 ${u.host} 可连接`, 'socket')
    }
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    const r = await callMcpTool(ctx.tools, this.serverName, 'figma_get_status')
    if (!r.ok) return toolFailed(r, `Figma 在运行，但 figma_get_status 失败：${r.error}`, 'tool:figma_get_status')
    let st = null
    try { st = JSON.parse(r.text) } catch {}
    const ws = st?.transport?.websocket
    if (!ws?.available) {
      return result('unreachable', 'Figma 正在运行，但 Desktop Bridge 插件未连接：请在设计文件中运行「插件 → 开发 → Figma Desktop Bridge」', 'tool:figma_get_status')
    }
    const file = ws.connectedFile?.fileName || (st.currentFileName && !/^\(unable/.test(st.currentFileName) ? st.currentFileName : '')
    return result('connected', `Desktop Bridge 已连上${file ? `：${file}` : ''}（figma_get_status）`, 'tool:figma_get_status')
  
}

export default component
