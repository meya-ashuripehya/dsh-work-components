# 工作组件模块约定

本文约定 `src/components/<id>/` 的目录布局与稳定接口。目标：每个工作组件自洽（启动、安装、已连接探测、设置键），宿主只负责加载与注册；行为与改前一致。

> **非目标**：不把「下载安装」落地的包放进 `src/`；`tools/` 仍是运行时目录（gitignore）。uv / Node.js 是通用前置，不做成工作组件文件夹（仍由宿主安装队列管理）。

相关入口：`src/components/index.mjs`（注册表 + 管理器）、`src/connect.mjs`（探测汇总）、`src/tools.mjs`（下载 / venv / npm 原语）、`lib/client.js`（设置页 UI，手写，需与模块 meta / 字段说明保持同步）。
> **多模态卡片（非组件模块）**：UI 用统一 `MmBlock`（`type:'mm'` / `kind` / `status`），经 `presentationMeta.mm` 交给前端；`output.render` 只发 Host 接受的 `text`+`image`（DeepSeek Messages 拒 `mm`）。工具 `mm_send_image`（本地图片 → Host attachmentId）。运行中 `tool.call.toolview` 只显示 pending/sending；**settled 全卡挂在 `conversation.chat.turnTail`**（ConversationNodeDefinition → turn data `mmCards`，与 deliverables 同属产物表面），过程折叠后仍可见。`loadImage` 经 `uiConversation.imageUrl`。


---

## 目录布局

```
src/components/
  index.mjs           # 对外导出：COMPONENTS、createComponentManager、resolve*
  registry.mjs        # 加载 bundled + local，汇总 COMPONENTS / APPS / PROBES
  shared.mjs          # 共享：stdio/http、resolveUv/Node/npm、npmLaunch…
  manager.mjs         # 挂载、安装队列、list / install / uninstall / addon
  <id>/
    index.mjs         # 仓库自带（bundled）组件模块

local-components/     # 用户本地兼容（local；gitignore；默认可写）
  <id>/
    index.mjs         # 与 bundled 同一 ComponentModule 接口；registry 自动发现
```

可选（复杂组件可再拆，当前实现多合在 `index.mjs`）：

| 文件 | 用途 |
| --- | --- |
| `meta` 段 / `export const meta` | id、title、group、url、serverName、summary（图标仍在 `lib/client.js` 的 `ICONS`，只用通用线条，不用第三方标志） |
| `install` | `component.install` |
| `launch` | `component.launch` + 专用 args（如 `chromeArgs` / `godotArgs` 可放 shared 或本目录） |
| `probe` | `export async function probe` + `export const app` |
| 设置 | `component.keys`；字段文案 / schema 说明见模块注释与 `lib/client.js` 的 `INPUT_FIELDS` |

命名：`id` 使用 **kebab 小写**，与现有一致：`office`、`blender`、`unity`、`figma`、`photoshop`、`chrome`、`godot`。`tools/<id>/`、API `/components/<id>/…`、设置键前缀（如 `chromeEnabled`）均对齐该 id。

---

## 稳定接口（组件模块必须导出）

```ts
/** 进程匹配（已连接 (a)） */
export type AppMatch = {
  name: string    // 人类可读，如「Blender」
  exe: string     // 提示用，如 blender.exe
  match: RegExp   // 对 listProcesses() 返回的小写进程名
}

/** 探测上下文（只读，不拉起程序） */
export type ProbeCtx = {
  cfg: object
  tools: unknown
  env: object           // defaultEnv 可覆盖
  procs: () => Promise<Set<string>>
}

export type LaunchPlan =
  | { ok: true, source: string, config: object, runtime?: string, via?: string, viaUvx?: boolean }
  | { ok: false, reason: string, missing?: boolean }

/**
 * 注册给宿主的组件对象（COMPONENTS 数组元素）
 * @typedef {object} ComponentModule
 * @property {string} id
 * @property {string} label
 * @property {string} [url]
 * @property {string} serverName   // 工具前缀 mcp__<serverName>__
 * @property {string} summary
 * @property {'bundled'|'local'} [moduleSource]
 * @property {string} [moduleDir]
 * @property {'node'} [runtime]    // 缺省 Python/uv；node → npm
 * @property {string[]} keys       // 变更后需重挂的设置键
 * @property {(cfg)=>string} [spec]
 * @property {string} [bin]
 * @property {string[]} [installArgs]
 * @property {(cfg?)=>boolean} installed
 * @property {(cfg, task, hooks)=>Promise} [install]
 * @property {(cfg)=>LaunchPlan} launch
 * @property {(cfg)=>string|null} [note]
 * @property {(log?)=>Promise} [beforeRemove]
 * @property {(cfg, project, opts?)=>Promise} [installAddon]  // 如 Godot 装插件到项目
 */
```

