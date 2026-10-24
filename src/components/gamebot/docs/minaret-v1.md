# Minaret WebSocket v1

插件内置 GameBot 与 NeoForge 1.21.1 Minaret 模组的共同协议。样例在 `protocol/minaret/fixtures/`，结构约束在 `protocol/minaret/minaret-v1.schema.json`。

## 传输

- 仅绑定 `127.0.0.1`，默认端口 `8765`。
- 文本 JSON，单条最大 1 MiB。
- 可选 HTTP Basic 认证。日志不得记录密码或 `Authorization`。
- 每侧各自维护从 0 开始的 `sequence`。`request_id` 只用于动作请求、结果和取消。

信封字段：

| 字段 | 规则 |
|---|---|
| `protocol_version` | 遗留客户端桥为 `1`。服务端 NPC 桥为 `2`（见下方 v2） |
| `event` | `hello`、`snapshot`、`action_request`、`action_result`、`player_activity`、`chat`、`error`、`cancel_action` |
| `sequence` | 本连接发送方单调递增的非负整数 |
| `timestamp_ms` | UTC Unix 毫秒 |
| `data` | 事件对象。未知字段可忽略 |

## 标识与坐标

- 方块、物品、实体、维度使用小写 `namespace:path`。禁止传输数字注册表 ID。
- 方块坐标是整数。实体坐标是有限浮点数。
- `face` 为 `down|up|north|south|west|east`。`hand` 为 `main_hand|off_hand`。
- `hit_offset` 是方块内 `[0,1]` 局部坐标，缺省为目标面中心。
- 空数组用 `[]`，未知单值用 `null`。

## 动作

NPC 模式的 hello/snapshot 带 `actor_type=server_npc` 和 `agent_id`。`screen` 固定为关闭。legacy 客户端模式不带这些字段，仍控制当前玩家。

动作：`look_at`、`move_to`、`select_item`、`use_item_on_block`、`attack_block`、`break_block`、`place_block`、`attack_entity`、`drop_item`、`use_item`、`find_item`。`interact` 是不指定物品的 `use_item_on_block`。`move_to` 和 `attack_entity` 只在服务端 NPC 上执行；legacy 客户端会返回 `unsupported`。

`find_item` 只在被调用时按 `item_id` 搜索附近容器，返回持有该物品的容器坐标、数量和槽位。普通快照不带容器内容。命中列表只进入下一次决策的 `item_search`，之后不再重复附带。半径默认跟扫描半径，可传 `radius`（1–16）。NPC 与单机房主读服务端容器；legacy 连到远程服务器时只能读客户端已经同步的容器。

没有适配器能处理的方块返回 `unsupported_adapter`，证据里有 `block_id` 和 `reason`。

### 施工动作：`place_block` 与 `break_block`

默认服务端 NPC 模式下 `use_item_on_block` 只走适配器（比如往容器里放物品），不会放方块，所以施工用下面两个动作。两者都只在服务端 NPC 上执行，hello 的 `capabilities` 里带 `minecraft.world.place_block` / `minecraft.world.break_block` 才可用。

`place_block` 参数：

- `pos`（必填，整数坐标）：要放方块的位置。
- `block_id`（必填，`namespace:path`）：要放的方块。对应的方块物品必须在快捷栏 0–8 里；只在背包其余槽位返回 `unsupported`，完全没有返回 `item_not_found`。
- `face`（可选）：指定从哪一侧的相邻方块上点击放置；缺省按 下、北、南、西、东、上 找第一个已加载且非空气、不可替换的相邻方块，找不到返回 `action_rejected`。
- `state`（可选，字符串字典，键值都是小写 `[a-z0-9_]+`，最多 16 项）：放完后读回核对，不一致时直接写入，并在证据 `state_adjusted` 里标 `true`、`effect` 为 `unverified`（写入后仍对不上时）或 `confirmed`。
- `max_distance`（默认 4.5，上限 6）：到支撑方块的可触及距离，同样检查视线。

目标位置已经是同一方块（且 `state` 一致）时幂等成功，`effect=observed`，证据 `already_present:true`。目标位置有其他实体方块返回 `position_occupied`，证据里有 `actual_block`；空气、水、草等可替换方块可以直接放。

`break_block` 参数同 `attack_block`，另加必填 `expected_block`。目标位置的方块与 `expected_block` 不一致时不改世界，返回 `state_mismatch`，证据里有 `expected_block` 和 `actual_block`；一致时走与 `attack_block` 相同的挖掘流程（30 秒超时）。

