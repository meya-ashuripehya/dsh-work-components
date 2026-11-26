/**
 * 工作组件（仓库自带、已验证）：Ghidra（逆向工程）
 * ---------------------------------------------------------------------------
 * 上游：pyghidra-mcp（clearbluejar，Apache-2.0）  https://github.com/clearbluejar/pyghidra-mcp
 *       PyPI 包名：pyghidra-mcp     console script：pyghidra-mcp
 *       实现：官方 PyGhidra（pyghidra + jpype）进程内调用 Ghidra 的
 *             ProgramAPI / FlatProgramAPI，再以 MCP 暴露出来。
 *
 * 为什么选它（详见会话记录的选型对比）：
 *   同类里唯一「headless-first」且能由插件**自动安装**的 —— 它是个 PyPI 包，
 *   可以落到 tools/ghidra/ 的 venv 里；对比：
 *     · LaurieWired/GhidraMCP —— 最出名，但要 Ghidra GUI 常开 + 装 Java 插件 + Python bridge
 *       三层转发，工具面窄，无法自动部署；
 *     · stl3/ghidra-mcp      —— 号称 200+ 工具最全，但要往 Ghidra Extensions 塞插件，
 *       等于改第三方安装目录，与「产物只落 tools/<id>/」冲突，实际装不起来。
 *   核心逆向原语（反编译 / xref / callgraph / 语义搜索 / 编辑）本方案全覆盖。
 *
 * 它做什么：把二进制（ELF / PE / Mach-O / 固件等）的逆向分析交给 AI。工具面（前缀 mcp__ghidra__）：
 *   - 反编译   decompile_function（支持批量；可附带 callees / strings / xrefs）
 *   - 交叉引用 list_xrefs（支持批量）
 *   - 调用图   gen_callgraph（Mermaid，可查 calling / called 两个方向）
 *   - 符号     search_symbols_by_name（正则）、list_exports、list_imports
 *   - 数据     read_bytes、search_strings
 *   - 语义检索 search_code（对反编译伪代码做向量检索，ChromaDB）
 *   - 项目     import_binary、list_project_binaries、list_project_binary_metadata、delete_project_binary
 *   - 编辑     rename_function、rename_variable、set_variable_type、
 *             set_function_prototype、set_comment
 *
 * 前置条件（本组件**不代装** Ghidra 本体与 JDK）：
 *   1) 装 Ghidra（NSA 官方发布，Apache-2.0），需要 JDK 21+
 *   2) 设置环境变量 GHIDRA_INSTALL_DIR 指向 Ghidra 根目录，或用设置项 ghidraInstallDir 指定
 *      （两者都没有时，本组件会在 launch 里明确报错并提示）
 *   3) 本机 uv（设置页「下载安装」会自动装 pyghidra-mcp 进 tools/ghidra/ 的 venv）
 *
 * 安全边界：分析在本地进程内完成，不上传样本；编辑类工具会改写 Ghidra 项目数据库
 *   （不是原始二进制，原文件只读）。项目目录由 ghidraProjectPath 指定。
 *
 * SettingsSchema（已写入 src/index.mjs，空字符串表示用上游默认）：
 *   ghidraEnabled:        z.boolean().default(false)                     // 启用键，缺省关闭
 *   ghidraPackage:        z.string().default('pyghidra-mcp')             // PyPI 包名
 *   ghidraInstallDir:     z.string().default('')                         // → GHIDRA_INSTALL_DIR
 *   ghidraProjectPath:    z.string().default('')                         // → --project-path（目录或 .gpr）
 *   ghidraProjectName:    z.string().default('')                         // → --project-name，空=my_project
 *   ghidraInputPaths:     z.string().default('')                         // → 位置参数，多个用 ; 分隔
 *   ghidraWaitForAnalysis:z.string().default('')                         // '1' → --wait-for-analysis
 *   uvPath:               z.string().default('')                         // uv 可执行文件路径
 *
 * 拟议的 INPUT_FIELDS（中文 label / desc，供后续 PR）：
 *   { key:'ghidraInstallDir', label:'Ghidra 安装目录',
 *     desc:'指向 Ghidra 根目录（内含 support/analyzeHeadless.bat）。留空则读环境变量 GHIDRA_INSTALL_DIR。',
 *     placeholder:'C:\\Tools\\ghidra_11.3_PUBLIC' }
 *   { key:'ghidraProjectPath', label:'Ghidra 项目目录',
 *     desc:'放 .gpr/.rep 的目录，或直接填某个 .gpr 文件。留空用上游默认 pyghidra_mcp_projects。',
 *     placeholder:'C:\\re\\projects' }
 *   { key:'ghidraInputPaths', label:'启动时导入的二进制',
 *     desc:'可选。启动即导入并分析这些文件/目录，多个用分号 ; 分隔。留空则用 import_binary 工具按需导入。',
 *     placeholder:'C:\\samples\\target.exe' }
 *   { key:'ghidraWaitForAnalysis', label:'等待分析完成后再服务',
 *     desc:'填 1 则启动时阻塞到分析结束（大文件很慢，可能触发宿主超时）；留空则后台分析、边分析边服务。',
 *     placeholder:'0' }
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { managedEntry, OFF, stdio } from '../shared.mjs'
import { installVenvTool, toolsDir } from '../../tools.mjs'
import { appRunning, mcpNotReady, noAppFor, result } from '../../connect-lib.mjs'

/** 组件 id：必须与文件夹名、component.id 三者一致（小写 kebab，未占用任何 bundled id）。 */
export const id = 'ghidra'

