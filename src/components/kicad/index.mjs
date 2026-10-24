/**
 * 工作组件：kicad（社区服务器 KiCad MCP Pro，stdio）
 * @see ../../../docs/component-module.md
 * 上游：https://github.com/oaslananka/kicad-mcp-pro （配置见 docs/client-configuration.md、docs/configuration.md）
 *
 * 本插件不内置、不分发上游代码：只按设置里的命令（默认 `uvx kicad-mcp-pro`）启动用户自己的副本。
 * 环境变量：KICAD_MCP_PROJECT_DIR、KICAD_MCP_PROFILE、KICAD_MCP_OPERATING_MODE。
 *
 * 安全：kicad 的工具一律仅所有者可用（channels/telegram/owner-gate.mjs 的 OWNER_ONLY_PREFIXES）。
 * readonly 之外的模式还会由服务器开放改文件 / 出生产文件的工具。
 */
import { existsSync, statSync } from 'node:fs'
import { OFF, resolveUvx, stdio } from '../shared.mjs'
import { mcpNotReady, mcpToolNames, result } from '../../connect-lib.mjs'

export const id = 'kicad'

export const app = { name: 'KiCad', exe: 'kicad.exe', match: /^kicad(\.exe)?$/i }

export const DEFAULT_COMMAND = 'uvx kicad-mcp-pro'
export const PROFILES = ['default', 'pcb_only', 'build', 'release', 'expert', 'full']
export const MODES = ['readonly', 'write', 'manufacturing']

export const meta = {
  id: 'kicad',
  title: 'KiCad',
  group: '工作组件',
  url: 'https://github.com/oaslananka/kicad-mcp-pro',
  serverName: 'kicad',
  summary: 'KiCad MCP Pro（社区，stdio）：原理图 / PCB / ERC / DRC / 生产文件审阅。插件只启动用户自己安装的副本（默认 uvx kicad-mcp-pro），不内置上游代码。仅所有者可用。',
}

export const profileOf = (cfg) => (PROFILES.includes(cfg?.kicadProfile) ? cfg.kicadProfile : 'default')
export const modeOf = (cfg) => (MODES.includes(cfg?.kicadMode) ? cfg.kicadMode : 'readonly')

/** 把命令行拆成参数：支持双引号包住带空格的路径。 */
export function splitCommand(line) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2])
  return out
}

/** 启动方案（依赖可注入，便于测试）。 */
export function planFor(cfg, { uvx = resolveUvx, exists = existsSync, isDir = (p) => statSync(p).isDirectory() } = {}) {
  if (!cfg.kicadEnabled) return OFF
  const parts = splitCommand(String(cfg.kicadCommand || '').trim() || DEFAULT_COMMAND)
  if (!parts.length) return { ok: false, reason: '启动命令为空。' }
  const env = { KICAD_MCP_PROFILE: profileOf(cfg), KICAD_MCP_OPERATING_MODE: modeOf(cfg) }
  const dir = String(cfg.kicadProjectDir || '').trim().replace(/^"(.*)"$/, '$1')
  if (dir) {
    let ok = false
    try { ok = exists(dir) && isDir(dir) } catch {}
    if (!ok) return { ok: false, reason: `项目目录不存在：${dir}` }
    env.KICAD_MCP_PROJECT_DIR = dir
  }
  let [command, ...args] = parts
  let source = 'setting'
  let viaUvx = false
  if (/^uvx(\.exe)?$/i.test(command)) {
    const found = uvx(cfg)
    if (!found) return { ok: false, reason: '未找到 uvx：请先安装 uv（例如 winget install astral-sh.uv），或在设置中改用其他启动命令。' }
    command = found.path
    source = found.source
    viaUvx = true
  }
  return { ok: true, source, viaUvx, config: stdio('kicad', command, args, { env }) }
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'kicad',
  label: 'KiCad',
  url: 'https://github.com/oaslananka/kicad-mcp-pro',
  serverName: 'kicad',
  summary: 'KiCad MCP Pro（社区，stdio，经 uvx 启动用户自己的副本）。',
  keys: ['kicadEnabled', 'kicadCommand', 'kicadProjectDir', 'kicadProfile', 'kicadMode'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note(cfg) {
    const mode = modeOf(cfg)
    const risk = mode === 'readonly' ? '只读模式：只开放查看、ERC / DRC 和安全导出。' : `「${mode}」模式会开放修改工程文件或生成生产文件的工具。`
    return `${risk}所有 KiCad 工具都只有所有者发起的任务可以使用。首次通过 uvx 启动时会从 PyPI 下载 kicad-mcp-pro。`
  },
}

export async function probe(ctx) {
  const cfg = ctx.cfg || {}
  const nr = mcpNotReady(ctx, this); if (nr) return nr
  const names = mcpToolNames(ctx.tools, 'kicad')
  const count = names ? `，${names.length} 个工具` : ''
  return result('connected', `KiCad MCP 已挂载（${profileOf(cfg)} / ${modeOf(cfg)}${count}）`, 'mcp')
}

export default component