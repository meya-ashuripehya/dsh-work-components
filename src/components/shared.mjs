/**
 * 工作组件共享宿主能力：解析 uv / Node / npm、stdio/http 配置、托管入口查找、npm 启动与安装封装。
 * 各组件模块（src/components/<id>/）用这些原语实现 launch / install；运行时管理见 ./manager.mjs。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  installNpmPackage, managedPaths, nodeSatisfies, nodeVersion,
  npmCliNear, npxCliNear, packageName, pluginRoot, readMarker, venvBin, which,
} from '../tools.mjs'

export { pluginRoot }

export const IS_WIN = process.platform === 'win32'

export function wingetLink(file) {
  const local = process.env.LOCALAPPDATA
  if (!local) return null
  const p = join(local, 'Microsoft', 'WinGet', 'Links', file)
  return existsSync(p) ? p : null
}

export const SOURCE_TEXT = { managed: '插件托管', setting: '设置中的路径', system: '系统安装', bundled: 'DSH 自带运行时', remote: '远程地址' }

/** uv：插件 tools/uv → 设置里的 uvPath → WinGet 链接 → PATH。返回 { path, source } 或 null。 */
export function resolveUv(cfg) {
  const m = managedPaths()
  if (existsSync(m.uv)) return { path: m.uv, source: 'managed' }
  if (cfg.uvPath) return { path: cfg.uvPath, source: 'setting' }
  const p = wingetLink('uv.exe') || which('uv')
  return p ? { path: p, source: 'system' } : null
}

/** uvx：插件 tools/uv → uvPath 同目录 → WinGet 链接 → PATH。 */
export function resolveUvx(cfg) {
  const m = managedPaths()
  if (existsSync(m.uvx)) return { path: m.uvx, source: 'managed' }
  if (cfg.uvPath) {
    const sibling = join(dirname(cfg.uvPath), IS_WIN ? 'uvx.exe' : 'uvx')
    if (existsSync(sibling)) return { path: sibling, source: 'setting' }
  }
  const p = wingetLink('uvx.exe') || which('uvx')
  return p ? { path: p, source: 'system' } : null
}

/** 兼容旧导出：返回路径字符串，找不到时返回 null。 */
export function findUv(cfg) { return resolveUv(cfg)?.path ?? null }
export function findUvx(cfg) { return resolveUvx(cfg)?.path ?? null }

/** 插件 tools/<id> 里装好的入口命令；安装记录的包名必须和当前设置一致。 */
export function managedEntry(id, spec, entry) {
  const m = managedPaths()
  const exe = venvBin(m.venv(id), entry)
  if (!existsSync(exe)) return null
  const marker = readMarker(m.dir(id))
  if (marker && marker.package && marker.package !== spec) return null
  return exe
}

/** 候选 node：tools/node → 设置 nodePath → PATH。 */
export function nodeCandidates(cfg) {
  const m = managedPaths()
  const list = []
  if (existsSync(m.nodeExe)) list.push([m.nodeExe, 'managed'])
  if (cfg.nodePath) list.push([cfg.nodePath, 'setting'])
  const sys = which('node')
  if (sys) list.push([sys, 'system'])
  return list
}

/**
 * 运行 npm 组件用的 Node：tools/node → 设置 nodePath → PATH 里的 node（都要 20.19+ / 22.12+）→ DSH 自带的
 * Electron（ELECTRON_RUN_AS_NODE=1）。返回 { path, source, version, env } 或 null。
 */
