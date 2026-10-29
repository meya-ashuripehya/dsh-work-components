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

## 隔离客户端与诊断

游戏内行为仍是 **UNVERIFIED**。下面这条运行配置只使用模块目录里的 `run/`，不读取个人存档。世界名用 `no-garlic`，需要在这个 `run/saves` 里自行创建或选择；本仓库没有代为启动游戏。

```powershell
cd src/components/gamebot/minecraft-neoforge-bridge
.\gradlew.bat runClient
```

`runClient` 只给这个进程加上 `-Dminaret.diagnostics=true`。不带该 JVM 属性时没有这些日志。其它启动方式要看同样的日志，就自行加上 `-Dminaret.diagnostics=true`。

打开后，每个状态一行，用 `agent_id`、`generation`、`request_id` 串起来，且不会按 tick 重复：

- `accepted`：账本接受了这次请求
- `stop_requested`：第一次要求导航停止
- `stop_complete`：第一次观察到导航已经停稳
- `released`：pending 和账本都通过代际校验并成功摘掉之后
- `send_attempt`：准备调用结果发送接口；不证明入队成功或对端已经收到
- `footprint`：门或床放置后的实际两格，以及状态读回是否通过

没有内部占格预留的登记或释放。门和床只在放置后读回脚印；改世界的动作另由外部 claim 校验目标格是否在声明的 `cells` 里。

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
- `/minaret agent heal [agent_id]`：校验实体是否还在（必要时先加载上次坐标所在区块）。只剩幽灵记录时清掉并补生成；省略 id 则处理全部席位。GameBot `provision` / `mc_connect` 也会自动走同一套修复。
- `/minaret agent adopt <agent_id>`：把升级前那个未绑定的旧 NPC 交给这个成员。绑定前谁都不能控制它。删掉它要先 adopt，再 remove。

聊天室里每个已启用成员用自己的 `mc_connect` 连接。`MC_MEMBER_IDS` 留空表示全部已启用席位。遗留的 `default-minecraft` 会话和 `gamebot_*` MCP 不能控制这些 NPC。

## 手工验收

1. 用带有农夫乐事和本模组的客户端进入自己的存档，玩家正常移动。
2. 若存档里已经有 1.0.0 的旧 NPC，先 `/minaret agent list`，再用 `/minaret agent adopt <成员 id>` 绑定。不要指望它自动属于某个成员。
3. 启用 GameBot · Minecraft。五个已启用席位各自调用 `mc_connect`（或让卡片启动后的 reconcile 去连）。应看到五只实体，hello 的 `agent_id` 分别是成员 id，`entity_uuid` 才是实体 UUID。
4. 让不同成员同时 `look_at` 或 `move_to`。互不影响。其中一个成员断开，只失败他自己的挂起动作。游戏窗口不必在前台。
5. 对派或盛宴执行 `interact`。证据里应有 `bites` 或 `servings` 的前后值。
6. 对没有适配器的方块，结果必须是 `unsupported_adapter`。
7. 退出重进后，同一个 NPC 还在；实体在而再次 spawn 会被拒绝。若实体丢了只剩存档记录，`mc_connect` / `/minaret agent heal` 会清幽灵并补一只，不必先手动 remove。

8. 施工动作（**需隔离测试世界，本里程碑未在 CI 中跑通 NeoForge 集成**）：快捷栏放方块，`place_block` 近处应直接放置；远处或隔墙应自动 `move_to` 到位后再放一次。`auto_move=false` 保持原地放置。`state` 只约束列出属性；`hit_offset` 影响楼梯半砖等朝向。重复 request_id 查询已有结果，同 ID 不同参数拒绝。`break_block` 传错 `expected_block` 应为 `state_mismatch` 且世界不变。

### 自动化测试

在 `minecraft-neoforge-bridge` 目录：

```powershell
.\gradlew.bat test build
```

在 `src/components/gamebot` 目录：

```powershell
python -m pytest tests/test_minaret_wire.py tests/test_server_npc.py tests/test_minecraft_protocol.py -q
```

产物：`build/libs/minaret-1.1.0.jar`。

## 故障排查

- Python 报连接被拒绝：确认已经进入自己的世界，且 common 配置 `enabled` 为 true。NPC 模式在世界启动后才监听。
- `client_not_ready` / server npc is not spawned：还没有执行 spawn，或 NPC 已死亡。先看 `/minaret agent status`。
- `unsupported_adapter`：这个方块没有适配器。容器查找用 `find_item`，不要指望普通快照带出容器内容。
- legacy 和 NPC 同时抢 8765：确认 `legacyClientBridge` 为 false，并重启游戏。