每个 `src/components/<id>/index.mjs` **至少**导出：

| 导出 | 说明 |
| --- | --- |
| `id` | 与文件夹名相同 |
| `meta` | `{ id, title, group, url?, serverName, summary }` |
| `app` | `AppMatch`，供进程探测 |
| `probe(ctx)` | 已连接探测；绑定 `this` 为 component；用 `connect-lib` 原语 |
| `component` / `default` | `ComponentModule`，供 `COMPONENTS` 注册 |

宿主通过 `registry.mjs` 收集后：

- `createComponentManager` 按 `component.launch` / `install` 挂载与安装
- `probeComponent` 调 `PROBES[id]`（即各模块的 `probe`）
- `GET /components` 的 `url` 来自 `component.url`

---

## 什么留在共享层

| 共享 | 位置 | 职责 |
| --- | --- | --- |
| 安装队列 / suspend·resume | `manager.mjs` | 串行安装、替换前停挂、装完重挂 |
| HTTP 路由 | `src/index.mjs` | `/settings`、`/components`、`install`/`uninstall`/`addon`、`/assets` |
| 设置壳 | `src/index.mjs` `SettingsSchema` + `lib/client.js` | schema 与 UI；字段键与组件 `keys` 对齐 |
| 下载 / venv / npm 原语 | `src/tools.mjs` | `installUv`、`installNode`、`installVenvTool`、`installNpmPackage`、`installOffice`、Godot addon 校验等 |
| 进程列表 / TCP / MCP 调用 | `src/connect-lib.mjs` | `listProcesses`、`tcpOpen`、`callMcpTool`、`listPages`… |
| 解析与 stdio 封装 | `components/shared.mjs` | `resolveUv`/`resolveNode`/`npmLaunch`/`stdio`/`http` |

uv、Node.js 在 `manager.list()` 里以 `kind: 'prerequisite'` 出现，**不要**放到 `src/components/uv`（除非未来明确要做成可插拔「工具行」）。

---

## 本地模块沙箱（隔离）

`local-components/<id>/index.mjs` **不在宿主进程里** `import`。registry 通过 `child_process.fork` 拉起 `local-loader-worker.mjs`，在子进程中加载模块，并用 IPC 代理 `launch` / `install` / `probe` / `installed` / `note` 等生命周期方法。

**为什么用 fork 而不是 Worker：** 在 Node 里，Worker 内的 `process.exit()` 仍会结束整个进程，无法达到「坏模块不能干掉 DSH Desktop」的目标。

| 威胁 | 宿主行为 |
| --- | --- |
| 顶层 `process.exit(0)` / 未捕获异常 | 仅子进程退出；该组件加载失败并 `warn`，其它组件继续 |
| 导入或方法调用时死循环 / 挂起 | 超时后 `kill` 子进程；宿主继续，该次调用报错 |
| CPU / 内存打满 | 超时可杀子进程；**Windows Electron 下没有实用的 cgroup 限额**，无法保证整机不被拖慢 |

**仍然不要运行不信任的代码。** 沙箱隔离的是进程退出与挂起，不是完整安全沙箱：子进程仍能读盘、起进程、占 CPU/内存；原生 addon 也在子进程加载。Local 模块也不应依赖宿主 Electron / cordis 私有 API。

**导入宿主原语：** 用 `import { … } from 'dsh-work-components/sdk'`。`lib/local-loader-worker.mjs` 是独立打包的（发布包里没有 `src/`），它注册了一个 resolve 钩子：`dsh-work-components/sdk` → `lib/component-sdk.mjs`（= `shared.mjs` + `tools.mjs` + `connect-lib.mjs` 的全部导出）。旧写法 `../../src/components/shared.mjs` / `../../src/tools.mjs` / `../../src/connect-lib.mjs` 在文件存在时照常解析（开发检出），不存在时同样落到 SDK。

手动回归：在 `local-components/evil-exit/index.mjs` 顶层写 `process.exit(0)`，或 `while (true) {}`，重启 / 重载插件后宿主应仍活着，日志里有对该组件的失败 warn。

---

## 本地 vs 仓库自带

| | 仓库自带（bundled / 已兼容） | 本地兼容（local） |
| --- | --- | --- |
| 路径 | `src/components/<id>/`（进 git） | `<dataDir>/local-components/<id>/`（默认 `~/.dsh/data/dsh-work-components/`；旧检出里已有的 `<pluginRoot>/local-components/` 原地沿用） |
| 标记 | `moduleSource: 'bundled'`（registry 写入） | `moduleSource: 'local'` |
| 发现 | `registry.mjs` 静态 import | 启动时扫描目录；在 **forked child** 中 `import()`（超时 / exit 隔离） |
| 设置页 | 「工作组件」分组，徽标「已验证」 | 「本地兼容」分组，徽标「本地」；管理页可「贡献到仓库」 |
| 覆盖 | — | 与 bundled **同 id 时 bundled 优先**，本地被忽略 |

