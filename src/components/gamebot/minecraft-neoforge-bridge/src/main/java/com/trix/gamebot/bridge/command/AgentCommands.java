package com.trix.gamebot.bridge.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
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

import java.util.UUID;

/** 成员 NPC 的生成、查询和认领。旧的单 NPC 不会自动分给任何成员。 */
public final class AgentCommands {
    private AgentCommands() {
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

    /** 已有记录但实体不在世界里时不补生成。没有记录时在主世界出生点创建一个。 */
    public static String ensure(MinecraftServer server, String agentId, String displayName) {
        if (!AgentMessages.validAgentId(agentId)) {
            return "invalid";
        }
        AgentRegistry registry = AgentRegistry.get(server);
        AgentRecord record = registry.find(agentId);
        if (record != null) {
            return resolve(server, record) == null ? "agent_not_available" : null;
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
        if (AgentRegistry.get(source.getServer()).find(agentId) != null) {
            source.sendFailure(Component.literal("成员 " + agentId + " 已经有 NPC"));
            return 0;
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
            source.sendSuccess(() -> Component.literal(describe(record, "active")), false);
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

    private static AgentEntity resolve(MinecraftServer server, AgentRecord record) {
        if (record == null || !record.occupied() || record.dimension().isEmpty() || record.legacyUnbound()) {
            return null;
        }
        ResourceLocation dimensionId = ResourceLocation.tryParse(record.dimension());
        if (dimensionId == null) {
            return null;
        }
        ServerLevel level = null;
        for (ServerLevel candidate : server.getAllLevels()) {
            if (candidate.dimension().location().equals(dimensionId)) {
                level = candidate;
                break;
            }
        }
        if (level == null) {
            return null;
        }
        try {
            Entity entity = level.getEntity(UUID.fromString(record.id()));
            return entity instanceof AgentEntity agent && agent.isAlive() ? agent : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
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
            case "agent_not_available" -> "成员 " + agentId + " 的 NPC 不在世界里，不会自动再生成一个。先 /minaret agent remove " + agentId + " 再重新连接";
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
