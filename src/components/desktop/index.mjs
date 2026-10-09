/**
 * 通用功能：desktop（桌面控制）
 * @see ../../../docs/component-module.md
 *
 * 经纪人随插件提供（src/components/desktop/broker/dist）。
 * 打开「启用」即拉起，不需要「下载安装」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { callMcpTool, jsonOf, mcpNotReady, result, toolFailed } from '../../connect-lib.mjs'
import { pluginRoot } from '../../tools.mjs'
import { IS_WIN, OFF, stdio } from '../shared.mjs'

export const id = 'desktop'

/** 随包的自包含经纪人。pluginRoot 在构建后是包目录。 */
export const BROKER_EXE = join(pluginRoot(), 'src', 'components', 'desktop', 'broker', 'dist', 'DSHDesktopBroker.exe')

/** 本机桌面即目标；无独立「应用进程」可匹配。 */
export const app = { name: 'Windows 桌面', exe: 'explorer.exe', match: /^explorer$/ }

export const meta = {
  id: 'desktop',
  title: '桌面控制',
  group: '通用',
  serverName: 'desktop',
  summary: '按控件操作本机 Windows 桌面（键鼠、截图）。插件自带，打开启用即可。不含文件、注册表和 PowerShell。',
}

const MISSING = '插件里没有找到桌面控制程序。'

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'desktop',
  label: '桌面控制',
  serverName: 'desktop',
  summary: meta.summary,
  keys: ['desktopEnabled'],
  builtin: true,
  installed() { return true },
  launch(cfg) {
    if (!cfg.desktopEnabled) return OFF
    if (!IS_WIN) return { ok: false, reason: '桌面控制只在 Windows 上可用' }
    if (!existsSync(BROKER_EXE)) return { ok: false, reason: MISSING }
    return { ok: true, source: 'managed', runtime: '随插件提供', config: stdio('desktop', BROKER_EXE, []) }
  },
}

export async function probe(ctx) {
  const nr = mcpNotReady(ctx, this)
  if (nr) return nr
  const r = await callMcpTool(ctx.tools, this.serverName, 'status')
  if (!r.ok) return toolFailed(r, `桌面控制已挂载，但 status 失败：${r.error}`, 'tool:status')
  const body = jsonOf(r)
  const warning = body?.integrityWarning ? String(body.integrityWarning) : ''
  const access = body?.uiAccess === true ? 'UIAccess 已生效' : '可操作与本进程相同完整性的窗口'
  const detail = `桌面控制已挂载，${access}` + (warning ? `。${warning}` : '')
  return result('connected', detail, 'tool:status')
}

export default component
