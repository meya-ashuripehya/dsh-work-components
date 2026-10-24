# Minaret NeoForge 桥

Minecraft 1.21.1 / NeoForge 21.1.228。模组版本 1.1.0。默认在单机或当前客户端开启的局域网世界里，为每个聊天室成员生成一只服务端 NPC。Python 通过 `ws://127.0.0.1:8765` 观察它、给它寻路和下达动作。NPC 不占用玩家角色，也不依赖窗口焦点。协议见 `docs/minaret-v1.md` 的 v2 一节。

加入未安装本模组的他人服务器时，不能生成 NPC。若仍要控制当前玩家，把 `config/minaret-common.toml` 的 `legacyClientBridge` 设为 `true`，桥会回到原来的客户端路径。

## 构建

最省事的方式：在 DSH 设置「工作组件 › 游戏 › Minecraft」填好 `mods 目录`，点「打包下载并安装 Minaret 模组」。插件会把这份源码复制到数据目录、用本机 Gradle 构建，再把 jar 放进 mods（旧版先备份）。需要已装 JDK 并能联网。

手工构建需要 Java 21。

```powershell
cd minecraft-neoforge-bridge
.\gradlew.bat build
```

产物是 `build/libs/minaret-1.1.0.jar`。工作台的「打包下载」会把它复制到数据目录的 `minaret/dist`，再放进你填写的 mods 目录。本里程碑的自动验证只构建到临时数据目录，不写入正在使用的 mods。改完代码后需要重启游戏才会加载新模组。

单元测试里的协议样例读取 `../protocol/minaret/fixtures/`，所以测试要在插件目录里跑（`src/components/gamebot/minecraft-neoforge-bridge`）。

## 配置

进入世界后会写出两份配置：

- `config/minaret-common.toml`：NPC 模式。`enabled`、`port`、`authUser`、`authPass`、`allowCommands`、`scanRadius`、`maxAgents`（默认 8）、`legacyClientBridge`。`maxActionsPerSecond` 按每个 NPC 计算。
- `config/minaret-client.toml`：只在 `legacyClientBridge=true` 时使用。

监听地址固定是 `127.0.0.1`，端口默认 `8765`。`allowCommands` 默认 `false`。

## 游戏内命令

需要作弊或 OP。

- `/minaret agent spawn <agent_id> [名字]`：为这个成员 id 生成 NPC。id 是小写字母、数字、连字符，最长 32。已有同一 id 时不会再生成一只。
- `/minaret agent list`：列出成员 NPC 和尚未绑定的旧 NPC。
- `/minaret agent status [agent_id]`：查看名字、位置、生命和当前任务。
- `/minaret agent remove <agent_id>`：移除这一只。未加载区块里的旧实体会在加载时消失。
- `/minaret agent adopt <agent_id>`：把升级前那个未绑定的旧 NPC 交给这个成员。绑定前谁都不能控制它。删掉它要先 adopt，再 remove。

聊天室里每个已启用成员用自己的 `mc_connect` 连接。`MC_MEMBER_IDS` 留空表示全部已启用席位。遗留的 `default-minecraft` 会话和 `gamebot_*` MCP 不能控制这些 NPC。

## 手工验收

1. 用带有农夫乐事和本模组的客户端进入自己的存档，玩家正常移动。
2. 若存档里已经有 1.0.0 的旧 NPC，先 `/minaret agent list`，再用 `/minaret agent adopt <成员 id>` 绑定。不要指望它自动属于某个成员。
3. 启用 GameBot · Minecraft。五个已启用席位各自调用 `mc_connect`（或让卡片启动后的 reconcile 去连）。应看到五只实体，hello 的 `agent_id` 分别是成员 id，`entity_uuid` 才是实体 UUID。
4. 让不同成员同时 `look_at` 或 `move_to`。互不影响。其中一个成员断开，只失败他自己的挂起动作。游戏窗口不必在前台。
5. 对派或盛宴执行 `interact`。证据里应有 `bites` 或 `servings` 的前后值。
6. 对没有适配器的方块，结果必须是 `unsupported_adapter`。
7. 退出重进后，同一个 NPC 还在；再次 spawn 会被拒绝，直到 remove。

8. 施工动作：把方块物品放进快捷栏，对相邻有支撑的空位 `place_block`，应得到 `effect=confirmed`；再对同一位置重发，应为 `observed` + `already_present`；对已有其他方块的位置应为 `position_occupied`。`break_block` 传错 `expected_block` 应为 `state_mismatch` 且世界不变。（这一步需要进游戏手工验证，单元测试只覆盖参数校验。）

## 故障排查

- Python 报连接被拒绝：确认已经进入自己的世界，且 common 配置 `enabled` 为 true。NPC 模式在世界启动后才监听。
- `client_not_ready` / server npc is not spawned：还没有执行 spawn，或 NPC 已死亡。先看 `/minaret agent status`。
- `unsupported_adapter`：这个方块没有适配器。容器查找用 `find_item`，不要指望普通快照带出容器内容。
- legacy 和 NPC 同时抢 8765：确认 `legacyClientBridge` 为 false，并重启游戏。
