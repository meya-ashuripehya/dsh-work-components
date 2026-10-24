/**
 * 工作组件：deepslate（Minecraft 结构渲染 MCP）
 * 上游：https://github.com/Philogag/deepslate-mcp（MIT），渲染引擎 misode/deepslate（MIT）。
 * @see ../../../docs/component-module.md
 *
 * 只启动用户本机已有的 deepslate-mcp（node <目录>/bin/deepslate-mcp.js），不从网络下载、不把上游源码放进本仓库。
 * 「安装」= 把本机已有的检出目录（已 npm install && npm run build）复制到 <tools>/deepslate（原目录保留）；
 * 设置里未填目录时自动使用该托管副本。
 * 材质来自用户自己的 Minecraft client.jar（DEEPSLATE_JAR_PATH）或上游首次运行时从 Mojang 下载并缓存在本机；
 * 本插件从不打包、分发 Mojang 资源。
 *
 * 工具（上游英文说明保持原文）：render_structure / render_blocks / inspect_structure / render_item，前缀 mcp__deepslate__。
 * 只读渲染（读结构文件、写本机材质缓存），不控制游戏；聊天室对所有成员开放（owner-gate OPEN_PREFIXES），
 * 与 mc_* / mcp__gamebot-* 场景门禁无关。聊天室调用时渲染尺寸上限见 DEEPSLATE_MAX_RENDER_PX。
 */
import { existsSync } from 'node:fs'
import { cp, rm, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute, basename, resolve } from 'node:path'
import { toolsDir } from '../../tools.mjs'
import { OFF, resolveNode, stdio } from '../shared.mjs'
import { mcpNotReady, mcpToolNames, result } from '../../connect-lib.mjs'

export const id = 'deepslate'

/** 无常驻 GUI，仅作展示名。 */
export const app = { name: 'DeepSlate MCP', exe: 'node.exe', match: /^$/ }

/** 聊天室调用渲染工具时 width / height 的上限（像素）；上游允许 64..4096。 */
export const DEEPSLATE_MAX_RENDER_PX = 1600

export const meta = {
  id: 'deepslate',
  title: 'DeepSlate',
  group: '工作组件',
  url: 'https://github.com/Philogag/deepslate-mcp',
  serverName: 'deepslate',
  summary: '把 Minecraft 结构文件（.nbt / .schem / .litematic）渲染为 PNG 预览（deepslate-mcp，启动本机检出目录）。',
}

const clean = (v) => String(v || '').trim().replace(/^"(.*)"$/, '$1')

/**
 * 校验本机检出目录：返回 { dir, entry, server } 或 { reason }。
 * 要求绝对路径、存在 bin/deepslate-mcp.js 与已编译的 dist/server.js（需先在该目录执行 npm install && npm run build）。
 */
export function checkCheckout(raw, { exists = existsSync } = {}) {
  const dir = clean(raw)
  if (!dir) return { reason: '未设置 deepslate-mcp 目录：请填写本机检出目录（git clone https://github.com/Philogag/deepslate-mcp 后的文件夹），或点击「安装」从本机常见位置复制一份。' }
  if (!isAbsolute(dir)) return { reason: `deepslate-mcp 目录须为绝对路径：${dir}` }
  if (!exists(dir)) return { reason: `deepslate-mcp 目录不存在：${dir}` }
  const entry = join(dir, 'bin', 'deepslate-mcp.js')
  if (!exists(entry)) return { reason: `该目录不是 deepslate-mcp 检出目录（缺少 bin\\deepslate-mcp.js）：${dir}` }
  const server = join(dir, 'dist', 'server.js')
  if (!exists(server)) return { reason: `尚未编译：缺少 dist\\server.js。请在该目录执行 npm install 与 npm run build。` }
  return { dir, entry, server }
}

/** 托管副本目录：<tools>/deepslate。 */
export function managedDir(root = toolsDir()) { return join(root, 'deepslate') }

/** 实际使用的目录：设置优先；未填写时用托管副本（存在时）。 */
export function effectivePath(cfg, { exists = existsSync, root } = {}) {
  const set = clean(cfg?.deepslatePath)
  if (set) return set
  const m = managedDir(root)
  return exists(join(m, 'bin', 'deepslate-mcp.js')) ? m : ''
}

/** 安装时查找本机已有检出目录的候选位置（设置中的目录优先；其余按当前用户主目录推断，不写死具体用户）。 */
export function sourceCandidates(cfg, home = homedir()) {
  const out = []
  const set = clean(cfg?.deepslatePath)
  if (set) out.push(set)
  for (const base of [join(home, 'Desktop'), home, join(home, 'Documents'), join(home, 'source', 'repos'), join(home, 'src')]) out.push(join(base, 'deepslate-mcp'))
  return out
}

