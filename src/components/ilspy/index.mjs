/**
 * 工作组件（仓库自带、已验证）：ILSpy（.NET 反编译）
 * ---------------------------------------------------------------------------
 * 上游：cervonwong/ILSpy-MCP（MIT）  https://github.com/cervonwong/ILSpy-MCP
 *       基于 ICSharpCode.Decompiler（ILSpy 的引擎）**进程内**调用，不是 shell 出去跑 ilspycmd
 *       预编译自包含单文件二进制：v1.2.1 / ilspy-mcp-win-x64.zip
 *       sha256 71b8ea10212adbe612483d6b6731405faaee07890057eccec09431bd9c3c5527（46,939,913 B）
 *
 * 它做什么：把 .NET 程序集（.dll / .exe）反编译成 C#，并做静态结构分析。27 个工具、8 类：
 *   - 反编译：decompile_type / decompile_method（含 .ctor/.cctor）/ list_namespace_types
 *   - IL 反汇编：disassemble_type / disassemble_method（可选 showBytes / showTokens / resolveDeep）
 *   - 类型分析：list_assembly_types / get_type_members / find_type_hierarchy /
 *               find_implementors / find_extension_methods / find_compiler_generated_types /
 *               search_members_by_name
 *   - 交叉引用：find_usages / find_dependencies / find_instantiations
 *   - 程序集检查：analyze_assembly / get_assembly_metadata / get_assembly_attributes /
 *                 get_type_attributes / get_member_attributes / list_embedded_resources / extract_resource
 *   - 搜索：search_strings（扫 IL 的 ldstr，正则）/ search_constants（扫 ldc.i4/i8 数值）
 *   - 跨程序集：resolve_type / load_assembly_directory
 *   - 批量：export_project（整程序集导成可编译的 .csproj + .cs）
 *
 * 为什么选它：同类里能力最全（对比 dnre-mcp 胜在有 IL 反汇编与命名空间级反编译；对比
 * bivex/ILSpy-Mcp 胜在有 xref 与 IL 层搜索），且自包含二进制**不需要装 .NET**。
 * 对付混淆/加固过的程序集，另可考虑 dnre-mcp（IL 元数据索引按行为导航，不依赖成员名）。
 *
 * 前置条件（本组件不代装）：把 release 包解压到任意目录即可，默认找
 *   %USERPROFILE%\Tools\ilspy-mcp\ILSpy.Mcp.exe
 * 本文件只声明「启动计划」，**不会**联网下载任何东西，也没有 install 步骤。
 *
 * 安全边界：该服务器自称 read-only by design —— 不加载程序集进 CLR、不执行被分析代码、
 *   不修改原文件；唯一会写盘的是 export_project（导出到你指定的空目录）。
 *   注意它读的是你磁盘上的文件，MCP 服务器继承宿主给它的文件访问权。
 *
 * SettingsSchema（已写入 src/index.mjs。传输仍只走 stdio，HTTP 字段没有实现，不进 schema）：
 *   ilspyEnabled:  { type: 'boolean', default: false,
 *                    title: 'ILSpy', description: '启用后把 .NET 程序集反编译能力交给 AI（C# / IL / 交叉引用）' }
 *   ilspyCommand:  { type: 'string', default: '',
 *                    title: 'ILSpy.Mcp.exe 路径',
 *                    description: '留空用默认 %USERPROFILE%\\Tools\\ilspy-mcp\\ILSpy.Mcp.exe；换版本时改这里' }
 *   ilspyTransport:{ type: 'string', default: 'stdio',
 *                    title: '传输方式', description: 'stdio（默认，本地）或 http（把服务器跑在分析 VM 上再连）' }
 *   ilspyHttpUrl:  { type: 'string', default: '',
 *                    title: 'HTTP 端点（可选）',
 *                    description: '仅 transport=http 用，例 http://127.0.0.1:3001/mcp。服务器本身不带鉴权，勿裸奔公网' }
 *   对应 INPUT_FIELDS：['ilspyEnabled','ilspyCommand','ilspyTransport','ilspyHttpUrl']
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { OFF, stdio } from '../shared.mjs'
import { appRunning, mcpNotReady, noAppFor, result } from '../../connect-lib.mjs'

/** 组件 id：必须与文件夹名、component.id 三者一致（小写 kebab，未占用任何 bundled id）。 */
export const id = 'ilspy'

/** 上游仓库 / 组件元信息。serverName 决定工具前缀 mcp__ilspy__，选定后不要改。 */
export const meta = {
  id,
  title: 'ILSpy（.NET 反编译）',
  group: '工作组件',
  url: 'https://github.com/cervonwong/ILSpy-MCP',
  serverName: 'ilspy',
  summary:
    '.NET 程序集反编译与静态分析（cervonwong/ILSpy-MCP，ICSharpCode.Decompiler 进程内）：'
    + '类型/方法/命名空间级 C# 反编译、IL 反汇编、交叉引用、IL 层字符串与常量搜索、'
    + '程序集元数据与嵌入资源、整项目导出。只读设计，不加载进 CLR、不执行被分析代码。',
}

