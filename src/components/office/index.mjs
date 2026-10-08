/**
 * 工作组件：office
 * @see ../../../docs/component-module.md
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { installOffice, managedPaths, pluginRoot } from '../../tools.mjs'
import { IS_WIN, NOT_INSTALLED, resolveUv, stdio } from '../shared.mjs'
import { appRunning, callMcpTool, mcpNotReady, noAppFor, result, toolFailed } from '../../connect-lib.mjs'

export const id = 'office'

export const app = { name: 'Office（Word / Excel / PowerPoint 等）', exe: 'WINWORD / EXCEL / POWERPNT', match: /^(winword|excel|powerpnt|visio|msaccess|winproj|outlook|mspub|onenote|wps|et|wpp|microsoft (word|excel|powerpoint))$/ }

export const meta = {
  id: 'office',
  title: 'Office',
  group: '工作组件',
  url: 'https://github.com/officemcp/officemcp',
  serverName: 'officemcp',
  summary: '经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP）。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'office',
    label: 'Office',
    url: 'https://github.com/officemcp/officemcp',
    serverName: 'officemcp',
    summary: '经 COM 控制本机的 Word / Excel / PowerPoint（OfficeMCP）。',
    keys: ['officeEnabled', 'officeRepo', 'officeFolder', 'uvPath'],
    installed() {
      const m = managedPaths()
      return existsSync(m.officePython) && existsSync(join(m.officeRepo, 'pyproject.toml'))
    },
    // 设置中指定了 OfficeMCP 仓库（或插件旁有 ../officemcp）时经 uv run 启动，无需安装。
    needsInstall(cfg) {
      return !(cfg.officeRepo || existsSync(join(pluginRoot(), '..', 'officemcp', 'pyproject.toml')))
    },
    install(cfg, task, hooks) {
      return installOffice(task, { beforeReplace: hooks.beforeReplace })
    },
    launch(cfg) {
      if (!cfg.officeEnabled) return { ok: false, reason: '已在设置中停用' }
      if (!IS_WIN) return { ok: false, reason: 'OfficeMCP 依赖 Windows COM，只在 Windows 上启动' }
      const root = pluginRoot()
      const launcher = join(root, 'office', 'launch.py')
      if (!existsSync(launcher)) return { ok: false, reason: `未找到启动脚本：${launcher}` }
      // OfficeMCP 自己的默认目录是 D:\@OfficeMCP，没有 D 盘的机器上会启动即崩，所以退到用户文档目录。
      const folder = cfg.officeFolder || (existsSync('D:\\') ? '' : join(homedir(), 'Documents', 'OfficeMCP'))
      const folderArgs = folder ? ['--folder', folder] : []
      const extra = {
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        reconnect: { enabled: true, initialDelayMs: 2000, maxDelayMs: 60000, maxAttempts: 5 },
      }
      // 1) 插件 tools/officemcp：直接用它 venv 里的 python，不经 uv、不联网。
      const m = managedPaths()
      if (this.installed()) {
        return { ok: true, source: 'managed', config: stdio('officemcp', m.officePython, [launcher, ...folderArgs], { ...extra, cwd: m.officeRepo }) }
      }
      // 2) 设置里的仓库 / 3) 插件旁边的 ../officemcp：照旧经 uv run（--with pillow 给 ScreenShot 用）。
      const repo = resolve(cfg.officeRepo || join(root, '..', 'officemcp'))
      if (!existsSync(join(repo, 'pyproject.toml'))) {
        return { ok: false, missing: true, reason: cfg.officeRepo ? `未找到 OfficeMCP 仓库：${repo}` : NOT_INSTALLED('OfficeMCP') }
      }
      const uv = resolveUv(cfg)
      if (!uv) return { ok: false, missing: true, reason: '未找到 uv：请点击「下载安装」（将同时安装 uv 与 OfficeMCP）' }
      const args = ['run', '--quiet', '--directory', repo, '--with', 'pillow', 'python', launcher, ...folderArgs]
      return { ok: true, source: cfg.officeRepo ? 'setting' : 'system', config: stdio('officemcp', uv.path, args, { ...extra, cwd: repo }) }
    },
  }

export async function probe(ctx) {
    if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    const r = await callMcpTool(ctx.tools, this.serverName, 'RunningApps')
    if (!r.ok) return toolFailed(r, `Office 程序在运行，但 RunningApps 失败：${r.error}`, 'tool:RunningApps')
    let apps = r.value?.structuredContent?.result
    if (!Array.isArray(apps)) { try { apps = JSON.parse(r.text) } catch { apps = null } }
    if (!Array.isArray(apps)) apps = (r.text.match(/\b(Word|Excel|PowerPoint|Visio|Access|MSProject|Outlook|Publisher|OneNote|Kwps|Ket|Kwpp)\b/g) || [])
    apps = [...new Set(apps.map(String))]
    if (!apps.length) return result('unreachable', 'Office 程序正在运行，但 COM 中未找到（可能刚启动尚未注册，或以管理员身份运行）', 'tool:RunningApps')
    return result('connected', `COM 可连接：${apps.join('、')}（RunningApps）`, 'tool:RunningApps')
  
}

export default component