/** 复制时跳过的条目：版本库、本机测试脚本、误建的「~」目录。 */
const SKIP_TOP = new Set(['.git', '~', 'headless-test.mjs', 'mcp-render-test.mjs', 'render-test.mjs'])
export function copyFilter(srcRoot) {
  const root = resolve(srcRoot)
  return (p) => {
    const rel = resolve(p).slice(root.length).replace(/^[\\/]+/, '')
    if (!rel) return true
    const top = rel.split(/[\\/]/)[0]
    return !SKIP_TOP.has(top)
  }
}

/**
 * 安装：把本机已有的、已编译的检出目录复制到托管目录。找不到时给出明确说明。
 * @returns {Promise<{ dir: string, from: string }>}
 */
export async function installFromLocal(cfg, task = {}, hooks = {}, { root, home, exists = existsSync } = {}) {
  const dest = managedDir(root)
  const log = (t) => { try { task.log?.(t) } catch {} }
  const step = (t) => { try { task.step?.(t) } catch {} }
  step('正在查找本机的 deepslate-mcp')
  let from = null
  for (const cand of sourceCandidates(cfg, home)) {
    if (resolve(cand) === resolve(dest)) continue
    const chk = checkCheckout(cand, { exists })
    if (!chk.reason) { from = chk.dir; break }
    if (clean(cfg?.deepslatePath) && cand === clean(cfg.deepslatePath)) log('设置中的目录不可用：' + chk.reason)
  }
  if (!from) {
    throw new Error('未找到本机已编译的 deepslate-mcp。请先执行 git clone https://github.com/Philogag/deepslate-mcp，在该目录内执行 npm install 与 npm run build，再在设置「deepslate-mcp 目录」中填写其绝对路径后重新点击「安装」（也可直接填写该目录并启用，无需安装）。')
  }
  log('来源：' + from + '（原目录保留，不会删除）')
  const tmp = dest + '.installing'
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  step('正在复制 deepslate-mcp（含 dist 与 node_modules）')
  await cp(from, tmp, { recursive: true, filter: copyFilter(from), errorOnExist: false, force: true })
  if (!exists(join(tmp, 'dist', 'server.js'))) throw new Error('复制后缺少 dist\\server.js，安装未完成。')
  if (typeof hooks.beforeReplace === 'function') await hooks.beforeReplace()
  await rm(dest, { recursive: true, force: true })
  await rename(tmp, dest)
  log('已安装到 ' + dest + (clean(cfg?.deepslatePath) ? '；设置中已填写目录，仍优先使用设置中的目录（清空该项即改用此副本）。' : '；设置中未填写目录时自动使用此副本。'))
  return { dir: dest, from }
}

/** 启动环境变量：只传用户填写的项。 */
export function deepslateEnv(cfg) {
  const env = {}
  const jar = clean(cfg?.deepslateJarPath)
  const cache = clean(cfg?.deepslateCacheDir)
  if (jar) env.DEEPSLATE_JAR_PATH = jar
  if (cache) env.DEEPSLATE_CACHE_DIR = cache
  return env
}

/** @type {import('../shared.mjs').ComponentModule} */
export const component = {
  id: 'deepslate',
  label: 'DeepSlate',
  url: 'https://github.com/Philogag/deepslate-mcp',
  serverName: 'deepslate',
  runtime: 'node',
  summary: meta.summary,
  keys: ['deepslateEnabled', 'deepslatePath', 'deepslateJarPath', 'deepslateCacheDir', 'nodePath'],
  installed(cfg) { return !checkCheckout(effectivePath(cfg)).reason },
  install(cfg, task, hooks) { return installFromLocal(cfg, task, hooks) },
  launch(cfg, deps = {}) {
    if (!cfg.deepslateEnabled) return OFF
    const chk = checkCheckout(effectivePath(cfg, deps), deps)
    if (chk.reason) return { ok: false, missing: true, reason: chk.reason }
    const node = (deps.resolveNode || resolveNode)(cfg)
    if (!node) return { ok: false, missing: true, reason: '未找到 Node.js 20 以上版本：请在「通用 → Node.js」中安装，或在设置中填写 node 路径。' }
    return {
      ok: true, source: 'local', runtime: `Node ${node.version}`,
      config: stdio('deepslate', node.path, [chk.entry], { env: { ...node.env, ...deepslateEnv(cfg) } }),
    }
  },
  note(cfg) {
    const chk = checkCheckout(effectivePath(cfg))
    if (chk.reason) return chk.reason
    return `本机检出：${chk.dir}。材质来自 ${clean(cfg?.deepslateJarPath) ? '设置中的 client.jar' : '首次运行时从 Mojang 下载的 client.jar（缓存在本机）'}；插件不打包 Mojang 资源。`
  },
}

export async function probe(ctx) {
  const chk = checkCheckout(effectivePath(ctx.cfg))
  if (chk.reason) return result('no-app', chk.reason, 'config')
  const nr = mcpNotReady(ctx, this)
  if (nr) return nr
  const names = mcpToolNames(ctx.tools, 'deepslate') || []
  return result('connected', `DeepSlate MCP 已就绪（${names.length} 个工具${names.length ? '：' + names.map((n) => n.replace(/^mcp__deepslate__/, '')).join('、') : ''}）`, 'deepslate')
}

export default component