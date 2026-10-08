/**
 * 工作组件：blender
 * @see ../../../docs/component-module.md
 */
import { installVenvTool, packageName } from '../../tools.mjs'
import { managedEntry, NOT_INSTALLED, resolveUvx, stdio } from '../shared.mjs'
import { appRunning, mcpNotReady, noAppFor, result } from '../../connect-lib.mjs'

export const id = 'blender'

export const app = { name: 'Blender', exe: 'blender.exe', match: /^blender$/ }

export const meta = {
  id: 'blender',
  title: 'Blender',
  group: '工作组件',
  url: 'https://github.com/ahujasid/blender-mcp',
  serverName: 'blender',
  summary: '控制正在打开的 Blender（mcp-for-blender），Blender 里需要启用对应插件。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'blender',
    label: 'Blender',
    url: 'https://github.com/ahujasid/blender-mcp',
    serverName: 'blender',
    summary: '控制正在打开的 Blender（mcp-for-blender），Blender 里需要启用对应插件。',
    keys: ['blenderEnabled', 'blenderPackage', 'uvPath'],
    spec: (cfg) => cfg.blenderPackage || 'mcp-for-blender',
    installed(cfg) { const spec = this.spec(cfg); return !!managedEntry('blender', spec, packageName(spec)) },
    install(cfg, task, hooks) {
      const spec = this.spec(cfg)
      return installVenvTool(task, { id: 'blender', spec, entry: packageName(spec), beforeReplace: hooks.beforeReplace })
    },
    launch(cfg) {
      if (!cfg.blenderEnabled) return { ok: false, reason: '已在设置中停用' }
      const spec = this.spec(cfg)
      const exe = managedEntry('blender', spec, packageName(spec))
      if (exe) return { ok: true, source: 'managed', config: stdio('blender', exe, []) }
      const uvx = resolveUvx(cfg)
      if (!uvx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
      return { ok: true, source: uvx.source, viaUvx: true, config: stdio('blender', uvx.path, [spec]) }
    },
  }

export async function probe(ctx) {
    if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    const host = ctx.env.env.BLENDER_HOST || 'localhost'
    const port = Number(ctx.env.env.BLENDER_PORT) || 9876
    // 服务器用 Python 的 IPv4 socket 连 localhost，这里同样连 127.0.0.1。
    const ok = await ctx.env.tcpOpen(host === 'localhost' ? '127.0.0.1' : host, port)
    if (!ok) return result('unreachable', `Blender 正在运行，但无法连接 MCP 插件端口 ${host}:${port}：请在 Blender 侧栏 BlenderMCP 面板中点击 Connect / Start MCP Server`, 'socket')
    return result('connected', `Blender 插件端口 ${host}:${port} 可连接`, 'socket')
  
}

export default component
