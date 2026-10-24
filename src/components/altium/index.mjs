/**
 * 工作组件：altium（社区 salitronic/eda-agent，Apache-2.0，stdio，驱动正在运行的 Altium Designer）
 * 工具约 450 个：默认 EDA_AGENT_TOOLSET=minimal，只公开 tool_catalog / tool_invoke 两个（其余按需调用）。
 * 网页仪表盘默认关闭（EDA_AGENT_DISABLE_DASHBOARD=1）；界面自动化（模拟键鼠）可关（EDA_AGENT_UI_AUTOMATION=0）。
 */
import { OFF } from '../shared.mjs'
import { commandPlan, probeCommon } from '../launch-util.mjs'

export const id = 'altium'
export const app = { name: 'Altium Designer', exe: 'X2.exe', match: /^x2$/i }
export const DEFAULT_COMMAND = 'eda-agent'
export const TOOLSETS = ['minimal', 'full']

export const meta = {
  id: 'altium', title: 'Altium Designer', group: '工作组件', url: 'https://github.com/salitronic/eda-agent', serverName: 'altium',
  summary: 'eda-agent（社区，Apache-2.0）：驱动正在运行的 Altium Designer。默认精简工具集（2 个入口工具）。仅所有者可用。',
}

export const toolsetOf = (cfg) => (cfg?.altiumToolset === 'full' ? 'full' : 'minimal')

export function planFor(cfg, deps = {}) {
  if (!cfg.altiumEnabled) return OFF
  const env = { EDA_AGENT_BACKEND: 'altium', EDA_AGENT_TOOLSET: toolsetOf(cfg) }
  if (!cfg.altiumDashboard) env.EDA_AGENT_DISABLE_DASHBOARD = '1'
  if (cfg.altiumUiAutomation === false) env.EDA_AGENT_UI_AUTOMATION = '0'
  return commandPlan('altium', String(cfg.altiumCommand || '').trim() || DEFAULT_COMMAND, { ...deps, cfg, env })
}

export const component = {
  id: 'altium', label: 'Altium Designer', url: meta.url, serverName: 'altium',
  summary: 'eda-agent（stdio，Altium Designer）。',
  keys: ['altiumEnabled', 'altiumCommand', 'altiumToolset', 'altiumDashboard', 'altiumUiAutomation'],
  installed() { return true },
  launch(cfg) { return planFor(cfg) },
  note() { return '实验性项目：部分工具可能使 Altium 脚本引擎崩溃，使用前请备份工程。需在 Altium 中把 Altium_API.PrjScr 注册为全局脚本项目，并运行 StartMCPServer。' },
}

export async function probe(ctx) {
  return probeCommon(ctx, this, { app, label: 'eda-agent', extra: `工具集 ${toolsetOf(ctx.cfg)}` })
}

export default component