/**
 * 工作组件：comfyui（官方 Comfy MCP）
 * @see ../../../docs/component-module.md
 * 上游：https://github.com/Comfy-Org/comfy-mcp （PyPI comfy-mcp）
 */
import { installVenvTool } from '../../tools.mjs'
import { managedEntry, NOT_INSTALLED, OFF, resolveUvx, stdio, systemUvToolExe } from '../shared.mjs'
import { mcpNotReady, result } from '../../connect-lib.mjs'

export const id = 'comfyui'

export const app = { name: 'ComfyUI', exe: 'python / ComfyUI', match: /^(python|pythonw|comfyui)$/ }

export const meta = {
  id: 'comfyui',
  title: 'ComfyUI',
  group: '工作组件',
  url: 'https://github.com/Comfy-Org/comfy-mcp',
  serverName: 'comfyui',
  summary: '官方 Comfy MCP（comfy-mcp）：驱动本机 ComfyUI（经 comfy-cli）。ComfyUI 进程要先开着，或用工具里的 launch_comfyui。',
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'comfyui',
  label: 'ComfyUI',
  url: 'https://github.com/Comfy-Org/comfy-mcp',
  serverName: 'comfyui',
  summary: '官方 Comfy MCP（comfy-mcp），驱动本机 ComfyUI。',
  keys: ['comfyuiEnabled', 'comfyuiPackage', 'comfyuiBin', 'uvPath'],
  spec: (cfg) => cfg.comfyuiPackage || 'comfy-mcp',
  installed(cfg) {
    const spec = this.spec(cfg)
    return !!managedEntry('comfyui', spec, 'comfy-mcp') || !!systemUvToolExe('comfy-mcp', 'comfy-mcp')
  },
  install(cfg, task, hooks) {
    const spec = this.spec(cfg)
    return installVenvTool(task, { id: 'comfyui', spec, entry: 'comfy-mcp', beforeReplace: hooks.beforeReplace })
  },
  launch(cfg) {
    if (!cfg.comfyuiEnabled) return OFF
    const spec = this.spec(cfg)
    const env = {}
    const bin = String(cfg.comfyuiBin || process.env.COMFY_BIN || '').trim()
    if (bin) env.COMFY_BIN = bin
    const exe = managedEntry('comfyui', spec, 'comfy-mcp')
    if (exe) return { ok: true, source: 'managed', config: stdio('comfyui', exe, [], { env }) }
    const sys = systemUvToolExe('comfy-mcp', 'comfy-mcp')
    if (sys) return { ok: true, source: 'system', config: stdio('comfyui', sys, [], { env }) }
    const uvx = resolveUvx(cfg)
    if (!uvx) return { ok: false, missing: true, reason: NOT_INSTALLED(spec) }
    return { ok: true, source: uvx.source, viaUvx: true, config: stdio('comfyui', uvx.path, [spec], { env }) }
  },
  note(cfg) {
    const bin = String(cfg.comfyuiBin || process.env.COMFY_BIN || '').trim()
    if (!bin) return '可选：填写 comfy-cli 的 comfy.exe 路径（COMFY_BIN）。秋叶包等本地 ComfyUI 需先启动或通过工具 launch_comfyui。'
    return null
  },
}

export async function probe(ctx) {
  // ComfyUI 默认可在 8188；未开时仍可能已挂载 MCP（工具可 launch）。
  const open = await ctx.env.tcpOpen('127.0.0.1', 8188)
  const nr = mcpNotReady(ctx, this); if (nr) return nr
  if (open) return result('connected', 'Comfy MCP 已挂载，本机 8188 端口已开放（通常为 ComfyUI）', 'socket')
  return result('connected', 'Comfy MCP 已挂载；本机 8188 端口未开放：可使用工具 launch_comfyui，或手动启动 ComfyUI', 'mcp')
}

export default component