**为何用 `local-components/` 而不是 `tools/`，以及为何在数据目录：**

- `tools/` 是「下载安装」落地的运行时目录（MCP 包、uv、Node…），与**源码模块**不同；AI / 用户写入的兼容模块不应混进去。
- 两者都在插件数据目录（`$DSH_HOME/data/dsh-work-components/`，可用 `DSH_WORKBENCH_DATA_DIR` 改）而不是包目录：包目录在升级 / 重装时会被整个替换。
- 首次启动时，旧检出里非空的 `<pluginRoot>/tools/`、`<pluginRoot>/local-components/` 记录进 `<dataDir>/legacy-locations.json` 原地沿用（venv 里有绝对路径，搬动会坏）；设置文件与 GameBot 数据则迁移进数据目录（`<dataDir>/migration.json` 记录，只做一次）。
- 仍可用环境变量 `DSH_WORKBENCH_LOCAL_COMPONENTS_DIR` / `DSH_WORKBENCH_TOOLS_DIR` 单独指定。

**不要**在「添加工作组件」AI 流程里自动往 `tools/` 下载 MCP；本地 = 磁盘上的源码模块，安装仍由用户在设置页触发。运行时下载只落在 `tools/`（gitignore）；**仓库不附带**已下载的 MCP 树。

### 提交 PR（本地 → 仓库）

设置页本地组件管理页提供「复制 PR 清单」「打开 Compare」。**安全默认（不会代用户动 git）**：

- [ ] 自检模块导出齐全（`id` / `meta` / `app` / `probe` / `component`）
- [ ] `launch` 关闭判断用 `!cfg.<id>Enabled`（缺键/false 均关，仅 true 启）；自定义参数有中文说明与拟议 schema 注释
- [ ] 复制 PR 清单 + `git` / `gh` 命令模板
- [ ] 打开 https://github.com/meya-ashuripehya/dsh-work-components/compare
- [ ] 由用户本人审阅后自行 commit / push / 开 PR

**禁止**插件侧自动：commit、push、force-push、未确认时的 `gh pr create`。

API：`GET /dsh-workbench/api/components/<id>/contribute`（返回清单、文件列表、compare URL、命令模板）。

合并进仓库时：把 `local-components/<id>/` 拷到 `src/components/<id>/`，再按下面「合入仓库」清单改 registry / schema / client。

---

## 新增组件检查清单

### 设置页提示词（clipboard；给 AI 用）

`lib/client.js` 的 `buildAddComponentPrompt()` 会把**完整模块约定内嵌**进复制文本（落盘路径、各导出字段与 chrome/office 例、`tools/<id>/` 不下载、本地 drop-in 发现、设置页无需手改 FEATURES/ICONS）。改约定时请同步更新该函数，避免 AI 再去读本文件或其它源码（省 token）。UI 上的 Token 声明常量 `ADD_COMPONENT_TOKEN_WARN`（含作者实测参考用量）与提示词正文分开，勿混进 prompt。

提示词原则（与 UI 文案保持一致）：

1. **选型**：搜索 MCP / 自动化方案时对比能力范围、协议、维护、许可证；**功能最全优先**，其次维护与许可证。
2. **落盘**：只写 `<本地组件目录>/<id>/index.mjs`（`GET /components` 的 `localComponentsDir`）；**不要**改 `src/components/` / `registry.mjs`；**不要**自动下载进 `tools/`。
3. **参数**：AI **应**为组件增加可配置或必填参数（host、package、path、token 占位等），给出清晰**中文** label / 帮助文案；优先补上有用参数而不是省略。
4. **本地阶段配置**：在 `keys` 中声明；在 `launch()` / `spec()` 里硬编码默认（如 `cfg.xxxPackage || 'upstream-pkg'`）；在模块注释与 `meta.summary` / `note` 说明；若也需要 UI 字段，在注释写出拟议的 `SettingsSchema` / `INPUT_FIELDS` 形状（含中文 label / desc），供后续 PR。
5. **持久化**：未进 schema 的自定义键（除宿主已合并保留的本地 `*Enabled` 外）**不会**进持久化 `cfg`；此时无法在 UI 改这些键。
6. **启用键**：`<id>Enabled`；详情页已有开关；`launch` 用 `!cfg.<id>Enabled` 关闭（缺键 / false = 关，仅 true = 启）。
7. **就位后**：用户可重启 DSH，再在设置页「下载安装」；本提示词**不要** commit / push / 开 PR。