/** 上游仓库 / 组件元信息。serverName 决定工具前缀 mcp__ghidra__，选定后不要改。 */
export const meta = {
  id,
  title: 'Ghidra（逆向工程）',
  group: '工作组件',
  url: 'https://github.com/clearbluejar/pyghidra-mcp',
  serverName: 'ghidra',
  summary:
    '把 NSA 的 Ghidra 逆向工程套件接给 AI（clearbluejar/pyghidra-mcp，官方 PyGhidra 进程内调用）：'
    + '函数反编译（批量、可带被调/字符串/xref）、交叉引用、Mermaid 调用图、导出/导入符号、'
    + '原始字节、字符串与符号正则搜索、反编译伪代码的语义向量检索、项目二进制导入与元数据、'
    + '以及重命名函数/变量、设类型、设原型、加注释等编辑操作。无头运行，不需要 Ghidra GUI 常开；'
    + '需本机已装 Ghidra 与 JDK 21，并用 ghidraInstallDir 指向其根目录。',
}

/**
 * 进程探测用。pyghidra-mcp 是由宿主按需拉起的 stdio 子进程，
 * 也可能用户自己开着 Ghidra GUI（--gui 模式）。
 * listProcesses() 返回「小写、已去掉 .exe」的名字。
 */
export const app = {
  name: 'Ghidra / PyGhidra-MCP',
  exe: 'pyghidra-mcp.exe',
  match: /^(pyghidra-mcp|pyghidra|ghidrarun|ghidra)$/,
}

/** 包内 console script 名（install 时据此解析 venv 里的入口）。 */
const BIN = 'pyghidra-mcp'

/** 取字符串设置项，去空白；空串视为未设置。 */
function text(value) {
  return String(value ?? '').trim()
}

/** 运行时目录 tools/ghidra/ 下的 venv。 */
function toolDir() {
  return join(toolsDir(), id)
}

/** 包名（spec），设置项 ghidraPackage 可覆盖。 */
function specOf(cfg) {
  return text(cfg?.ghidraPackage) || 'pyghidra-mcp'
}

/**
 * 已安装时返回 venv 里的入口可执行文件绝对路径，否则 null。
 * 交给 SDK 的 managedEntry 解析（它顺带校验 .dsh-install.json 里记录的包名与 spec 一致），
 * 避免自己拼 .venv/Scripts 路径。
 */
function entryExe(cfg) {
  return managedEntry(id, specOf(cfg), BIN)
}

/**
 * 解析 Ghidra 安装目录：设置项优先，其次环境变量 GHIDRA_INSTALL_DIR。
 * 返回去尾部分隔符的绝对路径，未设置返回空串。
 */
