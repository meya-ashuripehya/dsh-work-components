/**
 * 工作组件：notion（官方 Notion MCP，经 mcp-remote OAuth 桥）
 * @see ../../../docs/component-module.md
 * 上游：https://developers.notion.com/docs/mcp · 桥接 https://github.com/geelen/mcp-remote
 */
import { installNpmTool, mcpRemoteLaunch, OFF } from '../shared.mjs'
import { managedNpmEntry } from '../shared.mjs'
import { mcpNotReady, result } from '../../connect-lib.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const id = 'notion'

export const app = { name: 'Notion（云端 MCP）', exe: '—', match: /$^/ }

export const meta = {
  id: 'notion',
  title: 'Notion',
  group: '工作组件',
  url: 'https://developers.notion.com/docs/mcp',
  serverName: 'notion',
  summary: '官方 Notion MCP（OAuth）。DSH 的 HTTP 传输没有浏览器授权，经 mcp-remote stdio 桥；首次连接会弹出 Notion 授权页，token 缓存在 %USERPROFILE%\.mcp-auth。',
}

const DEFAULT_URL = 'https://mcp.notion.com/mcp'
const REMOTE_ARGS = ['--host', '127.0.0.1', '--auth-timeout', '180']

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'notion',
  label: 'Notion',
  url: 'https://developers.notion.com/docs/mcp',
  serverName: 'notion',
  runtime: 'node',
  summary: '官方 Notion MCP（OAuth，经 mcp-remote 桥）。',
  keys: ['notionEnabled', 'notionUrl', 'notionPackage', 'nodePath'],
  spec: (cfg) => cfg.notionPackage || 'mcp-remote',
  bin: 'mcp-remote',
  installed(cfg) {
    if (managedNpmEntry('notion', this.spec(cfg))) return true
    const home = process.env.USERPROFILE || process.env.HOME || homedir()
    return existsSync(join(home, '.dsh', 'mcp-remote', 'node_modules', 'mcp-remote', 'dist', 'proxy.js'))
  },
  install(cfg, task, hooks) { return installNpmTool(this, cfg, task, hooks) },
  launch(cfg) {
    if (!cfg.notionEnabled) return OFF
    const url = String(cfg.notionUrl || DEFAULT_URL).trim()
    return mcpRemoteLaunch(this, cfg, url, REMOTE_ARGS)
  },
  note() {
    return '首次连接会打开浏览器做 Notion OAuth；授权缓存在 %USERPROFILE%\.mcp-auth。若提示未找到 mcp-remote，请点击「下载安装」。'
  },
}

export async function probe(ctx) {
  const nr = mcpNotReady(ctx, this); if (nr) return nr
  return result('connected', 'Notion MCP 已挂载（OAuth 经 mcp-remote）', 'mcp')
}

export default component
