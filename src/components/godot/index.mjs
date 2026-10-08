/**
 * 工作组件：godot
 * @see ../../../docs/component-module.md
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GODOT_MIN_VERSION, MARKER, fetchGodotAddon, godotAddonReady, installGodotAddonToProject,
  installVenvTool, killProcessesUnder, managedPaths, readMarker, resolveGodotProject, venvBin,
} from '../../tools.mjs'
import { godotArgs, managedEntry, NOT_INSTALLED, OFF, stdio } from '../shared.mjs'
import { appRunning, appRunningIn, callMcpTool, jsonOf, mcpNotReady, noAppFor, result, toolFailed } from '../../connect-lib.mjs'

export const id = 'godot'

export const app = { name: 'Godot 编辑器', exe: 'Godot_v4.x-stable_win64.exe', match: /^godot(?![-_ ]?ai\b)/ }

export const meta = {
  id: 'godot',
  title: 'Godot',
  group: '工作组件',
  url: 'https://github.com/hi-godot/godot-ai',
  serverName: 'godot',
  summary: `控制 Godot 编辑器（hi-godot/godot-ai），需要 Godot ${GODOT_MIN_VERSION}+，项目里要装同版本的 Godot AI 插件。`,
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'godot',
    label: 'Godot',
    url: 'https://github.com/hi-godot/godot-ai',
    serverName: 'godot',
    summary: `控制 Godot 编辑器（hi-godot/godot-ai），需要 Godot ${GODOT_MIN_VERSION}+，项目里要装同版本的 Godot AI 插件。`,
    // godotProject 只给「安装插件到项目」用，改了不需要重挂。
    keys: ['godotEnabled', 'godotPackage', 'godotHttpPort', 'godotWsPort'],
    spec: (cfg) => cfg.godotPackage || 'godot-ai',
    installed(cfg) { return !!managedEntry('godot', this.spec(cfg), 'godot-ai') },
    /** 替换 / 删除 tools/godot 前：attach 起的共享后端是脱离的 pythonw 进程，DSH 停掉组件后它还会空转约 2 分钟，先结束它释放 venv 里的文件。 */
    beforeRemove(log) { return killProcessesUnder(managedPaths().dir('godot'), log) },
    install(cfg, task, hooks) {
      const self = this
      return installVenvTool(task, {
        id: 'godot',
        spec: this.spec(cfg),
        entry: 'godot-ai',
        // cryptography：给 godot_ai.release_verify 校验插件签名用（godot-ai 的运行依赖里没有它）。
        extraPackages: ['cryptography'],
        beforeReplace: async () => { await hooks.beforeReplace(); await self.beforeRemove(task.log) },
        // 插件包下载失败不算安装失败：服务器照常可用，「安装插件到项目」时会再试。
        afterInstall: async ({ dir, python, version }) => {
          try {
            return { addon: await fetchGodotAddon(task, { dir, python, version }) }
          } catch (error) {
            task.log(`同版本 Godot 插件下载失败（执行「安装插件到项目」时将重试）：${error.message}`)
            return { addon: null }
          }
        },
      })
    },
    launch(cfg) {
      if (!cfg.godotEnabled) return OFF
      const spec = this.spec(cfg)
      const exe = managedEntry('godot', spec, 'godot-ai')
      // 不用 uvx 兜底：临时运行的版本不固定，Godot 里的插件版本对不上会被拒绝。
      if (!exe) return { ok: false, missing: true, reason: `${NOT_INSTALLED(spec)}（固定版本，Godot 项目中的插件须为同一版本）` }
      // v4 只接受 attach（stdio 桥，带鉴权）；裸的 http://127.0.0.1:8000/mcp 连不上。关闭匿名统计（attach 起的后端继承这个环境变量）。
      return { ok: true, source: 'managed', config: stdio('godot', exe, godotArgs(cfg), { env: { GODOT_AI_DISABLE_TELEMETRY: 'true', PYTHONIOENCODING: 'utf-8' } }) }
    },
    /** 管理页安装行下面的说明：装的是哪个版本、Godot 项目里的插件要装哪个版本。 */
    note(cfg) {
      const m = managedPaths()
      const marker = this.installed(cfg) ? readMarker(m.dir('godot')) : null
      if (!marker?.version) return `需要 Godot ${GODOT_MIN_VERSION}+。「下载安装」将安装 godot-ai 服务器，并下载同版本、已校验签名的 Godot 插件，之后可一键安装到 Godot 项目。`
      const v = marker.version
      const addon = marker.addon && marker.addon.version === v && godotAddonReady(m.dir('godot'))
        ? `同版本插件已下载并校验签名（${marker.addon.files} 个文件）。填写项目路径后，点击「安装插件到项目」。`
        : `同版本插件包尚未下载（执行「安装插件到项目」时将重试）；也可从 GitHub Release v${v} 手动下载 godot-ai-v4-plugin.zip 并解压到项目根目录（得到 addons/godot_ai/plugin.cfg）。`
      return `服务器 godot-ai ${v}（已固定）：Godot 项目中的插件 addons/godot_ai/plugin.cfg 也须为 ${v}；需要 Godot ${GODOT_MIN_VERSION}+。${addon}`
    },
    /** 把同版本插件装进 Godot 项目（先校验项目路径；插件包缺了就先下载）。 */
    async installAddon(cfg, project, { procs, log } = {}) {
      resolveGodotProject(project)
      const spec = this.spec(cfg)
      if (!managedEntry('godot', spec, 'godot-ai')) throw httpError(409, '未安装 godot-ai 服务器：请完成「下载安装」后重试')
      const m = managedPaths()
      const dir = m.dir('godot')
      const marker = readMarker(dir) || {}
      const version = marker.version
      if (!version) throw httpError(409, '安装记录中缺少 godot-ai 版本，请「重新安装」')
      const python = venvBin(m.venv('godot'), 'python')
      if (!(marker.addon && marker.addon.version === version && godotAddonReady(dir))) {
        const task = { proxy: cfg.proxy || '', step() {}, log: (l) => log?.(l) }
        try {
          marker.addon = await fetchGodotAddon(task, { dir, python, version })
        } catch (error) {
          throw httpError(502, `下载同版本的 Godot 插件失败：${error.message}（请检查「通用 → 下载代理」，或从 GitHub Release v${version} 手动下载 godot-ai-v4-plugin.zip 并解压到项目根目录）`)
        }
        await writeFile(join(dir, MARKER), JSON.stringify(marker, null, 2))
      }
      let running = false
      try { running = appRunningIn(await procs?.(), 'godot') } catch {}
      return installGodotAddonToProject({ project, dir, python, version, godotRunning: running })
    },
  }

