/**
 * 工作组件：termalin（Termalin SSH 客户端的 MCP 服务器）
 * @see ../../../docs/component-module.md
 * 上游文档：https://termal.in/mcp 、https://termal.in/docs
 *
 * 两种模式：
 *   - local：本机 Termalin 应用自带的 stdio 服务器 termalin-mcp（路径在应用「Settings → Security →
 *     Agent Access (MCP) → Connect an assistant」中显示）。插件不安装、不内置 Termalin。
 *   - hosted：托管端点 https://termal.in/api/v1/mcp，请求头 Authorization: Bearer tk_live_…（需 Pro / 试用）。
 *     OAuth 端点 https://termal.in/mcp 需要浏览器授权流程，插件内不支持。
 *
 * 安全：这些工具会在服务器上执行命令，一律视为改动类工具，仅所有者可用
 * （见 channels/telegram/owner-gate.mjs 的 OWNER_ONLY_PREFIXES）。
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { http, stdio, OFF, IS_WIN } from '../shared.mjs'
import { mcpNotReady, mcpToolNames, result } from '../../connect-lib.mjs'

export const id = 'termalin'

export const app = { name: 'Termalin', exe: IS_WIN ? 'Termalin.exe' : 'termalin', match: /^termalin(\.exe)?$/i }

export const DEFAULT_URL = 'https://termal.in/api/v1/mcp'
export const OAUTH_URL = 'https://termal.in/mcp'
export const MODES = ['local', 'hosted']

export const meta = {
  id: 'termalin',
  title: 'Termalin',
  group: '工作组件',
  url: 'https://termal.in/mcp',
  serverName: 'termalin',
  summary: 'Termalin SSH 客户端的 MCP：本机模式运行应用自带的 termalin-mcp，托管模式连接 https://termal.in/api/v1/mcp（API 密钥）。会在服务器上执行命令，仅所有者可用。',
}

export function modeOf(cfg) {
  return String(cfg?.termalinMode || '').trim() === 'hosted' ? 'hosted' : 'local'
}

function apiKey(cfg) {
  return String(cfg?.termalinApiKey || '').trim().replace(/^Bearer\s+/i, '')
}

/** 本机 termalin-mcp 的候选位置：仅用于自动探测，设置中的路径优先。 */
export function localCandidates(env = process.env, home = homedir()) {
  const exe = IS_WIN ? 'termalin-mcp.exe' : 'termalin-mcp'
  const out = []
  if (IS_WIN) {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    out.push(join(local, 'Termalin', exe), join(local, 'Programs', 'Termalin', exe), join(home, 'scoop', 'shims', exe))
  } else {
    out.push('/Applications/Termalin.app/Contents/MacOS/termalin-mcp', join(home, '.local', 'bin', exe), '/usr/local/bin/termalin-mcp', '/usr/bin/termalin-mcp')
  }
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    if (dir) out.push(join(dir, exe))
  }
  return out
}

/** 解析本机命令：{ path, source } 或 null。 */
export function resolveLocalCommand(cfg, { env = process.env, home = homedir(), exists = existsSync } = {}) {
  const set = String(cfg?.termalinCommand || '').trim().replace(/^"(.*)"$/, '$1')
  if (set) return { path: set, source: 'setting' }
  for (const p of localCandidates(env, home)) {
    try { if (exists(p)) return { path: p, source: 'system' } } catch {}
  }
  return null
}

/** 校验托管端点；返回 { url } 或 { reason }。 */
export function checkHostedUrl(raw) {
  const url = String(raw || DEFAULT_URL).trim()
  let u
  try { u = new URL(url) } catch { return { reason: `地址无效：${url}` } }
  if (!/^https?:$/.test(u.protocol)) return { reason: `只支持 http(s)：${url}` }
  const path = u.pathname.replace(/\/+$/, '')
  if (u.hostname === 'termal.in' && (path === '/mcp' || path === '')) {
    return { reason: `${OAUTH_URL} 是 OAuth 端点，插件内不支持；请改用 API 密钥端点 ${DEFAULT_URL}。` }
  }
  return { url }
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'termalin',
  label: 'Termalin',
  url: 'https://termal.in/mcp',
  serverName: 'termalin',
  summary: 'Termalin SSH 客户端的 MCP（本机 termalin-mcp 或托管 API 密钥端点）。',
  keys: ['termalinEnabled', 'termalinMode', 'termalinCommand', 'termalinUrl', 'termalinApiKey'],
  installed() { return true },
  launch(cfg) {
    if (!cfg.termalinEnabled) return OFF
    if (modeOf(cfg) === 'hosted') {
      const chk = checkHostedUrl(cfg.termalinUrl)
      if (chk.reason) return { ok: false, reason: chk.reason }
      const key = apiKey(cfg)
      if (!key) return { ok: false, reason: '托管模式需要 API 密钥：在 termal.in/account →「API keys & MCP」创建后填入设置。' }
      return { ok: true, source: 'remote', config: http('termalin', chk.url, { headers: { Authorization: `Bearer ${key}` } }) }
    }
    const cmd = resolveLocalCommand(cfg)
    if (!cmd) {
      return { ok: false, reason: '未找到 termalin-mcp：请先安装 Termalin 应用，并把「Settings → Security → Agent Access (MCP)」中显示的路径填入设置。', missing: ['termalin-mcp'] }
    }
    return { ok: true, source: cmd.source, config: stdio('termalin', cmd.path, []) }
  },
  note(cfg) {
    if (modeOf(cfg) === 'hosted') {
      return apiKey(cfg)
        ? '托管模式：只能访问已注册 Connector 的服务器；每分钟约 60 次、单次约 90 秒。密钥只保存在设置中。'
        : '托管模式未配置 API 密钥（termal.in/account →「API keys & MCP」，需 Pro 或试用）。'
    }
    return '本机模式：需要已安装并运行 Termalin 应用，且在应用中允许相应主机。会在服务器上执行命令，仅所有者可用。'
  },
}

export async function probe(ctx) {
  const cfg = ctx.cfg || {}
  const hosted = modeOf(cfg) === 'hosted'
  if (hosted) {
    const chk = checkHostedUrl(cfg.termalinUrl)
    if (chk.reason) return result('unreachable', chk.reason, 'config')
    if (!apiKey(cfg)) return result('unreachable', '未配置 Termalin API 密钥', 'auth')
  } else if (!resolveLocalCommand(cfg)) {
    return result('unreachable', '未找到 termalin-mcp（请安装 Termalin 应用或在设置中填写路径）', 'config')
  }
  const nr = mcpNotReady(ctx, this); if (nr) return nr
  const names = mcpToolNames(ctx.tools, 'termalin')
  const count = names ? `，${names.length} 个工具` : ''
  return result('connected', `Termalin MCP 已挂载（${hosted ? '托管端点' : '本机 termalin-mcp'}${count}）`, 'mcp')
}

export default component