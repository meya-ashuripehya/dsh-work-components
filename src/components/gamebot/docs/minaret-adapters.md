# Minaret 适配器

服务端 NPC 不是玩家。需要 `Player` 的模组交互必须写适配器。没有适配器时，动作结果是 `unsupported_adapter`，不会假装成功。

## 注册

实现 `com.trix.gamebot.bridge.compat.api.AgentInteractionAdapter`，在 NeoForge 游戏事件总线上监听 `RegisterAgentAdaptersEvent`：

```java
@EventBusSubscriber(modid = "yourmod")
public final class YourRegistrar {
    @SubscribeEvent
    public static void register(RegisterAgentAdaptersEvent event) {
        event.register(new YourAdapter());
    }
}
```

适配器提供 `id`、`requiredMod`、`priority`、`supports` 和 `execute`。`requiredMod` 未加载时不会调用 `supports`，因此不要在类加载阶段引用那个模组的类。优先级数字大的先执行。同优先级按 id 排序。

内置适配器：

| id | 模组 | 优先级 | 行为 |
|---|---|---|---|
| `vanilla` | 无 | 0 | 把选中的快捷栏物品放入 `IItemHandler` 容器 |
| `farmersdelight` | `farmersdelight` | 100 | 食用带 `bites` 的派和带 `servings` 的盛宴 |

派会增加 `bites`，盛宴会减少 `servings`。到达属性边界时方块被移除。份数变化写进动作证据。

农夫乐事规则参考车万女仆的 `FarmersDelightEdible`（Copyright 2019-2025 tartaric_acid，TouhouLittleMaid，MIT License）。这里只使用方块 ID 和方块状态属性，不复制其资源，也不依赖 `EntityMaid`。

## 边界

- 只支持当前客户端自己打开的单机世界，以及这个客户端开的局域网。两者都有集成服务端。
- 加入未安装 Minaret 的他人服务器时，不能生成或控制 NPC。把 `config/minaret-common.toml` 的 `legacyClientBridge` 设为 `true` 后，仍可控制本机玩家。
- 专用服务器以后可以装同一份模组，但不在这一版的验收范围。
- 一个存档可以有多个 NPC，每个成员 id 一个。命令是 `/minaret agent spawn <agent_id> [名字]`、`list`、`status [agent_id]`、`remove <agent_id>`、`adopt <agent_id>`。需要作弊权限。旧的单个 NPC 先 `adopt` 再 `remove`；`legacy` 本身是合法 id，没有单独的 remove legacy 子命令。hello 带 `provision: true` 时也会幂等生成。重进世界不会为同一条记录再生成一只。
- 寻路使用 `PathNavigation`，不强制加载远处区块。按 Esc 暂停单机时，NPC 随集成服务端一起暂停。
