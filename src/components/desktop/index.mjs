/**
 * 通用功能：desktop（桌面控制）
 * @see ../../../docs/component-module.md
 *
 * 发布包不再内置经纪人 exe（体积超过严格市场的 50 MiB 上限）。
 * 开发树里若已有 broker/dist，直接使用；否则只能在用户点击「下载安装」后，
 * 按 broker-manifest.json 校验并安装。不要在 npm postinstall 里下载。
 */
import { callMcpTool, jsonOf, mcpNotReady, result, toolFailed } from '../../connect-lib.mjs'
import { dataDir, download, pluginRoot } from '../../tools.mjs'
import { IS_WIN, OFF, stdio } from '../shared.mjs'
import {
  STATUS,
  brokerState,
  bundledBrokerExe,
  installBroker,
  loadManifest,
} from './broker-install.mjs'

export const id = 'desktop'

export const BROKER_EXE = bundledBrokerExe(pluginRoot())

/** 本机桌面即目标；无独立「应用进程」可匹配。 */
export const app = { name: 'Windows 桌面', exe: 'explorer.exe', match: /^explorer$/ }

export const meta = {
  id: 'desktop',
  title: '桌面控制',
  group: '通用',
  serverName: 'desktop',
  summary: '按控件操作本机 Windows 桌面（键鼠、截图）。启用前需下载校验过的经纪人。不含文件、注册表和 PowerShell。',
}

const MISSING = '桌面控制程序还没安装。请先在设置页下载安装。'

function currentBroker() {
  return brokerState({
    bundled: BROKER_EXE,
    dataDir: dataDir(),
    manifest: loadManifest(pluginRoot()),
  })
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'desktop',
  label: '桌面控制',
  serverName: 'desktop',
  summary: meta.summary,
  keys: ['desktopEnabled', 'desktopDock'],
  builtin: false,
  installed() { return currentBroker().state === STATUS.READY },
  needsInstall() { return !this.installed() },
  async install(_cfg, task) {
    const manifest = loadManifest(pluginRoot())
    task?.step?.('正在下载桌面经纪人')
    task?.log?.(`GET ${manifest.assets?.['win32-x64']?.url || '(无清单)'}`)
    return installBroker({
      manifest,
      dataDir: dataDir(),
      download: (url, dest, opts) => download(url, dest, {
        ...opts,
        proxy: task?.proxy,
        log: task?.log,
        timeoutMs: 120_000,
      }),
    })
  },
  launch(cfg) {
    if (!cfg.desktopEnabled) return OFF
    if (!IS_WIN) return { ok: false, reason: '桌面控制只在 Windows 上可用' }
    const broker = currentBroker()
    if (broker.state === STATUS.CHECKSUM_FAILED) return { ok: false, reason: '桌面经纪人校验失败，未启动。' }
    if (broker.state === STATUS.INSTALLING) return { ok: false, reason: '桌面经纪人正在安装。' }
    if (broker.state !== STATUS.READY || !broker.exe) return { ok: false, reason: MISSING }
    const env = cfg.desktopDock ? { DSH_DESKTOP_DOCK: '1' } : {}
    const runtime = broker.source === 'bundled' ? '本地构建' : '已校验安装'
    return { ok: true, source: 'managed', runtime, config: stdio('desktop', broker.exe, [], { env }) }
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
