package com.trix.gamebot.bridge.client;

import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.entity.ModEntities;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.MobRenderer;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.client.event.EntityRenderersEvent;

/** 客户端只负责把服务端 NPC 画出来，不读取屏幕，也不注入键鼠。 */
public final class AgentClient {
    private AgentClient() {
    }

    public static void register(IEventBus modBus) {
        modBus.addListener(AgentClient::registerRenderers);
    }

    private static void registerRenderers(EntityRenderersEvent.RegisterRenderers event) {
        event.registerEntityRenderer(ModEntities.AGENT.get(), AgentRenderer::new);
    }

    public static final class AgentRenderer extends MobRenderer<AgentEntity, PlayerModel<AgentEntity>> {
        private static final ResourceLocation STEVE = ResourceLocation.withDefaultNamespace("textures/entity/player/wide/steve.png");

        public AgentRenderer(EntityRendererProvider.Context context) {
            super(context, new PlayerModel<>(context.bakeLayer(ModelLayers.PLAYER), false), 0.5F);
        }

        @Override
        public ResourceLocation getTextureLocation(AgentEntity entity) {
            return STEVE;
        }
    }
}