function resolveGhidraDir(cfg) {
  const fromCfg = text(cfg?.ghidraInstallDir)
  const fromEnv = text(process.env.GHIDRA_INSTALL_DIR)
  return (fromCfg || fromEnv).replace(/[\\/]+$/, '')
}

/** Ghidra 的无头分析器入口，用来确认「这是个真的 Ghidra 目录」。 */
function headlessPath(ghidraDir) {
  return join(ghidraDir, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless')
}

/** 把 ghidraInputPaths 拆成路径数组（分号 / 逗号 / 空白都能分）。 */
function inputPaths(cfg) {
  return text(cfg?.ghidraInputPaths).split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 只读探测。不拉起任何进程、不触发分析：
 * mcpNotReady →（已安装 + Ghidra 目录可解析）→ connected。
 * 该服务器没有无参 ping 工具（每个工具都要 binary_name），所以这里不调工具。
 */
export async function probe(ctx) {
  const notReady = mcpNotReady(ctx, component)
  if (notReady) return notReady

  const exe = entryExe(ctx.cfg)
  const installedNow = !!exe
  const ghidraDir = resolveGhidraDir(ctx.cfg)
  const ghidraOk = !!ghidraDir && existsSync(headlessPath(ghidraDir))

  const procs = await ctx.procs()
  const running = appRunning(procs, app)

  if (installedNow && ghidraOk) {
    return result('connected', `PyGhidra-MCP 已安装，Ghidra 就绪：${ghidraDir}`, 'venv')
  }

  if (!installedNow) {
    if (running) {
      return result('unreachable', `PyGhidra-MCP 进程在跑，但运行时目录里没有安装：${toolDir()}`, 'venv')
    }
    return noAppFor(app, `；尚未安装 pyghidra-mcp（在设置页点「下载安装」）`)
  }

  // 已安装，但 Ghidra 本体找不到 —— 这是最常见的卡点，单独指出来。
  const hint = ghidraDir
    ? `Ghidra 目录里没有 support/analyzeHeadless：${ghidraDir}`
    : '未设置 GHIDRA_INSTALL_DIR 环境变量，也没填设置项 ghidraInstallDir'
  return result('unreachable', `PyGhidra-MCP 已安装，但找不到可用的 Ghidra：${hint}`, 'venv')
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
   * 这些键都在 SettingsSchema 里，改动后重挂 MCP。空字符串表示用上游默认。
   */
  keys: [
    'ghidraEnabled',
    'ghidraPackage',
    'ghidraInstallDir',
    'ghidraProjectPath',
    'ghidraProjectName',
    'ghidraInputPaths',
    'ghidraWaitForAnalysis',
    'uvPath',
  ],

  /** Python 包组件（缺省按 Python/uv，不写 runtime:'node'）。 */

  /** PyPI 包名，设置项 ghidraPackage 可覆盖。 */
  spec: specOf,

  /** 包内 console script（venv 里的入口名）。 */
  bin: BIN,

  /** 是否已落到运行时目录 tools/ghidra/（venv 里的入口存在、且 marker 记录的包名与 spec 一致）。 */
  installed(cfg) {
    return !!entryExe(cfg)
  },

  /**
   * 设置页「下载安装」入口。只声明，不在本任务里执行：
   * 由宿主在用户点按钮时调用，产物落在 tools/ghidra/（toolsDir()）。
   * 注意 SDK 的真实签名是 installVenvTool(task, { id, spec, entry, ... })，
   * 不是 installNpmTool 那种 (component, cfg, task, hooks)。
   */
  async install(cfg, task, hooks) {
    return installVenvTool(task, {
      id,
      spec: specOf(cfg),
      entry: BIN,
      beforeReplace: hooks?.beforeReplace,
    })
  },

  /**
   * 启动计划。
   * 关闭判定：仅显式 true 才挂载；缺键 / false 都返回 OFF。
   *
   * 上游只支持 --gui + streamable-http 组合才能联动词 GUI，本组件走 stdio，
   * 所以不提供 --gui 开关（避免配出一个必失败的组合）。要 GUI 联动请手动起
   * `uvx pyghidra-mcp --gui --transport streamable-http` 再配 http 端点。
   */
  launch(cfg) {
    if (cfg?.ghidraEnabled !== true) return OFF

    const exe = entryExe(cfg)
    if (!exe) {
      return {
        ok: false,
        missing: true,
        reason: `pyghidra-mcp 尚未安装：${toolDir()}（在设置页点「下载安装」）`,
      }
    }

    const ghidraDir = resolveGhidraDir(cfg)
    if (!ghidraDir) {
      return {
        ok: false,
        missing: true,
        reason: '未指定 Ghidra 安装目录：设置环境变量 GHIDRA_INSTALL_DIR，或用设置项 ghidraInstallDir 指向 Ghidra 根目录',
      }
    }
    if (!existsSync(headlessPath(ghidraDir))) {
      return {
        ok: false,
        reason: `Ghidra 目录无效（缺 support 下的 analyzeHeadless）：${ghidraDir}`,
      }
    }

    const args = ['--transport', 'stdio']

    const project = text(cfg?.ghidraProjectPath)
    if (project) args.push('--project-path', project)

    const projectName = text(cfg?.ghidraProjectName)
    if (projectName) args.push('--project-name', projectName)

    if (text(cfg?.ghidraWaitForAnalysis) === '1') args.push('--wait-for-analysis')

    const inputs = inputPaths(cfg)
    if (inputs.length) args.push(...inputs)

    // Ghidra 的 JVM 由 GHIDRA_INSTALL_DIR 定位，必须传给子进程。
    const env = { GHIDRA_INSTALL_DIR: ghidraDir }

    return { ok: true, source: 'venv', config: stdio(meta.serverName, exe, args, { env }) }
  },

  /** 设置页展示的说明文案。 */
  note() {
    return [
      '这是「让 AI 直接读二进制」的组件：反编译、交叉引用、调用图、符号/字符串检索、',
      '伪代码语义搜索，以及重命名函数/变量、设类型、加注释。无头运行，不需要 Ghidra GUI 常开。',
      '',
      '前置（本组件不代装这两样）：',
      '  1) 装 Ghidra（NSA 官方发布，Apache-2.0），需要 JDK 21+',
      '  2) 让它找得到 Ghidra：设环境变量 GHIDRA_INSTALL_DIR，或用设置项填 Ghidra 根目录',
      '     （根目录里应当有 support\\analyzeHeadless.bat）',
      '  3) 本机有 uv；然后在本页点「下载安装」把 pyghidra-mcp 装进 tools/ghidra/',
      '',
      '挂载后提供这些工具（前缀 mcp__ghidra__），常用：',
      '  · import_binary                  —— 先把目标二进制导进 Ghidra 项目（目录会递归导入）',
      '  · list_project_binaries          —— 看项目里有什么，拿 binary_name',
      '  · decompile_function             —— 反编译；支持批量，可 include_callees/strings/xrefs',
      '  · list_xrefs                     —— 交叉引用，支持批量',
      '  · gen_callgraph                  —— 出 Mermaid 调用图（calling / called 双向）',
      '  · search_symbols_by_name / list_exports / list_imports —— 符号与导入导出表（正则）',
      '  · search_strings / read_bytes    —— 字符串与原始字节',
      '  · search_code                    —— 对反编译伪代码做语义检索，找「像做什么的」函数',
      '  · rename_function / rename_variable / set_variable_type / set_function_prototype / set_comment',
      '                                   —— 边分析边把结论写回项目',
      '',
      '用法：先导入，再按 binary_name 操作，例如',
      '  「把 C:\\samples\\target.exe 导进项目，然后反编译 main，带上它的被调函数和交叉引用」',
      '  「在 firmware.bin 里搜函数名含 aes 的，出一下它的调用图」',
      '',
      '几个注意：',
      '  · 分析大文件很慢。默认不阻塞启动（后台分析、边分析边服务），所以刚导入完',
      '    立刻查符号/语义搜索可能还没就绪；要严谨可把「等待分析完成」设成 1。',
      '  · 编辑类工具改的是 Ghidra 项目数据库，不改原始二进制。',
      '  · 要 GUI 联动（在 CodeBrowser 里跳转/高亮）需手动起',
      '    `uvx pyghidra-mcp --gui --transport streamable-http`，本组件不代管该组合。',
    ].join('\n')
  },
}

export default component
