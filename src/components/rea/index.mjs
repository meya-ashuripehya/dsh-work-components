/**
 * 工作组件：rea（REA 逆向分析）
 *
 * 上游：morluto/rea（MIT）  https://github.com/morluto/rea
 *       npm 包名：rea-agents（固定 6.4.0）   bin：rea-agents → scripts/rea.mjs   MCP 子命令：mcp
 *       官方手动注册形式：npx -y rea-agents@6.4.0 mcp（docs/installation.md#mcp-registry）
 *
 * 能力：JavaScript / Electron / ASAR 静态分析、.NET、网站、Android APK（需 JADX+JDK），
 *       原生二进制需外部分析引擎（Hopper / Ghidra / IDA）；Windows 上 Ghidra 为实验性（P0，只读）。
 *
 * 不运行 `rea setup`（它会改写其他智能体的配置）；本组件仅按官方 stdio 形式挂载 MCP。
 * 前置条件：Node.js ^22.19 / ^24.11 / >=26。
 *
 * SettingsSchema：
 *   reaEnabled / reaPackage / reaGhidraInstallDir / reaJavaHome / reaProvider
 *
 * @see ../../../docs/component-module.md
 */
import { installNpmTool, managedNpmEntry, npmLaunch, OFF } from '../shared.mjs'
import { mcpNotReady, result } from '../../connect-lib.mjs'

export const id = 'rea'

export const meta = {
  id,
  title: 'REA 逆向分析',
  group: '工作组件',
  url: 'https://github.com/morluto/rea',
  serverName: 'rea',
  summary:
    '逆向工程 MCP（rea-agents）：JavaScript / Electron / ASAR、.NET、网站与 Android 的静态分析；'
    + '原生二进制需另行安装 Ghidra、Hopper 或 IDA。',
}

function text(value) {
  return String(value ?? '').trim()
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id,
  label: meta.title,
  url: meta.url,
  serverName: meta.serverName,
  summary: meta.summary,
  keys: ['reaEnabled', 'reaPackage', 'reaGhidraInstallDir', 'reaJavaHome', 'reaProvider', 'nodePath', 'npmRegistry'],
  runtime: 'node',
  spec: (cfg) => text(cfg.reaPackage) || 'rea-agents@6.4.0',
  bin: 'rea-agents',
  installed: (cfg) => !!managedNpmEntry(id, component.spec(cfg)),
  async install(cfg, task, hooks) {
    return installNpmTool(component, cfg, task, hooks)
  },
  launch(cfg) {
    if (cfg.reaEnabled !== true) return OFF
    const env = {}
    const ghidra = text(cfg.reaGhidraInstallDir)
    if (ghidra) env.GHIDRA_INSTALL_DIR = ghidra
    const java = text(cfg.reaJavaHome)
    if (java) env.JAVA_HOME = java
    const provider = text(cfg.reaProvider)
    if (provider) env.REA_ANALYSIS_PROVIDER = provider
    return npmLaunch(component, cfg, ['mcp'], env)
  },
  note() {
    return [
      'REA（Reverse Engineer Anything）以 stdio 方式挂载：rea-agents mcp，工具前缀 mcp__rea__。',
      'JavaScript / Electron / ASAR、网站与 .NET 的静态分析无需额外程序。',
      '原生二进制分析需要本机已安装 Ghidra 12.1.x（含 JDK 21+）、Hopper 或 IDA；',
      'Windows 上的 Ghidra 支持为实验性，仅提供只读操作；Hopper 在 Windows 上不可由 REA 安装。',
      '未安装上述引擎时，原生分析类工具会返回「能力不可用」，其余工具不受影响。',
      '本组件不会运行 rea setup，也不会改动其他智能体的配置。',
    ].join('\n')
  },
}

export async function probe(ctx) {
  const notReady = mcpNotReady(ctx, component)
  if (notReady) return notReady
  return result('connected', 'REA 服务已挂载（静态分析无需外部程序；原生分析需 Ghidra / Hopper / IDA）', 'mcp')
}

export default component