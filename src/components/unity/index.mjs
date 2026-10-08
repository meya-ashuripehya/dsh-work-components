/**
 * 工作组件：unity
 * @see ../../../docs/component-module.md
 */
import { installVenvTool } from '../../tools.mjs'
import { managedEntry, NOT_INSTALLED, resolveUvx, stdio } from '../shared.mjs'
import { appRunning, mcpNotReady, noAppFor, result } from '../../connect-lib.mjs'

export const id = 'unity'

export const app = { name: 'Unity 编辑器', exe: 'Unity.exe', match: /^unity$/ }

export const meta = {
  id: 'unity',
  title: 'Unity',
  group: '工作组件',
  url: 'https://github.com/CoplayDev/unity-mcp',
  serverName: 'unity',
  summary: '控制 Unity 编辑器（Coplay mcp-for-unity），编辑器需装 MCP for Unity 包并开着工程。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'unity',
    label: 'Unity',
    url: 'https://github.com/CoplayDev/unity-mcp',
    serverName: 'unity',
    summary: '控制 Unity 编辑器（Coplay mcp-for-unity），编辑器需装 MCP for Unity 包并开着工程。',
    keys: ['unityEnabled', 'unityPackage', 'uvPath'],
    spec: (cfg) => cfg.unityPackage || 'mcpforunityserver',
    installed(cfg) { return !!managedEntry('unity', this.spec(cfg), 'mcp-for-unity') },
    install(cfg, task, hooks) {
      return installVenvTool(task, { id: 'unity', spec: this.spec(cfg), entry: 'mcp-for-unity', beforeReplace: hooks.beforeReplace })
    },
    launch(cfg) {
      if (!cfg.unityEnabled) return { ok: false, reason: '已在设置中停用' }
      const spec = this.spec(cfg)
      const args = ['--transport', 'stdio']
      const exe = managedEntry('unity', spec, 'mcp-for-unity')
      if (exe) return { ok: true, source: 'managed', config: stdio('unity', exe, args) }
      const uvx = resolveUvx(cfg)
      if (!uvx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
      return { ok: true, source: uvx.source, viaUvx: true, config: stdio('unity', uvx.path, ['--from', spec, 'mcp-for-unity', ...args]) }
    },
  }

export async function probe(ctx) {
    if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    const dir = ctx.env.env.UNITY_MCP_STATUS_DIR || join(ctx.env.home(), '.unity-mcp')
    const ports = []
    const projects = new Map()
    try {
      const files = readdirSync(dir).filter((f) => /^unity-mcp-(status|port)-.*\.json$|^unity-mcp-port\.json$/.test(f))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const { f } of files) {
        try {
          const data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
          if (Number.isInteger(data.unity_port) && !ports.includes(data.unity_port)) {
            ports.push(data.unity_port)
            if (data.project_path) projects.set(data.unity_port, String(data.project_path).split(/[\\/]/).filter(Boolean).pop())
          }
        } catch {}
      }
    } catch {}
    if (!ports.includes(6400)) ports.push(6400)
    for (const port of ports.slice(0, 4)) {
      if (await ctx.env.unityPing(port)) {
        const project = projects.get(port)
        return result('connected', `MCP for Unity 桥接端口 ${port} 应答 pong${project ? `（工程 ${project}）` : ''}`, 'socket')
      }
    }
    return result('unreachable', `Unity 在运行，但 MCP for Unity 桥接没有应答（试过端口 ${ports.slice(0, 4).join(' / ')}）：在 Unity 里打开 Window → MCP for Unity 并启动桥接`, 'socket')
  
}

export default component
