package com.trix.gamebot.bridge.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.trix.gamebot.bridge.MinaretMod;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.entity.AgentRecord;
import com.trix.gamebot.bridge.entity.AgentRegistry;
import com.trix.gamebot.bridge.entity.AgentTable;
import com.trix.gamebot.bridge.entity.ModEntities;
import com.trix.gamebot.bridge.protocol.AgentMessages;
import com.trix.gamebot.bridge.server.ServerLifecycle;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 成员 NPC 的生成、查询和认领。旧的单 NPC 不会自动分给任何成员。 */
@EventBusSubscriber(modid = MinaretMod.MOD_ID)
public final class AgentCommands {
    private static final Logger LOGGER = LoggerFactory.getLogger(AgentCommands.class);

    private AgentCommands() {
    }

    @SubscribeEvent
    public static void onRegisterCommands(RegisterCommandsEvent event) {
        register(event.getDispatcher());
    }

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("minaret")
                .requires(source -> source.hasPermission(2))
                .then(Commands.literal("agent")
                        .then(Commands.literal("spawn")
                                .then(Commands.argument("agent_id", StringArgumentType.word())
                                        .executes(context -> spawn(
                                                context.getSource(),
                                                StringArgumentType.getString(context, "agent_id"),
                                                ""
                                        ))
                                        .then(Commands.argument("name", StringArgumentType.string())
                                                .executes(context -> spawn(
                                                        context.getSource(),
                                                        StringArgumentType.getString(context, "agent_id"),
                                                        StringArgumentType.getString(context, "name")
                                                )))))
                        .then(Commands.literal("list").executes(context -> list(context.getSource())))
                        .then(Commands.literal("remove")
                                .then(Commands.argument("agent_id", StringArgumentType.word())
                                        .executes(context -> remove(
                                                context.getSource(),
                                                StringArgumentType.getString(context, "agent_id")
                                        ))))
                        .then(Commands.literal("heal")
                                .executes(context -> healAll(context.getSource()))
                                .then(Commands.argument("agent_id", StringArgumentType.word())
                                        .executes(context -> healOne(
                                                context.getSource(),
                                                StringArgumentType.getString(context, "agent_id")
                                        ))))
                        .then(Commands.literal("status")
                                .executes(context -> list(context.getSource()))
                                .then(Commands.argument("agent_id", StringArgumentType.word())
                                        .executes(context -> status(
                                                context.getSource(),
                                                StringArgumentType.getString(context, "agent_id")
                                        ))))
                        .then(Commands.literal("adopt")
                                .then(Commands.argument("agent_id", StringArgumentType.word())
                                        .executes(context -> adopt(
                                                context.getSource(),
                                                StringArgumentType.getString(context, "agent_id")
                                        ))))));
    }

    public static AgentEntity find(MinecraftServer server, String agentId) {
        if (server == null || !AgentMessages.validAgentId(agentId)) {
            return null;
        }
        return resolve(server, AgentRegistry.get(server).find(agentId));
    }

    /**
     * 保证这个成员有一只可用的 NPC。
     * 已有实体（含先强制加载上次坐标所在区块）→ 直接复用。
     * 只有存档记录、实体确实不在 → 清掉幽灵记录并在原位（或出生点）补一只。
     * 没有任何记录 → 在主世界出生点创建。
     */
    public static String ensure(MinecraftServer server, String agentId, String displayName) {
        if (!AgentMessages.validAgentId(agentId)) {
            return "invalid";
        }
        AgentRegistry registry = AgentRegistry.get(server);
        AgentRecord record = registry.find(agentId);
        if (record != null) {
            if (resolve(server, record) != null) {
                return null;
            }
            return respawnMissing(server, agentId, displayName, record);
        }
        ServerLevel level = server.overworld();
        BlockPos spawn = level.getSharedSpawnPos();
        int index = registry.size();
        return create(
                server,
                level,
                agentId,
                displayName,
                spawn.getX() + 0.5 + index * 2.0,
                spawn.getY(),
                spawn.getZ() + 0.5,
                0.0F
        );
    }

    public static String requireReady(MinecraftServer server, String agentId) {
        return find(server, agentId) == null ? "agent_not_available" : null;
    }

    private static int spawn(CommandSourceStack source, String agentId, String requestedName) {
        if (!AgentMessages.validAgentId(agentId)) {
            source.sendFailure(Component.literal("成员编码不合法"));
            return 0;
        }
        AgentRegistry registry = AgentRegistry.get(source.getServer());
        AgentRecord existing = registry.find(agentId);
        if (existing != null) {
            if (resolve(source.getServer(), existing) != null) {
                source.sendFailure(Component.literal("成员 " + agentId + " 已经有 NPC"));
                return 0;
            }
            clearGhost(source.getServer(), agentId, existing);
            source.sendSuccess(() -> Component.literal("已清除成员 " + agentId + " 的幽灵记录，正在重新生成"), false);
        }
        ServerLevel level = source.getLevel();
        Vec3 pos = source.getPosition();
        String error = create(source.getServer(), level, agentId, requestedName, pos.x, pos.y, pos.z, source.getRotation().y);
        if (error != null) {
            source.sendFailure(Component.literal(failureText(agentId, error)));
            return 0;
        }
        AgentEntity agent = find(source.getServer(), agentId);
        source.sendSuccess(() -> Component.literal("已生成成员 " + agentId + " 的 NPC " + (agent == null ? "" : agent.getUUID())), true);
        ServerLifecycle.refreshHello(agentId);
        return 1;
    }

    private static int list(CommandSourceStack source) {
        AgentRegistry registry = AgentRegistry.get(source.getServer());
        if (registry.size() == 0 && registry.legacy() == null) {
            source.sendSuccess(() -> Component.literal("没有 NPC"), false);
            return 1;
        }
        for (AgentRecord record : registry.table().records()) {
            AgentEntity agent = resolve(source.getServer(), record);
            String state = agent == null ? "not_loaded" : "active";
            source.sendSuccess(() -> Component.literal(describe(record, state)), false);
        }
        AgentRecord legacy = registry.legacy();
        if (legacy != null) {
            source.sendSuccess(() -> Component.literal(describe(legacy, "legacy_unbound")), false);
        }
        return 1;
    }

    private static int status(CommandSourceStack source, String agentId) {
        AgentRecord record = AgentRegistry.get(source.getServer()).find(agentId);
        if (record == null) {
            source.sendFailure(Component.literal("没有成员 " + agentId + " 的 NPC"));
            return 0;
        }
        AgentEntity agent = find(source.getServer(), agentId);
        source.sendSuccess(() -> Component.literal(describe(record, agent == null ? "not_loaded" : "active")), false);
        return 1;
    }

    private static int remove(CommandSourceStack source, String agentId) {
        AgentRegistry registry = AgentRegistry.get(source.getServer());
        AgentRecord record = registry.find(agentId);
        if (record == null) {
            source.sendFailure(Component.literal("没有成员 " + agentId + " 的 NPC"));
            return 0;
        }
        AgentEntity agent = resolve(source.getServer(), record);
        if (agent != null) {
            agent.discard();
        }
        registry.remove(agentId);
        ServerLifecycle.forget(agentId);
        source.sendSuccess(() -> Component.literal("已移除成员 " + agentId + " 的 NPC"), true);
        return 1;
    }

    private static int healOne(CommandSourceStack source, String agentId) {
        if (!AgentMessages.validAgentId(agentId)) {
            source.sendFailure(Component.literal("成员编码不合法"));
            return 0;
        }
        String error = ensure(source.getServer(), agentId, "");
        if (error != null) {
            source.sendFailure(Component.literal(failureText(agentId, error)));
            return 0;
        }
        AgentEntity agent = find(source.getServer(), agentId);
        source.sendSuccess(() -> Component.literal("成员 " + agentId + " 的 NPC 已就绪 " + (agent == null ? "" : agent.getUUID())), true);
        ServerLifecycle.refreshHello(agentId);
        return 1;
    }

    private static int healAll(CommandSourceStack source) {
        AgentRegistry registry = AgentRegistry.get(source.getServer());
        int healed = 0;
        int ready = 0;
        int failed = 0;
        List<AgentRecord> records = new ArrayList<>(registry.table().records());
        for (AgentRecord record : records) {
            String agentId = record.agentKey();
            if (!AgentMessages.validAgentId(agentId)) {
                continue;
            }
            if (resolve(source.getServer(), record) != null) {
                ready += 1;
                continue;
            }
            String error = ensure(source.getServer(), agentId, record.name());
            if (error == null) {
                healed += 1;
                ServerLifecycle.refreshHello(agentId);
            } else {
                failed += 1;
            }
        }
        int finalHealed = healed;
        int finalReady = ready;
        int finalFailed = failed;
        source.sendSuccess(() -> Component.literal(
                "已修复幽灵 " + finalHealed + "，原本在场 " + finalReady + "，失败 " + finalFailed
        ), true);
        return finalHealed + finalReady;
    }

    private static int adopt(CommandSourceStack source, String agentId) {
        if (!AgentMessages.validAgentId(agentId)) {
            source.sendFailure(Component.literal("成员编码不合法"));
            return 0;
        }
        String error = AgentRegistry.get(source.getServer()).adoptLegacy(agentId);
        if (error != null) {
            source.sendFailure(Component.literal(failureText(agentId, error)));
            return 0;
        }
        AgentEntity agent = find(source.getServer(), agentId);
        if (agent != null) {
            agent.setMemberId(agentId);
        }
        source.sendSuccess(() -> Component.literal("已把旧 NPC 绑定给成员 " + agentId), true);
        ServerLifecycle.refreshHello(agentId);
        return 1;
    }

    public static String create(MinecraftServer server, ServerLevel level, String agentId, String displayName, double x, double y, double z, float yaw) {
        if (!AgentMessages.validAgentId(agentId)) {
            return "invalid";
        }
        if (level == null) {
            return "agent_not_available";
        }
        String name = sanitize(displayName, agentId);
        AgentEntity agent = ModEntities.AGENT.get().create(level);
        if (agent == null) {
            return "internal_error";
        }
        agent.moveTo(x, y, z, yaw, 0.0F);
        agent.setAgentName(name);
        agent.setMemberId(agentId);
        String error = AgentRegistry.get(server).assign(
                agentId,
                agent.getUUID(),
                name,
                level.dimension().location().toString(),
                maxAgents()
        );
        if (error != null) {
            return error;
        }
        if (!level.addFreshEntity(agent)) {
            AgentRegistry.get(server).remove(agentId);
            return "internal_error";
        }
        return null;
    }

    /**
     * 查找实体。若当前未加载但有上次坐标，先强制加载该区块再查一次，避免把未加载当成幽灵。
     */
    private static AgentEntity resolve(MinecraftServer server, AgentRecord record) {
        if (record == null || !record.occupied() || record.dimension().isEmpty() || record.legacyUnbound()) {
            return null;
        }
        ServerLevel level = levelOf(server, record.dimension());
        if (level == null) {
            return null;
        }
        UUID uuid;
        try {
            uuid = UUID.fromString(record.id());
        } catch (IllegalArgumentException e) {
            return null;
        }
        AgentEntity live = asLiveAgent(level.getEntity(uuid));
        if (live != null) {
            return live;
        }
        if (record.hasPosition()) {
            forceLoadChunk(level, record.x(), record.z());
            live = asLiveAgent(level.getEntity(uuid));
            if (live != null) {
                return live;
            }
        }
        return null;
    }

    private static String respawnMissing(MinecraftServer server, String agentId, String displayName, AgentRecord record) {
        String fallbackName = record.name().isEmpty() ? agentId : record.name();
        String name = sanitize(displayName, fallbackName);
        ServerLevel level = levelOf(server, record.dimension());
        double x;
        double y;
        double z;
        if (level != null && record.hasPosition()) {
            x = record.x();
            y = record.y();
            z = record.z();
        } else {
            level = server.overworld();
            BlockPos spawn = level.getSharedSpawnPos();
            int index = AgentRegistry.get(server).size();
            x = spawn.getX() + 0.5 + index * 2.0;
            y = spawn.getY();
            z = spawn.getZ() + 0.5;
        }
        clearGhost(server, agentId, record);
        LOGGER.info("Cleared stale Minaret seat for {} and provisioning a new NPC body", agentId);
        return create(server, level, agentId, name, x, y, z, 0.0F);
    }

    private static void clearGhost(MinecraftServer server, String agentId, AgentRecord record) {
        AgentRegistry registry = AgentRegistry.get(server);
        if (record != null && record.occupied()) {
            ServerLevel level = levelOf(server, record.dimension());
            if (level != null) {
                try {
                    Entity entity = level.getEntity(UUID.fromString(record.id()));
                    if (entity instanceof AgentEntity agent) {
                        agent.discard();
                    }
                } catch (IllegalArgumentException ignored) {
                    // bad uuid in stale record
                }
            }
        }
        registry.remove(agentId);
        ServerLifecycle.forget(agentId);
    }

    private static ServerLevel levelOf(MinecraftServer server, String dimension) {
        ResourceLocation dimensionId = ResourceLocation.tryParse(dimension);
        if (dimensionId == null) {
            return null;
        }
        for (ServerLevel candidate : server.getAllLevels()) {
            if (candidate.dimension().location().equals(dimensionId)) {
                return candidate;
            }
        }
        return null;
    }

    private static void forceLoadChunk(ServerLevel level, double x, double z) {
        // Server-thread getChunkAt forces the chunk to FULL so getEntity can see persisted NPCs.
        level.getChunkAt(BlockPos.containing(x, 0, z));
    }

    private static AgentEntity asLiveAgent(Entity entity) {
        return entity instanceof AgentEntity agent && agent.isAlive() ? agent : null;
    }

    private static String describe(AgentRecord record, String state) {
        String who = record.agentKey().isEmpty() ? "(未绑定)" : record.agentKey();
        return who + " " + record.name() + " [" + state + "] " + record.dimension()
                + " " + Math.round(record.x()) + " " + Math.round(record.y()) + " " + Math.round(record.z())
                + " entity=" + record.id();
    }

    private static String failureText(String agentId, String error) {
        return switch (error) {
            case "already_exists" -> "成员 " + agentId + " 已经有 NPC";
            case "limit" -> "NPC 数量已达上限";
            case "no_legacy" -> "没有可认领的旧 NPC";
            case "invalid" -> "成员编码不合法";
            case "agent_not_available" -> "成员 " + agentId + " 的 NPC 不在世界里。可执行 /minaret agent heal " + agentId + "，或 /minaret agent remove " + agentId + " 后再连接";
            default -> "无法处理成员 " + agentId + " 的 NPC";
        };
    }

    private static String sanitize(String requested, String fallback) {
        String name = requested == null ? "" : requested.trim();
        if (name.isEmpty() || name.length() > 32 || name.indexOf('\n') >= 0 || name.indexOf('\r') >= 0) {
            name = fallback;
        }
        return name;
    }

    private static int maxAgents() {
        try {
            return CommonBridgeConfig.maxAgents();
        } catch (RuntimeException e) {
            return AgentTable.DEFAULT_MAX;
        }
    }
}
