# QQ 通道组件设计（工作组件「通道」分组）

> 状态：v1 已落地（宿主半边 + runtime + 卡片；聊天室/棋牌后做）。对应用户澄清：QQ 作为 **dsh-workbench / work components 内的通道卡片**，与 Telegram「通道」同模式；**不是**独立 `@wsz987/dsh-channels` 包。  
> 仓库：`S:\TRIX\dsh-workbench`（包名 `dsh-work-components`）。机器：Ashuripehya。  
> 日期：2026-10-25（America/New_York）；pending allowlist 补丁 2026-10-27。**无 commit。**

---

## 1. 今天 Telegram 通道怎么活着

「通道」**不是** `ComponentModule`（无 MCP / 无下载安装）。约定见 `docs/component-module.md`「通道」段。

### 1.1 路径地图

| 角色 | 路径 |
| --- | --- |
| 宿主半边（设置键、启停、冲突、列表项、API） | `src/channels/telegram/index.mjs` |
| 运行时（仅「启用」后动态 import） | `src/channels/telegram/runtime.mjs` → 打包为 `lib/channel-telegram.mjs` |
| 账号 / 多 bot | `src/channels/telegram/accounts.mjs` |
| 群路由 / 聊天室互斥 | `src/channels/telegram/group-route.mjs`、`group-conflict.mjs` |
| 私聊待授权 | `src/channels/telegram/dm-pending.mjs` + `src/telegram/dm-discover.mjs` |
| Owner / 工具门闸 | `src/channels/telegram/owner-gate.mjs` |
| 轮询归属 / 入站分发 | `src/telegram/polling-owners.mjs`、`dispatch.mjs`、`raw-hub.mjs` |
| 棋盘 / 牌桌出站桥 | `src/boards/telegram*.mjs`、`src/cards/telegram*.mjs`（`globalThis` Symbol 桥） |
| 聊天室复用 bot | `src/chatroom/telegram-bots.mjs` |
| Schema 并入 | `src/index.mjs` → `...telegramSchemaShape(z)`、`createTelegramChannel(...)` |
| 设置页卡片 UI | `lib/client.js`：`FEATURES` 里 `id:"telegram", group:"通道"` + `INPUT_FIELDS` 的 `telegram*` 键 |
| Vendor 适配器 | `vendor/wsz987/channel-{core,harness,telegram}` + patches；`@wsz987/channel-*@0.5.1` |
| 旧独立插件（已移出 profile） | `S:\TRIX\dsh-plugins\dsh-telegram-temp` |

### 1.2 运行与路由要点

1. **默认关闭**；`telegramEnabled === true` 才 `import` 运行时，挂在本插件 `ctx.plugin()` 的 fork 下；关开关 / 卸载整树 dispose。
2. Cordis 栈：`channel-core` → `channel-harness` → `channel-telegram`（与 temp 插件一致，但不走独立 `cordis.patch.yml` 聚合）。
3. **令牌进宿主 credentials**（`telegramTokenRef` / 每 bot `tokenRef`），不进插件设置 JSON。
4. 入站 → harness 建 / 路由 DSH 会话；出站经 ReplyRouter（含分段、draft 流式、图片 / 文件转发补丁）。
5. **按群聊 ID 路由**：聊天室已绑定的群排除出通道（`excludeBoundChatIds` + `roomConflictsFor`）；同一 bot 可服务通道与聊天室，但同一群不能两边都收。
6. 冲突保护：profile 仍挂 `dsh-telegram-temp` 或 `@wsz987/dsh-channels`、宿主已有他人 `channels` / `channelControl` → 不启动；运行中 409 → 停轮询。
7. UI：设置页「工作组件」列表 → 分组「通道」→ 卡片「Telegram」；**设置全部在卡片上**，无单独通道设置页。

### 1.3 卡片字段（Telegram，对照用）