export async function probe(ctx) {
    if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    const hint = '在 Godot 里打开装了 Godot AI 插件的项目，并在「项目 → 项目设置 → 插件」里启用它（插件版本要和服务器一致，端口和编辑器设置 godot_ai/http_port、ws_port 一致）'
    let session = null
    // 工具报错可能是抛异常，也可能是 isError 的结果（看 dsh-mcp-client 怎么转），两种都算失败。
    const asFailure = (r) => (r.ok && r.value?.isError ? { ok: false, error: r.text || '工具返回错误' } : r)
    const list = asFailure(await callMcpTool(ctx.tools, this.serverName, 'session_manage', { op: 'list', params: {} }))
    if (list.ok) {
      const data = jsonOf(list)
      const sessions = Array.isArray(data?.sessions) ? data.sessions : null
      if (sessions && sessions.length === 0) return result('unreachable', `Godot 正在运行，但尚无编辑器连接 godot-ai：${hint}`, 'tool:session_manage')
      session = sessions ? (sessions.find((x) => x && x.is_active) || sessions[0]) : null
    } else if (!list.missing) {
      return toolFailed(list, `Godot 在运行，但 session_manage 失败：${list.error}`, 'tool:session_manage')
    }
    const st = asFailure(await callMcpTool(ctx.tools, this.serverName, 'editor_state', {}))
    if (!st.ok) {
      if (/no active godot session|no_active_session|not connected/i.test(st.error)) return result('unreachable', `Godot 正在运行，但尚无编辑器连接 godot-ai：${hint}`, 'tool:editor_state')
      return toolFailed(st, `Godot 编辑器已连上，但 editor_state 失败：${st.error}`, 'tool:editor_state')
    }
    const raw = jsonOf(st)
    const info = raw && typeof raw.data === 'object' && raw.data ? raw.data : (raw || {})
    const project = info.project_name || session?.name || ''
    const gv = info.godot_version || session?.godot_version || ''
    const extra = []
    if (gv) extra.push(`Godot ${gv}`)
    if (session?.plugin_version) extra.push(`插件 ${session.plugin_version}`)
    const mismatch = session?.plugin_version && session?.server_version && session.plugin_version !== session.server_version
      ? `；注意插件 ${session.plugin_version} 和服务器 ${session.server_version} 版本不一致` : ''
    return result('connected', `Godot 编辑器已连接${project ? `：${project}` : ''}${extra.length ? `（${extra.join('，')}）` : ''}（editor_state）${mismatch}`, 'tool:editor_state')
  
}

export default component
