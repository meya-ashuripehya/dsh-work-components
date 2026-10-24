package com.trix.gamebot.bridge;

import com.trix.gamebot.bridge.config.BridgeConfig;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.entity.ModEntities;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.config.ModConfig;
import net.neoforged.fml.loading.FMLEnvironment;

/**
 * 通用入口。实体、命令和服务端桥在集成服与专用服都注册。
 * 客户端渲染和 legacy LocalPlayer 桥只在客户端分发时加载。
 */
@Mod(MinaretMod.MOD_ID)
public final class MinaretMod {
    public static final String MOD_ID = "minaret";

    public MinaretMod(IEventBus modBus, ModContainer container) {
        ModEntities.register(modBus);
        modBus.addListener(ModEntities::onAttributes);
        container.registerConfig(ModConfig.Type.COMMON, CommonBridgeConfig.SPEC);
        if (FMLEnvironment.dist != Dist.CLIENT) {
            return;
        }
        container.registerConfig(ModConfig.Type.CLIENT, BridgeConfig.SPEC);
        try {
            Class.forName("com.trix.gamebot.bridge.client.ClientLifecycle");
            Class<?> agentClient = Class.forName("com.trix.gamebot.bridge.client.AgentClient");
            agentClient.getMethod("register", IEventBus.class).invoke(null, modBus);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("Minaret client bridge is missing", e);
        }
    }
}