开关：`telegramEnabled`  
网络：`telegramProxy`  
身份：`telegramOwnerId`、`telegramAllowFrom`、`telegramAuthorizedIds`  
群：`telegramGroupPolicy` / `GroupIds` / `RequireMention` / `SenderPolicy`  
路由：`telegramChannelRoutes`、`telegramRoutingMode`、账号表 `telegramBots`（令牌凭据 + 私聊/群预设）  
出站：`telegramFormat`、`SendReasoning`、`ShowToolCalls`、`ReasoningMaxChars`、`StreamMode`、`IncludeMetadataPrefix`、`InboundPreempt`  
调试：`telegramDebugTrace`  
高级：`telegramTokenRef`

---

## 2. 提议：QQ 孪生组件

### 2.1 放置与命名

- **同一「通道」分组**，**兄弟卡片**（不是 Telegram 子开关）：`id: "qq"`，`group: "通道"`，`title: "QQ"`。
- 代码树镜像：`src/channels/qq/`（`index.mjs` 宿主半边 + `runtime.mjs` → `lib/channel-qq.mjs`）。
- 设置键前缀：`qq*`（与 `telegram*` 对称）。
- **不**新建 `@wsz987/dsh-channels` 聚合插件；**不**把 QQ 塞进 Telegram 卡片。
- 中文 UI label / desc；若暴露工具，description 用英文（与现有插件工具一致）。

### 2.2 提议的卡片表面（v1）

| 键 | UI（中文） | 说明 |
| --- | --- | --- |
| `qqEnabled` | 启用 | 默认关；开后才加载 `lib/channel-qq.mjs` |
| `qqAppId` | AppID | QQ 开放平台机器人 AppId（非机密，可进设置） |
| `qqAppSecret` | AppSecret | 表单占位；保存写入 credentials，设置里恒空 / 掩码 |
| `qqAppSecretRef` | 凭据引用名 | 默认 `QQBOT_APP_SECRET` |
| `qqOwnerOpenId` | 所有者 OpenID | 平台侧 C2C 通常仅机器人创建者；卡片可显示 / 固化发现结果 |
| `qqAllowFrom` | 允许的其他用户 | OpenID 列表（若平台允许多人 C2C 时才有意义；v1 可先只做展示 + 白名单钩子） |
| `qqGroupPolicy` | 群聊 | `disabled` / `allowlist` / `open`（默认同 Telegram：`disabled`） |
| `qqGroupIds` | 群 OpenID | 官方 API 用 **group_openid**，不是传统 QQ 群号；文案必须写清 |
| `qqGroupRequireMention` | 群内需要 @ | 官方网关默认 AT 事件；默认 **开**（对齐平台） |
| `qqAuthorizedIds` | 授权用户 | 可改电脑的工具门闸（复用 owner-gate 思路） |
| `qqPreset` / 账号表 | 预设 | v1 可单账号 `main`；多 bot 以后再说 |
| `qqChannelRoutes` | 通道级预设覆盖 | 形如 `qq:预设ID` |
| `qqRoutingMode` | 路由模式 | 同 Telegram 枚举 |
| `qqIncludeMetadataPrefix` | 元数据前缀 | 默认开 |
| `qqMarkdownSupport` | Markdown | 对应适配器 `markdownSupport` |
| `qqStreamEnabled` | 私聊流式 | C2C native replace；群 buffered |
| `qqDebugTrace` | 排查日志 | `~/.dsh/dsh-channels/qq-inbound.log` |

状态行：未启动 / 正在连接 / 已连接 / 未连接 / 出错（复用 Telegram `liveState` 形）。

### 2.3 路由到 DSH / 聊天室

- 通道会话键：`channelId: 'qq'`，`accountId: 'main'`（或以后多账号）。
- 私聊 / 群 → harness `AgentRouter` → DSH session（与 Telegram 相同）。
- **群互斥**：聊天室若日后绑 QQ 群，同一 `group_openid` 不能同时进通道与聊天室（照抄 `group-conflict` / `roomConflictsFor`）。
- v1 **聊天室可不接 QQ**（Telegram 群桥已验证；QQ 聊天室绑定列为 later）。
- 棋盘 / 牌桌 / mm 出站：v1 可只做文字 + 适配器已有的 image/file；boards/cards 的 `channel === 'telegram'` 硬编码 **later** 再泛化。

