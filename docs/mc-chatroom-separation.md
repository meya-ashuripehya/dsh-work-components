# 聊天室与 Minecraft 控制环分离

- 日期：2026-10-25
- 状态：首片已落地（席位 MC 状态注入提示词）；**控制环驱动方已定 B（见 .cursor/plans/mc_gamebot_phases_65a71f08.plan.md），未施工**
- 背景诉求：「聊天室里的成员无法得知自己是否在 MC 里，游戏内轮次应该和聊天室分离」

## 1 现状（映射）

- **聊天室回合**：`moderator` / `heartbeat` / `end_round` 唤醒成员 → DSH provider 回合 → 工具集（含 `mc_*`，仅当 `gamebot-minecraftEnabled`）。
- **GameBot 成员会话**：`minecraft-<member_id>`；`LLM_ENABLED=0` / `CHAT_ENABLED=0` — **无自有大脑**，只提供连接与 `mc_connect|observe|act|cancel|status|disconnect`。
- **身份**：`caller.memberId` 来自聊天室席位；`MC_MEMBER_TOOLS` 在 tool-gate 中始终放行（若已注册）；工具挂载仍受 `gamebot-minecraftEnabled` 控制。
- **缺口**：成员必须猜自己是否有 NPC / 是否已连上；NPC 在线不会在 `end_round` + heartbeat 关闭后唤醒任何人；游戏内 observe→decide→act **没有**独立于聊天室的控制环。
- **未动**：ghost-seat / agent_mismatch 既有补丁；聊天室 heartbeat / `end_round` 语义未改。

## 2 已落地首片（可验）

当 `gamebot-minecraftEnabled === true` 时，成员系统提示注入英文 MC 席位事实行（eligible / connected|connecting|not connected / last_error / 工具名），并一句说明「聊天室回合不驱动世界」。

| 路径 | 作用 |
|---|---|
| `src/components/gamebot/members.mjs` | `seatMcPresence`、`createMcPresenceResolver`（短 TTL 缓存，软失败） |
| `src/chatroom/transcript.mjs` | `roomRules` / `buildPrompt` 接受 `mcInfo` |
| `src/chatroom/moderator.mjs` | `resolveMcInfo(seat)` |
| `src/chatroom/index.mjs` | 透传 `options.resolveMcInfo` |
| `src/index.mjs` | 接上 `createMcPresenceResolver({ getConfig: () => current })` |

备份：`.bak-mc-presence-20261025-074800/`。未 commit / 未 push。

## 3 控制环驱动方：选项（已定 B，见 phases 计划）

### A. GameBot host seat tick

在 body 侧为每个已连接 `minecraft-<id>` 恢复轻量 tick（或事件驱动），由 GameBot 调 LLM 再 `act`。

- 优点：与聊天室进程完全解耦；NPC 事件可就地响应。
- 缺点：成员会话刻意关了 LLM；要再接 DSH provider/persona，否则双脑；与「GameBot 只做管道」现状冲突。

### B. 每席 DSH MC 控制会话（推荐默认）

工作台为每个已连接席位维持独立于聊天室的 **MC 控制会话**（同一 seat provider / persona，独立 transcript，工具集以 `mc_*` 为主）。GameBot 仍只做连接与观察；观察结果或定时 tick 唤醒该会话做 observe→decide→act。

- 优点：复用现有 DSH session/provider；人格一致；聊天室 heartbeat / `end_round` 可保持纯社交；语义最干净。
- 缺点：要新增会话类型与生命周期（连上起、断开停）。

### C. 聊天室旁路 MC tick

在聊天室进程内加一条与 heartbeat / `end_round` **隔离**的 MC ticker：仅唤醒 MC 名册席位，任务标记为私有 MC tick，默认不刷公屏。

- 优点：改动面最小，立刻能用现有 `mc_*` 与 moderator。
- 缺点：仍挂在聊天室进程；门禁稍松就容易污染社交回合；长期仍像「聊天室在开游戏」。

**推荐：B。** 首片（状态进提示词）不依赖 B/C，可先用；选 B 后再做「连上即 tick」的第二片。若你更想最快可玩，可先落 C 作过渡，再迁 B。

## 4 明确未做（等决定）

- 任何独立 MC 控制环 / 自动 tick / 事件唤醒。
- 改 heartbeat、`end_round`、GameBot `LLM_ENABLED`。
- 提交或推送。

## 5 如何验证首片

1. 设置打开 **GameBot · Minecraft**（`gamebot-minecraftEnabled`），席位在 Minecraft AI 名册内。
2. 重启 / 重载工作台后，在绑定聊天室里 @ 该成员说一句闲聊。
3. 看该回合 system 提示（或成员是否能说出自己是否在 MC / 是否已连接），应含 `Minecraft seat: … Status: …`。
4. 关闭 Minecraft 开关后，提示中不应再出现 Minecraft 行；普通 `end_round` / heartbeat 行为不变。
5. 单测：`node --test src/components/gamebot/members.test.mjs src/chatroom/mc-presence.test.mjs`