### A. 先做本地兼容（推荐；设置页「添加工作组件」提示词走这条）

1. 建目录 `local-components/<id>/`，实现 `index.mjs`（`meta` / `app` / `probe` / `component`）。
2. 重启 / 重载插件后应出现在设置页「本地兼容」；**不要**改 `registry.mjs` 静态表。
3. **不要**把 MCP 下载进 `tools/`（除非用户在 UI 点「下载安装」）。
4. 详情页已有「启用」开关（`<id>Enabled`，**缺省关**；仅显式 `true` 启）。`launch` 用 `if (!cfg.<id>Enabled) return OFF`。其它自定义键仍无 UI，须待 schema / INPUT_FIELDS；`spec` / 默认包名可在模块内硬编码。
5. `probe`：守护进程 / 远程 / WSL 等可先探测 MCP/工具，勿在无 Desktop 进程时一律 `noAppFor`。
6. 满意后用管理页「贡献到仓库」：复制清单 + 打开 GitHub Compare；**不**自动 commit / push / `gh pr create`（见上「提交 PR」）。

### B. 合入仓库（bundled）

1. 将模块放到 `src/components/<id>/`，在 `registry.mjs` 增加 import 并写入 `COMPONENTS`。
2. 在 `src/index.mjs` 的 `SettingsSchema` 增加默认键（`<id>Enabled`、包名、端口等）。
3. 在 `lib/client.js` 增加 `INPUT_FIELDS`、`FEATURES` 行与 `ICONS`（图标暂不强制进模块）；`FEATURES` 上标 `moduleSource: "bundled"`。
4. 若有静态资源：放 `assets/`，经 `/dsh-workbench/assets/*` 提供。
5. 若有「装进项目」类动作：实现 `installAddon`。
6. `npm run build`；按需 smoke。
7. 更新本文件与 README 组件表；删除或停止使用对应的 `local-components/<id>/`。

---

## 本地启用键与 RuntimeSettingsSchema

本地组件详情页有「启用」开关（与 bundled 相同 UI），键名 `<id>Enabled`，**缺省关闭**（与 bundled 一致：新鲜安装不自动挂 MCP）。

- 前端：`lib/client.js` 的 `ensureLocalEnabledField(id)` 动态注册 switch；`fill` / 详情渲染缺键时按 **OFF**。
- 后端：`src/index.mjs` 在加载时用 `localEnabledSchemaExtras()` 收集当前 local 的 `*Enabled`（schema 默认 `false`），得到 **`RuntimeSettingsSchema`**（`SettingsSchema` ∩ 本地启用键）。`Config` / `settings.register` / `POST /settings` 走该 runtime schema。
- `pickLocalEnabled`：Cordis `settings.register` 可能丢掉未知键时，把本地 `*Enabled` 布尔值合并回 `current`，避免开关写不进或读丢。
- `launch` / manager：`!cfg.<id>Enabled`（缺键 / false）视为关闭；仅显式 `true` 挂载。

## 本地示例模式（Docker，不强制进库）

本机可在 gitignore 的 `local-components/docker/` 放一份示例模块（上游如 [mcp-server-docker](https://github.com/ckreiling/mcp-server-docker)），用于验证自动发现、启用开关、`keys` + `spec`/`launch` 硬编码默认（如 `dockerPackage` / `dockerHost`）。**仓库不要求提交 `local-components/`**；文档只描述模式：

1. `local-components/<id>/index.mjs` 实现与 bundled 相同的导出。
2. `keys` 含 `<id>Enabled` 与可选参数键；`spec`/`launch` 用 `cfg.xxx || 默认`。
3. 重启 / 重载后出现在「本地兼容」；详情页可启用、下载安装（产物进 `tools/<id>/`）、贡献清单。
4. 满意后再按「合入仓库」清单拷进 `src/components/`。

---

## 与前端的关系

`lib/client.js` 仍由 ModuleLoader 直接加载，**不**从 `src/components` 打包。约定：

- `FEATURES[].id` / `component` / `url` 与模块 `meta` 一致
- `INPUT_FIELDS` 的 key 覆盖该组件管理页字段，且重挂相关键 ⊆ `component.keys`（可另含仅 UI 用的键，如 `godotProject`）

日后若要「UI 也模块化」，可把 `settingsFields` 从模块导出再生成客户端数据；当前以同步手写文案为准。

---

## 反例

- 在 `src/components/<id>/` 里 vendor 上游 npm/PyPI 包或解压 Godot 插件 zip → 应落在 `tools/<id>/`
- 在探测里调用会拉起目标程序的工具（例如 Chrome `list_pages` 在 profile 未占用时）
- 随意改 `id` / `serverName`（会破坏工具名前缀与已存设置）