### 2.4 Cordis / 冲突

与 Telegram 对称：

- 冲突若 profile 仍有 `@wsz987/dsh-channels`（其内含 QQ）或其它插件已提供同名 `channels` 服务 → 不启动并提示移除。
- 本组件自己 fork 提供的 `channels` 不算冲突（`detectConflict({ ownServices: true })`）。
- AppSecret **只**走 `ctx.credentials`；日志脱敏。

---

## 3. 协议选项与 v1 推荐

| 方案 | 机制 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 官方 QQ 机器人 OpenAPI v2** | `@tencent-connect/qqbot-nodejs`；AppId + AppSecret；WS 网关 | 合规、无个人号风控；**已有** `@wsz987/channel-qq@0.5.1`，与现有 core/harness 同栈；C2C 原生流式 | 群常需 @；能力受平台额度 / 意图限制；身份是 openid 不是 QQ 号 |
| **B. OneBot v11（NapCat / Lagrange）** | 本机正向 WS（如 `ws://127.0.0.1:3001`）+ token | 个人号体验、群可不 @、媒体更松；Windows 本机好装 | 第三方协议 / 账号风险；**wsz987 无现成 channel-onebot**；要自写适配器 |
| **C. 挂完整 `@wsz987/dsh-channels`** | 聚合插件 | 上游已含 QQ | **用户明确拒绝**：要进 work components，不要独立聚合包 |

### v1 默认推荐：**方案 A（官方 bot + `@wsz987/channel-qq`）**

理由（贴合 Windows Ash + DSH + 现有 Telegram 形态）：

1. Telegram 已验证路径是「vendor 适配器 + 本插件卡片启停」，QQ 上游适配器 **同版本 0.5.1 已发布**（`Tencent official SDK, native C2C streaming + buffered group`）。
2. Ash 上不必再跑 NapCat 进程；只要开放平台应用 + 凭据。
3. 与「个人助手」场景兼容：C2C 面向机器人创建者；Shiro 用官方 bot 私聊 DSH，模式接近现在的 Telegram bot。
4. OneBot 留作 **v2 可选引擎**（卡片上 `qqEngine: official | onebot`），不挡第一刀。

