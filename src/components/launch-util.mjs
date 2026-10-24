/**
 * 「只启动用户自己安装的程序」类组件的公共部分：命令行拆分、uvx 解析、目录校验、探测。
 * 用于 fusion / freecad / matlab / espidf / serial / rhino / altium。
 */
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { resolveUvx, stdio } from './shared.mjs'
import { appRunning, mcpNotReady, mcpToolNames, noAppFor, result } from '../connect-lib.mjs'

/** 拆命令行：双引号包住带空格的部分。 */
export function splitCommand(line) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2])
  return out
}

export const unquote = (s) => String(s || '').trim().replace(/^"(.*)"$/, '$1')

/**
 * 按命令行生成 stdio 启动方案。首个词是 uvx 时换成解析到的 uvx 路径。
 * @returns {{ok:true, source, viaUvx, config} | {ok:false, reason}}
 */
export function commandPlan(serverName, line, { cfg = {}, uvx = resolveUvx, args = [], env = {}, extra = {} } = {}) {
  const parts = splitCommand(line)
  if (!parts.length) return { ok: false, reason: '启动命令为空。' }
  let [command, ...rest] = parts
  let source = 'setting'
  let viaUvx = false
  if (/^uvx(\.exe)?$/i.test(command)) {
    const found = uvx(cfg)
    if (!found) return { ok: false, reason: '未找到 uvx：请先安装 uv（例如 winget install astral-sh.uv），或改用其他启动命令。' }
    command = found.path
    source = found.source
    viaUvx = true
  }
  return { ok: true, source, viaUvx, config: stdio(serverName, command, [...rest, ...args], { ...extra, env }) }
}

/** 目录是否存在。 */
export function isDirectory(p, { exists = existsSync, isDir = (x) => statSync(x).isDirectory() } = {}) {
  try { return !!p && exists(p) && isDir(p) } catch { return false }
}

/** 在 PATH 中找可执行文件（按给出的文件名依次找）。 */
export function findOnPath(names, { env = process.env, exists = existsSync } = {}) {
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir, n)
      try { if (exists(p)) return p } catch {}
    }
  }
  return null
}

export function checkUrl(raw, fallback) {
  const url = String(raw || fallback).trim()
  let u
  try { u = new URL(url) } catch { return { reason: `地址无效：${url}` } }
  if (!/^https?:$/.test(u.protocol)) return { reason: `只支持 http(s)：${url}` }
  return { url, u }
}

/**
 * 通用探测：程序（可选）→ MCP 是否注册了工具 → 桥接端口（可选）→ 已连接（带工具数）。
 * @param {{ app?, label, port?: {host, port, hint}, extra?: string }} o
 */
export async function probeCommon(ctx, component, o) {
  if (o.app && !appRunning(await ctx.procs(), o.app)) return noAppFor(o.app)
  const nr = mcpNotReady(ctx, component); if (nr) return nr
  if (o.port) {
    const host = o.port.host === 'localhost' ? '127.0.0.1' : o.port.host
    const ok = await ctx.env.tcpOpen(host, o.port.port)
    if (!ok) return result('unreachable', `无法连接 ${o.port.host}:${o.port.port}：${o.port.hint}`, 'socket')
  }
  const names = mcpToolNames(ctx.tools, component.serverName)
  const count = names ? `，${names.length} 个工具` : ''
  return result('connected', `${o.label} 已挂载（${o.extra ? o.extra + '，' : ''}工具名前缀 mcp__${component.serverName}__${count}）`, 'mcp')
}