/**
 * 进程探测用。ILSpy MCP 没有桌面端点程序 —— 它是由宿主按需拉起的 stdio 子进程，
 * 所以这里匹配子进程本身（listProcesses() 返回「小写、已去 .exe」的名字）。
 */
export const app = {
  name: 'ILSpy MCP',
  exe: 'ILSpy.Mcp.exe',
  match: /^ilspy\.mcp$/,
}

/** 默认安装位置：release 包解压到 %USERPROFILE%\Tools\ilspy-mcp\ 时的可执行文件。 */
const DEFAULT_EXE = join(
  process.env.USERPROFILE || 'C:\\Users\\Default',
  'Tools',
  'ilspy-mcp',
  'ILSpy.Mcp.exe',
)

/** 取字符串设置项，去空白；空串视为未设置。 */
function text(value) {
  return String(value ?? '').trim()
}

/** 解析要启动的可执行文件：设置项优先，回退默认路径。 */
function resolveExe(cfg) {
  return text(cfg?.ilspyCommand) || DEFAULT_EXE
}

/**
 * 只读探测。不拉起子进程、不做反编译：
 * mcpNotReady → exe 是否存在 → connected。
 * （该服务器没有无参工具可 ping，任何工具都要求 assemblyPath，所以这里不调工具。）
 */
export async function probe(ctx) {
  const notReady = mcpNotReady(ctx, component)
  if (notReady) return notReady

  const exe = resolveExe(ctx.cfg)
  if (!existsSync(exe)) {
    const procs = await ctx.procs()
    if (appRunning(procs, app)) {
      return result('unreachable', `ILSpy MCP 子进程在跑，但设置里的可执行文件不存在：${exe}`, 'exe')
    }
    return noAppFor(app, `；找不到可执行文件 ${exe}（把 release 包解压到 %USERPROFILE%\\Tools\\ilspy-mcp\\，或用设置项指定路径）`)
  }

  return result('connected', `ILSpy MCP 已挂载（stdio）：${exe}`, 'exe')
}

/** 注册给宿主的组件对象。 */
export const component = {
  id,
  label: meta.title,
  url: meta.url,
  serverName: meta.serverName,
  summary: meta.summary,

  /**
   * 变更后需要重挂 MCP 的设置键。
   * ilspyEnabled 与 ilspyCommand 都在 SettingsSchema 里，改动后重挂 MCP。
   */
  keys: ['ilspyEnabled', 'ilspyCommand'],

  /** 纯本机二进制，没有下载安装步骤。 */
  installed() {
    return true
  },

  /**
   * 启动计划。
   * 关闭判定：仅显式 true 才挂载；缺键 / false 都返回 OFF。
   * 该服务器默认 stdio、不接受命令行参数（HTTP 模式由 --transport http 单独起，本组件暂不代管）。
   */
  launch(cfg) {
    if (cfg?.ilspyEnabled !== true) return OFF

    const exe = resolveExe(cfg)
    if (!existsSync(exe)) {
      return {
        ok: false,
        missing: true,
        reason: `找不到 ILSpy MCP：${exe}（解压 release 包到默认位置，或用设置项 ilspyCommand 指定绝对路径）`,
      }
    }

    return { ok: true, source: 'exe', config: stdio(meta.serverName, exe, []) }
  },

  /** 设置页展示的说明文案。 */
  note() {
    return [
      '纯本机二进制，无下载安装步骤：把 release 的 ilspy-mcp-win-x64.zip 解压到',
      '%USERPROFILE%\\Tools\\ilspy-mcp\\ 即可（默认路径），或用设置项填绝对路径。',
      '',
      '挂载后提供 27 个工具（前缀 mcp__ilspy__），常用几个：',
      '  · analyze_assembly        —— 先看架构：命名空间、公开类型、设计模式',
      '  · list_assembly_types     —— 按命名空间列全部类型',
      '  · decompile_type          —— 整个类型反编译成 C#',
      '  · decompile_method        —— 只反编译某个方法（含 .ctor / .cctor）',
      '  · disassemble_method      —— 原始 CIL，可选 showBytes / showTokens',
      '  · find_usages / find_implementors / find_instantiations —— 交叉引用',
      '  · search_strings          —— 在 IL 的 ldstr 里按正则搜字符串',
      '  · export_project          —— 整个程序集导成可编译的 .csproj + .cs',
      '',
      '用法：直接在对话里给 .dll 的绝对路径，例如',
      '  「反编译 C:\\path\\MyApp.dll 里的 MyNamespace.UserService」',
      '',
      '只读设计：不加载进 CLR、不执行被分析代码、不改原文件；唯一写盘的是 export_project。',
      '若目标被混淆/加固、成员名已无意义，改用 dnre-mcp（按 IL 行为导航）；',
      '若需要把反编译结果钉进可验证的证据链，可配合 REA 的 import_managed_reconstruction。',
    ].join('\n')
  },
}

export default component
