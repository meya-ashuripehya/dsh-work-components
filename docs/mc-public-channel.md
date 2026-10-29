# MC 每席回复队列（成员决定）

- 日期：2026-10-27（Asia/Shanghai）
- 诉求：以成员为准——每席各自一条回复队列；历史上下文含公屏全部 + 本席私聊；公屏与私聊堆在同一通道里挨个处理。不再用全局公屏 round-robin。

## 相对首片（全局公屏通道）的变化

| 点 | 首片（已演进） | 现片 |
|---|---|---|
| 队列粒度 | 全局一轮，同一时刻只武装一位 | **每席一条队列**；不同席位可并行 |
| 入队范围 | 仅玩家公聊 | 玩家公聊入**每个**已连接席；私聊只入**相关席** |
| 回合焦点 | 隐式（观察里什么都有） | 系统提示写明 **队首**（audience / 发言者 / 正文） |
| AI 公聊 | 不 fan-out note | 仍不 fan-out；也不入队 |
| `disarmAllExcept` | 武装公屏队首时清掉别人 | **不再使用**（本席 busy/deadline 即可串行） |

## 行为

1. **入队**：`createSeatQueues()`  
   - 玩家公聊（`bystander` + public）：`enqueuePublic` → 每个 connected 席位各一份（按 event id 去重）。  
   - 私聊（`audience=private`）：只 `enqueuePrivate` 到当前 observe 所在席；跳过本席自己的 say 回声。  
   - AI 公聊回声：跳过。
2. **武装**：席位空闲（非 busy、无 active）时 `activateNext` + `control.note(..., { delayMs })`。玩家/私聊入队默认 `delayMs: 0`；连接空闲唤醒仍用 `IDLE_MS`；队内下一条 `delayMs: 0`。
3. **回合**：`runTurn` 读 `seatQueues.active(memberId)` 写入 `controlSystemPrompt(..., focus)`。观察 JSON 仍可含公屏全文与本席私聊作上下文，但可执行焦点是队首。
4. **收尾**：回合结束后 `finish` 丢掉队首；若还有 pending，立刻 `note(..., { delayMs: 0 })`。
5. **连接 one-shot**：`connect` 仍 `note(connect:gen)`，**不**建队列项（无 focus）。若回合中已入队，结束后 `tryArmSeat(..., 0)`。与队列并存，文档选择：保持接近今日行为。
6. **聊天室 `onSay`**：仍只镜像，不 fan-out 武装。

## 改动文件

- `src/components/gamebot/mc-public-channel.mjs`（`createSeatQueues`；去掉全局 round 模型）
- `src/components/gamebot/mc-control.mjs`（`controlSystemPrompt` 增加 focus / 队首说明）
- `src/components/gamebot/mc-host.mjs`（每席入队 / tryArm / finish；poll 私聊入队）
- `src/components/gamebot/mc-mirror.mjs`（`classifyChat` 透传 `target`；玩家可带 private）
- `src/components/gamebot/mc-phases.test.mjs`
- `docs/mc-public-channel.md`（本文）

备份：`.bak-mc-per-seat-queue-20261027-024914/`。未 commit。

## 故意推迟

- 聊天室级 `end_round` / 预算 / 交棒
- 玩家→NPC 私聊若 Minaret 尚未扇入 observe：队列已接好，等协议事件带 `audience=private` 即可
- 改 Minaret fan-out 本身（观察仍可见全员公聊；只改唤醒调度）
- 连接 one-shot 改成带 `connect` focus 标签
- 提交 / 推送