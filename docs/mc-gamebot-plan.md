# Minecraft GameBot 计划与功能清单

按 2026-10-25 代码盘点与 **P0 验收**：公聊、私聊、动作文案、座位控制会话、档案选择和发言镜像已接到代码。单元/回执测已过；游戏内手测仍未做（本机 GameBot/MC 未起）。

参考：`docs/mc-chatroom-separation.md`、`docs/minecraft-multi-ai-plan.md`、`D:\play\preset-registry-design.md`

## 原则

**边界：** 聊天室管社交轮次；Minecraft 管座位管道与游戏内控制环。GameBot 对多 AI 座位保持管道（不重开 body LLM）。控制环走每座位独立 DSH 会话（方案 B），与心跳 / `end_round` 解耦。

游戏内发言进 Minecraft 聊天框；可公可私；可带动作。空闲满 15 秒对连接中的座位自动唤醒一次。档案用共享 AI 档案库，不在 MC 设置里再抄一套人设与密钥。

## 功能清单

| 能力 | 状态 | 说明 |
|------|------|------|
| 公聊 say → 游戏聊天框 | 已落地 | `mc_act` say 等到服务端回执后才算成功；游戏内手测仍是 UNVERIFIED |
| 座位是否在 MC / last_error 写入提示 | 已落地 | `seatMcPresence`；聊天室轮次不驱动世界说明已写 |
| 座位管道 mc_connect / observe / act / status | 已落地 | GameBot 成员会话 LLM 关闭，只做管道 |
| 重进世界幽灵座位愈合 | 已落地 | ensure/spawn 清幽灵；`/minaret agent heal`（需新 runClient） |
| 共享聊天不污染 agent_mismatch | 已落地 | `minaret.py`；未提交 |
| AI 档案库（preset registry v2） | 已落地 | MC 行只存 `profileId`；控制会话用 `resolveProfile` |
| MC 绑定聊天室 / 自动补成员 | 已落地 | 公聊确认成功后按消息身份镜像一次；私聊不进房间 |
| NPC↔玩家私聊（进聊天框） | 已落地 · P0 验收 | `audience=private` + `target`；离线 `target_offline`，不广播。单测通过；游戏内 UNVERIFIED |
| 发言可带动作/表情 | 已落地 · P0 验收 | `emote` 只拼进聊天框那一行（见下方格式）。单测通过 |
| 空闲 15 秒自动唤醒一次 | 已落地 | 外部新事件才重新计时；唤醒轮自己的观察和发言不计 |
| 游戏内轮次与聊天室分离 | 已落地 | 每座位工作台控制会话；寻路落地前程序只许 say |
| 游戏内发言镜像到绑定聊天室 | 已落地 | 按消息身份去重；路人冷却；私聊不镜像；不打开 `MC_CHAT_FORWARD` |
| 档案选择器接到座位 / MC agents | 已落地 | 出厂模板复制成个人档案后再选 |

## P0 聊天框格式与调用

聊天框一行（整行截断 256；`emote` ≤32、无 `*`/换行）：

- 无动作：`<NPC名> 文本`
- 有动作：`<NPC名> *动作* 文本`（例：`<Steve> *waves* hello`）

Agent / 控制会话调用（经 `mc_act` 或控制工具 `say`，params 同形）：

| 意图 | params |
|------|--------|
| 公聊 | `{ "text": "hello" }` 或加 `audience: "public"` |
| 公聊+动作 | `{ "text": "hello", "emote": "waves" }` |
| 私聊 | `{ "text": "psst", "audience": "private", "target": "Alex" }` |
| 私聊+动作 | `{ "text": "psst", "audience": "private", "target": "Alex", "emote": "nods" }` |

`mc_act`：`{ action: "say", params: { ... } }`。须等服务端 `chat_result`；未回执不算成功。私聊目标离线 → `ok=false`, `error_code=target_offline`。

栈：Java `ChatSpeech` + `ServerLifecycle.handleChat` → Python `validate_say` / `MinaretBackend.send_say` → GameBot `mc_act` / `mc-control` `say`。

## 分阶段计划

1. **P0 · 聊天通道补齐** — Java/Python/`mc_act`：公聊保持；加私聊（目标玩家）；发言可选动作字段，仍进聊天框。
2. **P1 · 独立游戏内唤醒** — 每座位 DSH 控制会话；连接且空闲 ≥15s 唤醒一次；观察→决策→act；不碰聊天室 heartbeat。
3. **P2 · 档案接到座位** — MC agents / 座位选 `profileId`；出厂模板→个人档案；与中转站共用或分档。
4. **P3 · 可选镜像与体验** — 游戏发言镜像到绑定聊天室；路人冷却；重连后自动连座位（进世界自动连接固定为开）。

### 阶段勾选（截至 2026-10-25 P0 验收）

- [x] P0 私聊 + 公聊 + 动作进聊天框（单测/回执 PASS；游戏内手测 UNVERIFIED；需装含 ChatSpeech 的新 jar）
- [x] P1 15 秒空闲唤醒 + 独立控制会话（只许 say，直到寻路与占格落地）
- [x] P2 AI 档案接到 MC 行；控制会话用 `resolveProfile`
- [x] P3 发言镜像与进世界自动连接重连（固定为开）
- [x] 公聊 say + 座位 presence 提示（已有）
- [x] 幽灵座位愈合 + mismatch 修复（未提交）

## 验收要点

- **P0：** 玩家与 NPC 私聊、公聊均出现在游戏聊天框，且可带动作文案。**(2026-10-25) 代码与单测达标；游戏内待手测。**
- **P1：** 座位连上后静置 15 秒自动醒一次。寻路与占格落地前，这一轮只能 say。聊天室 `end_round` / 心跳不碰这个计时。
- **P2：** 座位能选档案且换模型生效。

## 游戏内 / API 手测步骤（P0）

1. 装入新打的 `minaret-1.1.0.jar`（须含 `ChatSpeech.class`），`runClient` 进世界，NPC 已 spawn。
2. 启动 GameBot，座位 `mc_connect`。
3. 公聊：`POST /v1/minecraft/members/{id}/actions` body `{"action":"say","params":{"text":"hello","emote":"waves"}}` → 聊天框见 `<NPC> *waves* hello`，回执 `ok=true`。
4. 私聊：params `{"text":"hi","audience":"private","target":"<你的玩家名>"}` → 仅该玩家聊天框可见；他人不应看到。
5. 目标离线/错名：应 `ok=false`, `error_code=target_offline` 或 `invalid_params`，且不广播。