风险标注：插件文案写清「需在 [q.qq.com](https://q.qq.com/qqbot/openclaw/) 创建机器人；群消息默认需 @；身份为 OpenID」。

---

## 4. ATRI `qq_callback` 探查

- 路径：`S:\TRIX\ATRI-MAIN\route_extensions\qq_callback`
- **空目录**（仅 `.` / `..`，0 文件；约 2026-02-10 建）。
- 同级 `telegram_callback` 也几乎只有 `describe.env` 占位。
- **没有可接线的回调实现**；本设计不依赖 ATRI，不在 ATRI 里做第一刀。

---

## 5. 先做 vs 后做

### 先做（第一切片）

1. `src/channels/qq/index.mjs`：`qqSchemaShape`、`createQQChannel`、`item()`、`detectConflict`、secret absorb（镜像 telegram index，单账号即可）。
2. `src/channels/qq/runtime.mjs`：动态加载；`apply(channel-core)` + harness + `@wsz987/channel-qq`（vendor 进 `vendor/wsz987/channel-qq`，扩展 `scripts/vendor-channels.mjs`）。
3. `src/index.mjs` 挂载 / sync / dispose / settings decorate；`lib/client.js` FEATURES + INPUT_FIELDS（中文）。
4. 凭据：`QQBOT_APP_SECRET`；启用后连官方网关；私聊一轮 + 可选指定群 @ 一轮冒烟。
5. 访问策略：owner / allowlist 写入 channel-core access policy（对齐 telegram `applyAccessPolicy`）。
6. 文档：本文件；README「通道」一句带过 QQ（实验性亦可）。

### 明确后做

- 多 QQ 机器人账号表（Telegram 多 bot 已标「未验证实验性」）。
- 聊天室 QQ 群绑定 / 共享入站。
- boards / cards / map place / calendar 出站泛化到 `channel !== 'telegram'`。
- OneBot / NapCat / Lagrange 引擎与本地 WS 设置。
- ~~未授权私聊发现 UI（Telegram `dm-pending` 孪生）。~~ **已做（2026-10-27）**：私聊 + 群聊 pending allowlist（`src/channels/qq/pending.mjs` + `src/qq/pending-discover.mjs`；设置页 `buildQQPendingPanel`；授权仅本机 `/qq/pending`；群在 `disabled` 下仍发现，授权时追加 `qqGroupIds` 并切到 `allowlist`）。
- 独立 npm 包或 `@wsz987/dsh-channels` 聚合（按用户要求不做）。

### 本回合不做

- 大段实现 / commit / 重启桌面。
- 因 ATRI 空目录而「接线」。
- 引入 NapCat 为默认。

---

## 6. 建议的文件落点（实现时）

```
src/channels/qq/
  index.mjs          # 宿主半边
  runtime.mjs        # 打包源
  accounts.mjs       # v1 可极简（仅 main）
  owner-gate.mjs     # 或与 telegram 抽 shared（later）
lib/channel-qq.mjs   # 构建产物
vendor/wsz987/channel-qq/
lib/client.js        # FEATURES + INPUT_FIELDS
src/index.mjs        # schema + createQQChannel
package.json         # 依赖 @wsz987/channel-qq@0.5.1
docs/qq-channel-component.md  # 本文件
```

---

## 7. 一句话结论

在 **工作组件 › 通道** 下加兄弟卡片「QQ」：默认关、设置全在卡片、凭据走宿主；v1 用现成 **`@wsz987/channel-qq`（腾讯官方 SDK）** 镜像 Telegram 的 core/harness 挂载；OneBot 本机桥与聊天室 / 棋牌出站列为后续。ATRI `qq_callback` 为空，无桥可借。

---

## 8. 未授权私聊 + 群聊 pending（已落地）

| 角色 | 路径 |
| --- | --- |
| 发现桥 / OpenID 校验 / 事件摘要 | `src/qq/pending-discover.mjs` |
| 名单存储 + 本机 API | `src/channels/qq/pending.mjs`（`pending.test.mjs`） |
| 入站挂钩（denied 仍记录） | `src/channels/qq/runtime.mjs`（wrap `message.received` emit） |
| 宿主挂载 / 存盘钩子 | `src/channels/qq/index.mjs`、`src/index.mjs`（`/qq/pending`） |
| 设置页面板 + toast | `lib/client.js`：`buildQQPendingPanel` / `maybeToastQQPending` |

行为摘要：

1. **私聊**：C2C 发送者不在 `qqOwnerOpenId` + `qqAllowFrom` → 记 `users`；设置页 **授权** → 追加 `qqAllowFrom` 并刷新访问策略。**忽略 / 删除** 不改白名单。
2. **群聊**：`qqGroupPolicy` 为 `allowlist`（群不在 `qqGroupIds`）或 `disabled`（一律发现）时记 `groups`；**授权** → 追加 `qqGroupIds`，若策略原为 `disabled` 则改为 `allowlist`（不自动 `open`）。`open` 不发现。
3. 授权只经本机设置页（`localOnlyRefusal`）；**无**聊天指令写白名单。`qqAuthorizedIds`（电脑工具闸门）与私聊授权分离；所有者 OpenID 未填时授权返回 409。
4. **授权回放（2026-10-27）**：pending 记录 `lastText` / `lastMessageId` / `lastMentionedBot`；授权写入白名单并 `sync` 后，经 runtime `replayPending` 把触发消息再投进 harness（群默认 `mentionedBot: true`）。Telegram dm-pending **不**回放——此为 QQ 补齐「授权那条进 DSH」。回放失败不回滚白名单；`replayedAt` 防重复。