`action_request.data` 可带可选的 `claim` 对象（上限 1 KiB）。第一版模组只把它原样放进 `action_result.evidence.claim` 回显，不做校验；签发与核对在协调进程一侧。

`select_item` 与 `drop_item` 只接受快捷栏槽位 0–8。背包其余槽位返回 `unsupported`，不会静默搬运。`use_item.mode` 为 `once` 或 `until_finished`。普通动作 5 秒超时，`move_to`、挖掘和持续使用 30 秒。待处理动作最多 32 个，每秒最多 10 个。

`action_result.ok` 只表示流程完成。`effect` 为 `confirmed|observed|unverified|failed`。

稳定错误码：`invalid_params`、`not_connected`、`client_not_ready`、`item_not_found`、`block_unloaded`、`out_of_reach`、`line_of_sight_blocked`、`unsupported`、`unsupported_adapter`、`rate_limited`、`timeout`、`action_rejected`、`position_occupied`、`state_mismatch`、`internal_error`。

## 其他玩家

客户端直接发送 `player_swing` 和 `block_changed`。只有挥手后 500 毫秒内、6 格内、且视线与方块中心夹角足够接近时，才追加 `possible_block_interaction`。该事件必须有 `inferred:true`、`confidence` 和 `evidence`。置信度公式为：

`dot(normalize(look), normalize(block_center - swing_pos)) * (1 - dt/500) * (1 - distance/6)`

方块中心是 `(x+0.5, y+0.5, z+0.5)`。附带样例（挥手在原点看向 +X，50 毫秒后 `(4,64,0)` 变化）的置信度是 `0.214`。

结果按三位小数四舍五入。无法关联时不猜测玩家。

## 兼容

一个版本周期内，模组继续接受旧消息：`{"event":"hello","user"}`、`{"message","user"}`、`{"command"}`。没有 `MC_AGENT_ID` 的 Python 连接仍发送带顶层 `user` 的 v1 hello。v1 只用于 `legacyClientBridge=true` 的客户端玩家桥。服务端 NPC 桥不接受 v1 hello。

## v2：一个成员一个 NPC

服务端 NPC 桥说 `protocol_version: 2`。`agent_id` 是聊天室成员 id，不是实体 UUID。实体 UUID 在 `entity_uuid`。

hello 必须带 `data.agent_id`（`^[a-z0-9][a-z0-9-]{0,31}$`）。可以带 `provision: true` 和 `display_name`。模组在服务器线程上幂等补出这个 NPC，数量受 `maxAgents` 限制（默认 8，最大 32）。缺 `agent_id` 时返回 `agent_id_required` 并关闭连接。v1 客户端连到服务端 NPC 桥时返回 `unsupported`，并说明要改用 v2。

绑定之后，`action_request`、`cancel_action` 和可选的 `message` / `command` 都作用在这条连接的 NPC 上。消息里如果再带 `agent_id`，必须和绑定一致，否则只向来源连接回 `agent_mismatch`，不关闭连接。还没绑定就发动作，返回 `not_bound`。记录在但实体没加载或已死亡时，hello 返回 `agent_not_available`，不会再生成一个新实体；恢复方式是 `/minaret agent remove <agent_id>` 之后重新 hello。同一个成员同时只保留一个长动作（`move_to`、`attack_block`、`break_block`、`use_item` 的 `until_finished`），其余长动作返回 `busy`。短动作仍可进行。限流和 32 个挂起上限按成员计算，另外有 128 的全局安全上限。

连接有代际。同一成员重连会关掉旧连接（关闭码 `4000`，原因 `replaced`），并只失败旧代际的挂起动作。别的成员不受影响。出站队列每条连接 64 条，满了先丢 `snapshot` 和 `player_activity`。一个成员的结果不会写到另一个成员的连接上。

旧存档里的单个 `minaret_agent` 不会自动绑到任何成员。它加载为 `legacy_unbound`：实体保留，但没有任何连接能控制它。管理员执行 `/minaret agent adopt <agent_id>` 之后才绑定。新记录写在 `minaret_agents`，旧文件不动。

`default-minecraft` 和遗留 MCP `gamebot_*` 没有成员归属，不能控制 v2 NPC。通用 `/v1/sessions` 不能创建、修改或删除 `minecraft-<member>` 会话，也不能写入 `MC_AGENT_ID` / `MC_MEMBER_MANAGED`。

v2 新增错误码：`agent_id_required`、`agent_mismatch`、`agent_not_available`、`not_bound`、`busy`。样例：`hello-v2.json`、`action-request-v2.json`、`error-agent-mismatch-v2.json`。