export function resolveNode(cfg) {
  for (const [p, source] of nodeCandidates(cfg)) {
    const version = nodeVersion(p)
    if (version && nodeSatisfies(version)) return { path: p, source, version, env: {} }
  }
  if (process.versions.electron && nodeSatisfies(process.versions.node)) {
    return { path: process.execPath, source: 'bundled', version: 'v' + process.versions.node, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return null
}

/** 安装用的 npm（必须和 node 在一起）：tools/node → nodePath → PATH。返回 { node, cli, npx, source, version, env } 或 null。 */
export function resolveNpm(cfg) {
  for (const [p, source] of nodeCandidates(cfg)) {
    const cli = npmCliNear(p)
    if (!cli) continue
    const version = nodeVersion(p)
    if (version && nodeSatisfies(version)) return { node: p, cli, npx: npxCliNear(p), source, version, env: {} }
  }
  return null
}

/** 插件 tools/<id> 里 npm 安装的入口脚本；安装记录的包名必须和当前设置一致。 */
export function managedNpmEntry(id, spec) {
  const m = managedPaths()
  const marker = readMarker(m.dir(id))
  if (!marker?.entry) return null
  if (marker.package && marker.package !== spec) return null
  const p = join(m.dir(id), marker.entry)
  return existsSync(p) ? p : null
}

export const RECONNECT = { enabled: true, initialDelayMs: 2000, maxDelayMs: 15000, maxAttempts: 40 }

export function stdio(serverName, command, args, extra = {}) {
  return {
    transport: 'stdio',
    serverName,
    command,
    args,
    toolCallTimeoutMs: 180000,
    failOnStartupError: false,
    reconnect: RECONNECT,
    ...extra,
    // 代理慢时 uv 默认 30 秒的下载超时不够，首次拉依赖会反复失败（uvx 回退时有用）。
    env: { UV_HTTP_TIMEOUT: '600', ...(extra.env ?? {}) },
  }
}

export function http(serverName, url, extra = {}) {
  return {
    transport: 'streamable-http',
    serverName,
    url,
    headers: {},
    toolCallTimeoutMs: 180000,
    failOnStartupError: false,
    reconnect: RECONNECT,
    ...extra,
  }
}

export const NOT_INSTALLED = (what) => `缺少 ${what}：请点击「下载安装」`
export const OFF = { ok: false, reason: '已在设置中停用' }

/**
 * npm 组件的启动方案：tools/<id> 里的安装（用 resolveNode 找到的 node 直接跑入口脚本，不联网）→
 * 没装时用带 npm 的 Node 的 npx 临时运行（首次会联网下载）→ 都没有时「未安装」。
 */
export function npmLaunch(c, cfg, args, env = {}, extra = {}) {
  const spec = c.spec(cfg)
  const entry = managedNpmEntry(c.id, spec)
  if (entry) {
    const node = resolveNode(cfg)
    if (!node) return { ok: false, missing: true, reason: '已安装，但未找到 Node.js 20.19+ / 22.12+：请在「通用 → Node.js」中下载安装，或在设置中填写 node 路径' }
    return {
      ok: true, source: 'managed', runtime: `Node ${node.version}，${SOURCE_TEXT[node.source]}`,
      config: stdio(c.serverName, node.path, [entry, ...args], { ...extra, env: { ...node.env, ...env } }),
    }
  }
  const npm = resolveNpm(cfg)
  if (!npm?.npx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
  const npxEnv = {}
  if (cfg.proxy) Object.assign(npxEnv, { npm_config_proxy: cfg.proxy, npm_config_https_proxy: cfg.proxy })
  if (cfg.npmRegistry) npxEnv.npm_config_registry = cfg.npmRegistry
  return {
    ok: true, source: npm.source, via: 'npx',
    config: stdio(c.serverName, npm.node, [npm.npx, '--yes', spec, ...args], { ...extra, env: { ...npxEnv, ...env } }),
  }
}

export function installNpmTool(c, cfg, task, hooks) {
  return installNpmPackage(task, {
    id: c.id, spec: c.spec(cfg), bin: c.bin, npm: hooks.npm, extraArgs: c.installArgs ?? [],
    registry: cfg.npmRegistry, beforeReplace: hooks.beforeReplace,
  })
}

/** chrome-devtools-mcp 的命令行参数（见它的 docs/configuration.md）。 */
export function chromeArgs(cfg) {
  const a = []
  const mode = cfg.chromeConnect || 'launch'
  if (mode === 'browserUrl') {
    a.push(`--browserUrl=${(cfg.chromeBrowserUrl || 'http://127.0.0.1:9222').trim()}`)
  } else {
    if (mode === 'autoConnect') {
      // Chrome 144+：连正在运行的实例（需 chrome://inspect/#remote-debugging）。
      // 显式带上 channel，避免默认值歧义；不传 userDataDir（由 MCP 按 channel 找默认配置目录的 DevToolsActivePort）。
      a.push('--autoConnect')
      a.push(`--channel=${cfg.chromeChannel || 'stable'}`)
    } else if (cfg.chromeChannel && cfg.chromeChannel !== 'stable') {
      a.push(`--channel=${cfg.chromeChannel}`)
    }
    if (mode === 'launch') {
      if (cfg.chromeHeadless) a.push('--headless')
      if (cfg.chromeUserDataDir) a.push(`--userDataDir=${cfg.chromeUserDataDir.trim()}`)
    }
  }
  const set = cfg.chromeToolset || 'standard'
  if (set === 'slim') a.push('--slim')
  else if (set === 'full') {
    // 内存分析、坐标点击、页面自带的第三方工具；扩展 / PWA 只支持由它自己启动的 Chrome（pipe 连接）。
    a.push('--memoryDebugging', '--experimentalVision', '--categoryExperimentalThirdParty')
    if (mode === 'launch') a.push('--categoryExtensions', '--categoryPwa')
  }
  a.push('--no-usage-statistics')
  return a
}

export const FIGMA_OFFICIAL_URL = 'http://127.0.0.1:3845/mcp'

/** godot-ai attach 的参数：共享后端的 HTTP 端口、Godot 编辑器插件连的 WebSocket 端口（和编辑器设置 godot_ai/http_port、ws_port 一致）。 */
export function godotArgs(cfg) {
  const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d }
  return ['attach', '--port', String(port(cfg.godotHttpPort, 8000)), '--ws-port', String(port(cfg.godotWsPort, 9500))]
}

/**
 * @typedef {object} ComponentModule
 * @property {string} id
 * @property {string} label
 * @property {string} [url]
 * @property {string} serverName
 * @property {string} summary
 * @property {'bundled'|'local'} [moduleSource]  // 仓库自带 vs 本地兼容；registry 写入
 * @property {string} [moduleDir]
 * @property {'node'} [runtime]
 * @property {string[]} keys
 * @property {(cfg: object) => string} [spec]
 * @property {string} [bin]
 * @property {string[]} [installArgs]
 * @property {(cfg?: object) => boolean} installed
 * @property {(cfg: object, task: object, hooks: object) => Promise<unknown>} [install]
 * @property {(cfg: object) => object} launch
 * @property {(cfg: object) => (string|null)} [note]
 * @property {(log?: Function) => Promise<unknown>} [beforeRemove]
 * @property {(cfg: object, project: string, opts?: object) => Promise<object>} [installAddon]
 */



/** 系统 uv tool 安装的入口（%APPDATA%/uv/tools/<id>/Scripts/<entry>.exe）。 */
export function systemUvToolExe(toolId, entry) {
  const appData = process.env.APPDATA
  if (!appData || !IS_WIN) return null
  const exe = join(appData, 'uv', 'tools', toolId, 'Scripts', IS_WIN ? `${entry}.exe` : entry)
  return existsSync(exe) ? exe : null
}

/** 本机已有的 mcp-remote proxy.js（~/.dsh/mcp-remote 或 tools/<id> 托管安装）。 */
export function resolveMcpRemoteProxy(cfg, id, spec) {
  const managed = managedNpmEntry(id, spec)
  if (managed) return { path: managed, source: 'managed' }
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  const candidates = [
    join(home, '.dsh', 'mcp-remote', 'node_modules', 'mcp-remote', 'dist', 'proxy.js'),
    join(home, '.dsh', 'mcp-remote', 'node_modules', 'mcp-remote', 'dist', 'proxy.cjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'system' }
  }
  return null
}

/**
 * 经 mcp-remote 桥接 OAuth 远程 MCP：tools/<id> → ~/.dsh/mcp-remote → npx mcp-remote。
 * @param {ComponentModule} c
 * @param {object} cfg
 * @param {string} remoteUrl
 * @param {string[]} [extraArgs]
 * @param {object} [env]
 */
export function mcpRemoteLaunch(c, cfg, remoteUrl, extraArgs = [], env = {}) {
  const url = String(remoteUrl || '').trim()
  if (!url) return { ok: false, reason: '远程 MCP 地址为空' }
  const args = [url, ...extraArgs]
  const proxy = resolveMcpRemoteProxy(cfg, c.id, c.spec(cfg))
  if (proxy) {
    const node = resolveNode(cfg)
    if (!node) return { ok: false, missing: true, reason: `已找到 mcp-remote（${SOURCE_TEXT[proxy.source] || proxy.source}），但未找到 Node.js 20.19+ / 22.12+` }
    return {
      ok: true, source: proxy.source, runtime: `Node ${node.version}，${SOURCE_TEXT[node.source]}`,
      config: stdio(c.serverName, node.path, [proxy.path, ...args], { env: { ...node.env, ...env } }),
    }
  }
  return npmLaunch(c, cfg, args, env)
}
