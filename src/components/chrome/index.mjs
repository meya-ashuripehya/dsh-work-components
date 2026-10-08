/**
 * 工作组件：chrome
 * @see ../../../docs/component-module.md
 */
import { chromeArgs, installNpmTool, managedNpmEntry, npmLaunch, OFF } from '../shared.mjs'
import {
  appRunning, callMcpTool, chromeDefaultUserDataDir, chromeProfileDir, listPages,
  mcpNotReady, noAppFor, readDevToolsPort, result, toolFailed,
} from '../../connect-lib.mjs'

export const id = 'chrome'

export const app = { name: 'Chrome', exe: 'chrome.exe', match: /^(chrome|google chrome( beta| dev| canary)?)$/ }

export const meta = {
  id: 'chrome',
  title: 'Chrome',
  group: '工作组件',
  url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  serverName: 'chrome',
  summary: '控制本机的 Google Chrome（Chrome DevTools MCP）：网页操作、截图快照、网络 / 控制台、性能分析、设备模拟等。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
    id: 'chrome',
    label: 'Chrome',
    url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    serverName: 'chrome',
    runtime: 'node',
    summary: '控制本机的 Google Chrome（Chrome DevTools MCP）：网页操作、截图快照、网络 / 控制台、性能分析、设备模拟等。',
    keys: ['chromeEnabled', 'chromePackage', 'chromeConnect', 'chromeBrowserUrl', 'chromeChannel', 'chromeHeadless', 'chromeUserDataDir', 'chromeToolset', 'nodePath'],
    spec: (cfg) => cfg.chromePackage || 'chrome-devtools-mcp',
    bin: 'chrome-devtools-mcp',
    installed(cfg) { return !!managedNpmEntry('chrome', this.spec(cfg)) },
    install(cfg, task, hooks) { return installNpmTool(this, cfg, task, hooks) },
    launch(cfg) {
      if (!cfg.chromeEnabled) return OFF
      // 关掉 Google 的使用统计和 npm 更新检查（更新由「重新安装」负责）。
      const env = { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' }
      return npmLaunch(this, cfg, chromeArgs(cfg), env)
    },
  }

export async function probe(ctx) {
    const mode = ctx.cfg.chromeConnect || 'launch'
    if (mode === 'browserUrl') {
      const base = String(ctx.cfg.chromeBrowserUrl || 'http://127.0.0.1:9222').trim().replace(/\/+$/, '')
      let host = '127.0.0.1', port = 9222
      try {
        const u = new URL(base)
        host = (u.hostname || '127.0.0.1').replace(/^\[|\]$/g, '')
        if (host === 'localhost') host = '127.0.0.1'
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
      } catch {}
      const info = await ctx.env.httpJson(`${base}/json/version`)
      if (!info) {
        const open = await ctx.env.tcpOpen(host, port)
        const status = ctx.env.httpStatus ? await ctx.env.httpStatus(`${base}/json/version`) : 0
        if (open && (status === 404 || status === 0)) {
          return result('unreachable', `调试地址 ${base} 端口开着，但 /json/version 不可用（HTTP ${status || '无响应'}）：这是 chrome://inspect/#remote-debugging 开关的典型表现，请把连接方式改成「连接正在运行的 Chrome（autoConnect）」；browserUrl 需要用 --remote-debugging-port 且带非默认 --user-data-dir 启动 Chrome`, 'http')
        }
        return result('no-app', `无法连接调试地址 ${base}（浏览器未启动，或未使用 --remote-debugging-port 启动）`, 'http')
      }
      const nr = mcpNotReady(ctx, this); if (nr) return nr
      return listPages(ctx, this, `调试地址 ${base} 可用（${info.Browser || '浏览器'}）`)
    }
    if (mode === 'autoConnect') {
      if (!appRunning(await ctx.procs(), app)) return noAppFor(app)
      const dir = chromeDefaultUserDataDir(ctx.cfg.chromeChannel, ctx.env.env, ctx.env.home())
      const port = readDevToolsPort(dir)
      if (!port) {
        return result('unreachable', `Chrome 正在运行，但默认配置目录中尚无 DevToolsActivePort（${dir}）：在 chrome://inspect/#remote-debugging 打开「允许为此浏览器实例进行远程调试」。打开开关本身不会弹窗；第一次用浏览器工具时 Chrome 才会弹出「允许调试」确认框。本模式不需要 %USERPROFILE%\\.cache`, 'devtools-port')
      }
      if (!(await ctx.env.tcpOpen('127.0.0.1', port))) {
        return result('unreachable', `Chrome 正在运行，DevToolsActivePort 指向端口 ${port}，但无法连接：请在 chrome://inspect/#remote-debugging 确认远程调试已打开，或重启 Chrome 后重新开启`, 'devtools-port')
      }
      const nr = mcpNotReady(ctx, this); if (nr) return nr
      // 第一次 autoConnect 要等 Puppeteer 握手（以及可能的「允许调试」弹窗），比默认 4 秒工具超时更宽裕。
      const r = await listPages(ctx, this, `Chrome 在运行，远程调试端口 ${port} 已打开`, 12000)
      if (r.state !== 'connected' && /Could not connect|remote debugging|Allow|权限|拒绝|没有返回|未返回/i.test(r.detail || '')) {
        return result('unreachable', `远程调试端口 ${port} 已打开，但 MCP 未连接：首次连接时请留意 Chrome 的「允许调试」确认框并点击允许（${r.detail}）`, r.via || 'tool:list_pages')
      }
      return r
    }
    // launch：只认 chrome-devtools-mcp 自己启动的那个 Chrome（它的配置目录被占用）；没开时不调 list_pages，免得替模型把 Chrome 拉起来。
    const dir = chromeProfileDir(ctx.cfg, ctx.env.home())
    if (!ctx.env.profileLocked(dir)) {
      return result('no-app', `Chrome MCP 专用的 Chrome 尚未启动（配置目录 ${dir}）：AI 首次使用此工具时启动，之后显示「已连接」`, 'profile-lock')
    }
    const nr = mcpNotReady(ctx, this); if (nr) return nr
    return listPages(ctx, this, 'Chrome MCP 启动的 Chrome 在运行')
  
}

export default component
