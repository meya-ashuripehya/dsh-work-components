# dsh-work-components（工作组件）

兼容 DeepSeek Harness（DSH）的插件，用来统一挂载和管理「控制其他工作软件」的 MCP 服务器（Office / 创作工具 / Windows 桌面 / Notion / Cloudflare / GitHub / ComfyUI 等）。每个工作组件以 `@deepseek-ai/dsh-mcp-client` 子插件的形式挂载：不写进 profile，随本插件卸载，设置改动后只重挂受影响的组件。

自有代码采用 [MIT 许可证](./LICENSE)。`vendor/dsh-tools/` 是 DeepSeek 的代码副本，版权归 DeepSeek，许可同样是 MIT，全文和保留义务见 [NOTICE](./NOTICE) 与 [vendor/dsh-tools/LICENSE](./vendor/dsh-tools/LICENSE)。

文中的产品名称只用来说明兼容对象，是各自权利人的商标。本项目与 DeepSeek、微软、Blender Foundation、Unity Technologies、Figma、Adobe、Google、Godot Foundation、Notion、Cloudflare、GitHub、Comfy、FFmpeg、Obsidian 等没有隶属、赞助或授权关系。设置页图标是通用线条；仓库不收录第三方产品标志。插件自身设置页的实装截图见下文「实装截图」。

