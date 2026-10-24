/**
 * 工作组件：espidf（ESP-IDF v6.0+ 内置的 Tools 本地 MCP 服务器，stdio）
 * 文档：https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/
 * 推荐 eim run "idf.py mcp-server"（EIM 激活 ESP-IDF 环境）；项目目录经 IDF_MCP_WORKSPACE_FOLDER 传入。
 */
import { OFF } from '../shared.mjs'
import { commandPlan, isDirectory, probeCommon, unquote } from '../launch-util.mjs'

export const id = 'espidf'
export const app = { name: 'ESP-IDF', exe: 'eim', match: /$^/ }
export const DEFAULT_COMMAND = 'eim run "idf.py mcp-server"'

export const meta = {
  id: 'espidf', title: 'ESP-IDF', group: '工作组件', url: 'https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/', serverName: 'espidf',
  summary: 'ESP-IDF Tools 本地 MCP（idf.py mcp-server，ESP-IDF v6.0+ / EIM）：设置目标、编译、烧录、清理。仅所有者可用。',
}

export function planFor(cfg, deps = {}) {
  if (!cfg.espidfEnabled) return OFF
  const dir = unquote(cfg.espidfProjectDir)
  if (!dir) return { ok: false, reason: '请填写 ESP-IDF 项目目录（含 ESP-IDF 项目 CMakeLists.txt 的文件夹）。' }
  if (!isDirectory(dir, deps)) return { ok: false, reason: `项目目录不存在：${dir}` }
  return commandPlan('espidf', String(cfg.espidfCommand || '').trim() || DEFAULT_COMMAND, { ...deps, cfg, env: { IDF_MCP_WORKSPACE_FOLDER: dir } })
}

export const component = {
  id: 'espidf', label: 'ESP-IDF', url: meta.url, serverName: 'espidf',
  summary: 'ESP-IDF Tools 本地 MCP（stdio）。',
  keys: ['espidfEnabled', 'espidfCommand', 'espidfProjectDir'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note() { return '需要 EIM v0.8.1+ 安装的 ESP-IDF v6.0+，安装时启用 mcp 功能；eim 需在 PATH 中。flash_project 会向连接的开发板烧录固件。' },
}

export async function probe(ctx) { return probeCommon(ctx, this, { label: 'ESP-IDF MCP' }) }

export default component