| 组件 | MCP 服务器 | 工具名前缀 | 前提（简述） |
|---|---|---|---|
| Office | [OfficeMCP](https://github.com/officemcp/officemcp)（COM） | `mcp__officemcp__` | Windows + Office（Word / Excel / PowerPoint 等） |
| Blender | [mcp-for-blender](https://github.com/ahujasid/blender-mcp)（PyPI） | `mcp__blender__` | Blender 开着并启用对应插件 |
| Unity | [mcp-for-unity / mcpforunityserver](https://github.com/CoplayDev/unity-mcp)（Coplay） | `mcp__unity__` | Unity 编辑器装了 MCP for Unity 包并开着工程 |
| Figma | [figma-console-mcp](https://github.com/southleft/figma-console-mcp)（npm；也可改连官方桌面版 MCP） | `mcp__figma__` | Figma 桌面版 + Desktop Bridge（console）或 Dev Mode 官方 MCP |
| Photoshop | [@alisaitteke/photoshop-mcp](https://github.com/alisaitteke/photoshop-mcp)（npm，COM / ExtendScript） | `mcp__photoshop__` | Windows（或 macOS）装有 Photoshop 并开着 |
| Chrome | [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（npm） | `mcp__chrome__` | 本机 Google Chrome；可独立启动或连已有实例 |
| Windows | [Windows-MCP](https://github.com/CursorTouch/Windows-MCP)（PyPI） | `mcp__windows__` | Windows；stdio 由插件拉起，或连已有 HTTP 服务 |
| Notion | [Notion MCP](https://developers.notion.com/docs/mcp)（经 [mcp-remote](https://github.com/geelen/mcp-remote) OAuth 桥） | `mcp__notion__` | 首次 OAuth；token 在 `%USERPROFILE%\.mcp-auth` |
| Cloudflare | [Cloudflare API MCP](https://github.com/cloudflare/mcp-server-cloudflare)（经 mcp-remote） | `mcp__cloudflare__` | 首次 OAuth（scope=offline_access） |
| Cloudflare Docs | [Cloudflare Docs MCP](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-catalog/)（公开 HTTP） | `mcp__cloudflare-docs__` | 无需登录 |
| GitHub | [GitHub MCP](https://github.com/github/github-mcp-server)（托管 HTTP） | `mcp__github__` | PAT：设置 `githubToken` 或环境变量 `GITHUB_MCP_PAT` |
| ComfyUI | [comfy-mcp](https://github.com/Comfy-Org/comfy-mcp)（PyPI） | `mcp__comfyui__` | 本机 ComfyUI / comfy-cli |
| Godot | [godot-ai](https://github.com/hi-godot/godot-ai)（PyPI，`godot-ai attach`） | `mcp__godot__` | Godot 4.7+ 编辑器开着项目，且项目启用了同版本 Godot AI 插件 |
| FFmpeg | [Kinocut](https://github.com/KyaniteLabs/kinocut)（PyPI `kinocut`，原 mcp-video） | `mcp__ffmpeg__` | 本机已安装 ffmpeg/ffprobe（PATH 或设置路径） |
| Obsidian | [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server)（npm） | `mcp__obsidian__` | Obsidian 开着 + 社区插件 Local REST API + API 密钥 |

组件依赖的运行时（uv + Python，或 Node.js）与各上游 MCP 包，都可以在设置页「下载安装」到插件数据目录的 `tools/`（见下文「数据目录」）。**新鲜安装时所有工作组件 MCP 与会话控制均默认关闭**（`*Enabled: false`），装好后在管理页逐个打开「启用」才会挂载对应 MCP。具体安装、桥接、端口与项目侧配置都在设置 UI 里完成，本 README 不重复操作步骤。

已内嵌：GameBot（src/components/gamebot/）。

## 安装

在 DSH Desktop 里让智能体用内置的 `plugin_manager` 安装 bundle（不要自己在 profile 目录里跑 npm / pnpm，`install_bundle` 会完成包安装和 bundle 选择）：

1. 对智能体说：「用 plugin_manager 的 install_bundle 安装 npm 包 `dsh-work-components`」。
2. 本包没有 install / postinstall 构建脚本；如果结果里列出待批准的构建脚本，不要批准，先确认来源。
3. 用 `list_bundles` / `list_plugins` 确认 `dsh-work-components` 已启用；结果是 `restart-required` 时重启 DSH Desktop。替换已装的版本（升级）同样需要重启才会加载新代码。
4. 打开设置页「工作组件」，按需「下载安装」各组件并打开「启用」（新装时全部默认关闭）。

卸载：`plugin_manager` 的 `remove_bundle`。数据目录（设置、已下载的工具、GameBot 数据）不随包删除，需要时手动删掉。

要求：DSH Desktop（Node ≥ 22.15 运行时，会话控制要用 zstd）；Office / Photoshop / Windows 等组件只在 Windows 上可用。

## 数据目录

插件不往自己的包目录写任何东西（升级时包目录会被整个替换）。可写状态都在 `$DSH_HOME/data/dsh-work-components/`（`DSH_HOME` 缺省 `~/.dsh`；可用 `DSH_WORKBENCH_DATA_DIR` 整体改位置）：

| 路径 | 内容 |
|---|---|
| `settings.json` | 没有 DSH 设置服务时的设置持久化（可用 `DSH_WORKBENCH_SETTINGS_FILE` 改） |
| `tools/` | 「下载安装」落地的 uv / Python / Node.js / 各组件（可用 `DSH_WORKBENCH_TOOLS_DIR` 改） |
| `local-components/` | 本地兼容组件源码（可用 `DSH_WORKBENCH_LOCAL_COMPONENTS_DIR` 改） |
| `gamebot/` | GameBot 的 Python 环境（`.venv`）与数据（`data/game-configs.json`、记忆等；含服务商密钥明文） |

从旧版本（直接在仓库目录里运行）升级时，首次启动会一次性迁移：仓库根的 `.dsh-workbench-settings.json` 移到 `settings.json`，`src/components/gamebot/data/` 移到 `gamebot/data/`；已有的 `tools/`、`local-components/` 里有绝对路径（venv），所以原地沿用并记录在 `legacy-locations.json`。迁移记录在 `migration.json`，不会重复执行。

`GET /dsh-workbench/api/settings` 返回的密钥字段（令牌、API key、密码）一律是占位值 `__dsh_secret_saved__`；POST 原样带回占位值 = 保持不变，传空字符串 = 清除。

多模态：`mm_send_image`（本地图片 → Host `attachmentId`；render=`text`+`image`；UI：`presentationMeta.mm` → turnTail MmCard，toolview 仅 pending/compact）。

## 实装截图

![工作组件列表](https://github.com/meya-ashuripehya/dsh-work-components/raw/main/docs/images/01-settings-workbench-list.png)

## 设置页

DSH 设置里的「工作组件」页：首页是功能列表（按分组），行首应用图标、行尾实时状态，点进该项的管理页。

| 分组 | 功能 | 列表状态（示意） | 管理页要点 |
| --- | --- | --- | --- |
| 多模态 | 媒体卡片 | mm_send_image · 可用 | `mm_send_image` 发图（API text+image；settled MmCard 在 turnTail，toolview 折叠后仍可见） |
| 工作组件 | Office / Blender / Unity / Figma / Photoshop / Chrome / Godot / Windows / Notion / Cloudflare / Cloudflare Docs / GitHub / ComfyUI / FFmpeg / Obsidian（徽标「已验证」） | 已连接 / 已启用 / 未启用 / 未安装 / 出错 / 安装中… | 运行与连接说明、下载安装 / 卸载、「启用」、组件专属配置 |
| 本地兼容 | `local-components/<id>/` 下的用户模块（徽标「本地」；可用 env `DSH_WORKBENCH_LOCAL_COMPONENTS_DIR`） | 同上 | 与仓库自带同接口；详情页「启用」；管理页复制 PR 清单 / 打开 Compare（**不**自动 commit / push / `gh pr create`） |
| 通用 | uv / Node.js / 下载代理 | 可用 / 未安装 / 已设置… | 运行时安装与代理等共用项 |
| 基础工具 | 添加工作组件 | 提示词工具 | Token 声明 + 可复制 AI 提示词：写成**本地**模块（不装进 `tools/`）。选型**功能最全优先**；应补可配置/必填参数（中文 label）；本地阶段 `keys` + `launch`/`spec` 硬编码默认，拟议 schema 写注释；自定义键未进 schema 前不持久化。模块就位后重启 DSH，再在设置页下载安装。 |

有上游仓库的功能在标题旁显示蓝色网址文字（新标签打开）。管理页「‹ 返回」或 Esc 回列表；每页各自「保存」；「启用」拨动后立即单独保存（本地组件同样有启用开关，键 `<id>Enabled`，**缺省关**）。安装进行中列表与管理页约每 1.5 秒刷新；有组件已启动时约每 5 秒刷新以跟上「已连接」。设置命名空间：`dsh-workbench`。

### 「已连接」

优先级：安装中 / 排队中 → 出错 → **已连接** → 已启动 → 未启动 / 未安装。

- **已启动**（`status: on`）：MCP 服务器已挂载，尚未确认够得着目标程序。
- **已连接**（`status: connected`）：已启动，且 (a) 对应程序在运行，(b) MCP 层可达。

探测在 `GET /components` 时按需进行（`src/connect.mjs`）：只读、不拉起程序；结果缓存 `PROBE_TTL_MS`（6s），同一组件不并发，一轮共用一次进程列表；单次探测限时 `PROBE_TIMEOUT_MS`（15s）、工具调用默认限时 4s；请求最多等 1.5s，未完成的下次再带。工具经 `ctx.tools` 里 dsh-mcp-client 已有连接直接执行。上次已连接而本次工具超时则暂保持已连接并注明。组件重挂后旧结果作废。

| 组件 | (a) 程序在运行 | (b) MCP 够得着 |
| --- | --- | --- |
| Office | 进程 WINWORD / EXCEL / POWERPNT 等（含 Visio、Outlook、WPS 等） | `RunningApps`（COM，只读）非空 |
| Blender | 进程 blender | 已注册工具 + TCP 连插件端口（`BLENDER_HOST:BLENDER_PORT`，默认 `localhost:9876`） |
| Unity | 进程 Unity | 已注册工具 + 按 `~/.unity-mcp`（或 `UNITY_MCP_STATUS_DIR`）端口文件与默认 6400 做桥接 ping |
| Figma（console） | 进程 Figma（不含 figma_agent） | `figma_get_status` 中 `transport.websocket.available` |
| Figma（官方） | 进程 Figma | TCP 连官方 MCP 地址（默认 `127.0.0.1:3845`） |
| Photoshop | 进程 Photoshop | `photoshop_ping` 成功（`PSMCP_FEEDBACK=0`、`ANALYTICS_DISABLED=1`） |
| Chrome（launch） | chrome-devtools-mcp 专用配置目录被 Chrome 占用 | `list_pages` 成功（未占用时不调，避免拉起 Chrome） |
| Chrome（autoConnect） | chrome + 渠道默认配置目录有 `DevToolsActivePort` 且端口开 | `list_pages` 成功 |
| Chrome（browserUrl） | `GET <调试地址>/json/version` 成功 | `list_pages` 成功 |
| Godot | 进程名以 Godot 开头（不含 venv 里的 `godot-ai`） | 已注册工具 + `session_manage(op=list)` 有会话 + `editor_state` 成功 |
| FFmpeg | 本机能解析到 ffmpeg（PATH 或 `ffmpegPath`） | MCP 已就绪（Kinocut 不依赖常驻 GUI） |
| Obsidian | 进程 Obsidian | 已注册工具 + TCP 连 Local REST API（`obsidianBaseUrl`，默认 `127.0.0.1:27123`） |

## 架构（给开发者）

组件文件夹约定见 **[docs/component-module.md](./docs/component-module.md)**（布局、稳定导出、共享层、新增检查清单）。

```
src/
  index.mjs            宿主入口：SettingsSchema、API、mm_send_image
  components.mjs       兼容再导出 → ./components/
  components/          仓库自带组件 + shared / registry / manager
  connect-lib.mjs      「已连接」共享原语（进程 / TCP / MCP 调用）
  connect.mjs          汇总各组件 app/probe，提供 probeComponent
  tools.mjs            数据目录 / 迁移、tools/ 布局、下载、uv / Node / npm / venv 安装
  component-sdk.mjs    本地组件 SDK（shared + tools + connect-lib；构建成 lib/component-sdk.mjs）
lib/
  index.mjs            构建产物（宿主）
  local-loader-worker.mjs  构建产物（本地组件加载子进程）
  component-sdk.mjs    构建产物（本地组件 SDK，`dsh-work-components/sdk`）
  client.js            前端设置页、mm_send_image toolview（pending）与 turnTail MmCard（ModuleLoader）
office/launch.py       OfficeMCP 启动包装（stdio 友好）
cordis.patch.yml       bundle 层，插入宿主插件行
docs/component-module.md  组件模块约定（含 bundled vs local）
scripts/               build、vendor:sync、各类 smoke
locale/ icon.svg       插件管理器里的标题 / 简介 / 图标
```

**托管安装**：设置页可把 uv、Node.js 与各组件装进数据目录的 `tools/`（`.dsh-install.json` 记版本）。启动查找顺序一般为：托管 `tools/` → 设置路径 → 系统 / 旁路兜底（如 uvx、`npx`、旁边的 `../officemcp`）。Figma「官方桌面版 MCP」模式走 streamable-http，不需本地包。测试可用环境变量 `DSH_WORKBENCH_TOOLS_DIR` 改落地目录。

**同源 API**（前缀 `/dsh-workbench/api`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/settings` | 读写 `dsh-workbench` 设置（密钥打码，见「数据目录」） |
| GET | `/components` | `{ ok, dataDir, toolsDir, localComponentsDir, contributeCompareUrl, components }`；组件含 `moduleSource`（`bundled`/`local`）、`status`、`connection`、`install`、`source`（启动来源）等 |
| GET | `/components/<id>/contribute` | 仅 local：PR 清单、文件列表、compare URL、命令模板 |
| POST | `/components/<id>/install` | 开始（重新）安装，202；冲突 409。`id`：`uv` / `node` / `office` / … / `godot` / `ffmpeg` / `obsidian` |
| POST | `/components/<id>/uninstall` | 删除 `tools/` 中该安装 |
| POST | `/components/godot/addon` | body `{ project }`：把同版本插件装进 Godot 项目 |

另有 `/dsh-workbench/assets/*` 提供插件 `assets/` 静态资源。

### 从纯 MCP（cordis.patch）迁入

本机原先在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里用 `@deepseek-ai/dsh-mcp-client` 直接挂的 Windows / Notion / Cloudflare / Cloudflare Docs / GitHub / ComfyUI，已收进本插件的「工作组件」。迁完后请**去掉** profile 里对应的 `mcp-*` 插入项，避免工具双重注册；备份目录示例：`~/.dsh/profiles/desktop/.backup-before-mcp-to-workbench-*`。

**新增组件**：先写本地组件目录下的 `<id>/index.mjs`（设置页「添加工作组件」提示词；宿主原语从 `dsh-work-components/sdk` 导入），再按 [docs/component-module.md](./docs/component-module.md) 合入 `src/components/` 并开 PR。本地模块由 registry 自动发现（**fork 子进程加载**，坏模块的 `process.exit` / 挂起不会拖垮宿主；仍勿运行不信任代码），与 bundled **同 id 时 bundled 优先**。宿主用 `RuntimeSettingsSchema` 合并本地 `*Enabled`（见 `src/index.mjs`）。运行时下载仍只落在 `tools/`，仓库与 npm 包都不附带已下载的 MCP 树。测试可用 `DSH_WORKBENCH_LOCAL_COMPONENTS_DIR` 指向桩目录。

## 构建与测试

```powershell
npm install
npm run build          # 不依赖已安装的 DSH；defineTool 在 vendor/dsh-tools（升级后可 npm run vendor:sync）
npm run smoke          # 假 ctx，mm_send_image → lib/smoke.png
npm run smoke:tools    # 走同一套安装代码装组件，再 MCP initialize / tools/list（可指定组件、--proxy、--skip-install、--uninstall）
npm run smoke:office   # 按插件启动方案拉起 OfficeMCP（可用 --expect-managed）
npm run smoke:connect  # 「已连接」实机冒烟（Windows）：node scripts/connect-smoke.mjs chrome …
npm run smoke:local    # 本地兼容发现 / moduleSource / contribute 清单
npm run smoke:gamebot  # GameBot 设置下发冒烟（SMOKE_GAMEBOT_URL，默认 http://127.0.0.1:8767；临时配置 / 记忆目录）
npm run check          # 语法检查 + GameBot 字段与 lib/client.js 一致性（prepublishOnly 会先 build 再跑它）
```

发布走 GitHub Actions（`.github/workflows/publish.yml`，npm trusted publishing / OIDC，自动带 provenance）：推送 `v*` 标签触发；本地不要 `npm publish`。

从源码挂进 DSH Desktop：在 `~/.dsh/profiles/desktop` 用 `pnpm add link:<插件目录>`，并在 `dsh.profile.bundles` 加入 `"dsh-work-components"`（若 profile 里曾直接挂同名 mcp-client，先去掉以免重复）。改 bundle 后需重启 Desktop。


## 会话控制（通用）

内置于本插件，不单独装包。面向官方 Harness **0.2.0-rc.2** 会话日志。

### 功能

| 功能 | 入口 | 行为 |
|------|------|------|
| **撤回** | 用户消息下方操作行的「撤回」（设置 → 工作组件 → 通用 → 会话控制 可关） | 先把当前页正在看的会话恢复到内存，再追加一条 `surfaceOp: replace`，当前页收起该回合及之后的内容。恢复失败时才备份并物理截断磁盘日志，并由页面重新同步。 |
| **重试** | 助手操作行的「重试」（复制与分支之间） | 先恢复会话，再保留这条用户消息，用 `surfaceOp: replace` 收起它后面的回复，然后 `followup` 同一条内容。新回复直接流在原问题下面。恢复失败时不改磁盘日志。 |
| **熔断** | 输入框「暂停」按钮（随时可用，含思考中）；或自动阈值 | 暂停只调用 `agent.cancel({ kind: 'user' }, { keepInbox: true })`。自动熔断在同一取消之后，等回合停写，再按撤回把失败尾轮从磁盘截掉。 |

### 使用注意

1. 只打开着、还没在内存里的会话，会先按官方 `sessionController` 恢复，再在当前页收起内容。撤回收起该回合及之后的全部对话；重试留下原问题，收起原回复并立刻重新生成。页面不用退出再进。恢复失败时，撤回仍截断磁盘并由当前页重新同步；重试不先删日志。
2. 备份目录：`~/.dsh/repair-backups/workbench-session-controls-<时间戳>/`。
3. 聊天内自动使用当前会话 `sessionId`，无需粘贴；设置页仍可调自动熔断阈值。
4. 自动熔断阈值在设置页「会话控制」中调整。
5. 主开关 `sessionControlsEnabled` 经 `/settings` 保存。有 DSH 设置服务时写入该服务；Desktop 无设置服务时写入数据目录的 `settings.json`（可用 `DSH_WORKBENCH_SETTINGS_FILE` 覆盖路径）。启用后聊天内撤回/重试/暂停会立即出现，无需重启。

### API（宿主）

- `GET /dsh-workbench/api/session/turns?sessionId=`
- `POST /dsh-workbench/api/session/retract` `{ sessionId, userMessageSeq? , messageId? }`
- `POST /dsh-workbench/api/session/regenerate` `{ sessionId, userMessageSeq?, messageId? }`
- `POST /dsh-workbench/api/session/cancel` `{ sessionId, reason? }`
- `GET /dsh-workbench/api/session/notices`

## 游戏 · GameBot

GameBot（REST body + MCP 桥）内嵌在 `src/components/gamebot/`（共享层，不单独出卡片），设置页「游戏」分组**按游戏分卡**：

| 卡片 | 组件 id / MCP serverName | 启用键 |
|---|---|---|
| Minecraft | `gamebot-minecraft` | `gamebot-minecraftEnabled` |
| 文明 VI | `gamebot-civilization` | `gamebot-civilizationEnabled` |
| 视觉兜底 | `gamebot-vision` | `gamebot-visionEnabled` |

- **每次应用/会话启动全部默认关闭**，需重新启用；共享的 `gamebotUrl` / `gamebotRoot` 会记住。
- **共享 body**：任一游戏启用 → 自动启动一个 REST body（默认 `http://127.0.0.1:8766`）；全部关闭 → 停止（只停本插件拉起的进程）。
- **按游戏的 MCP**：每张卡一个 MCP 服务器（工具前缀 `mcp__gamebot-<game>__`），桥带 `GAMEBOT_GAME=<game>`：游戏参数固定、只列该游戏会话、拒绝其他游戏的 session、去掉 `list_games`、`get_game` 结果里的密钥打码。
- **仓库自带、已验证**：游戏卡没有「下载安装」。首次启用任一游戏时自动准备共享 Python 环境 `<数据目录>/gamebot/.venv`：用插件托管的 uv（没有就先装进 `tools/uv`）建 Python 3.12 venv，再**从 PyPI 下载安装** `pyproject.toml` 里的依赖（fastapi、uvicorn、httpx、websockets、pydantic、mss、Pillow、numpy 等，约半分钟到几分钟，走设置里的下载代理）；GameBot 代码本身随包提供，不再安装。装好后写 `.dsh-gamebot-ready.json` 标记；装到一半失败下次会重建。uv 不可用时退回本机 Python 3.10–3.12 + pip。
- **设置页是唯一来源**：每张卡包含该游戏在 GameBot 里的全部配置（驱动、地址、端口、目录、决策 / 聊天模型、服务商、密钥、人设、记忆…，键名 `gb_<game>_<配置键>`）。启用或保存时通过 `PATCH /v1/games/<game>` 下发到 body。密钥字段留空 = 保持 GameBot 已存的该服务商密钥；人设留空 = GameBot 默认。填写了 `gamebotRoot`（外部 GameBot 目录）时，首次加载会从它的 `data/game-configs.json` 一次性导入。
- GameBot 自带的网页设置前端（`/ui`）已移除，body 只提供 REST。
- Minecraft 只提供 minaret（NeoForge 模组 WebSocket）驱动。Mineflayer 驱动需要的 Node 桥（`minecraft-bridge`，依赖 mineflayer）不随包发布，所以设置页不显示；要用的话自备桥目录（`server.js` + `npm install`），设置环境变量 `GAMEBOT_MINECRAFT_BRIDGE_DIR` 指向它。
- 文明 VI 陪玩评论只经 DSH 宿主内的桥写入会话，GameBot 不直接写会话文件。
- 改了 `src/components/gamebot/fields.mjs` 后运行 `node scripts/gen-gamebot-fields.mjs` 再 `npm run build`。冒烟：`npm run smoke:gamebot`。

**勿与 DSH 桌面大脑同时驱动同一游戏**（双脑）。
