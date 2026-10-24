package com.trix.gamebot.bridge.entity;

import com.trix.gamebot.bridge.MinaretMod;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.entity.EntityAttributeCreationEvent;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModEntities {
    public static final DeferredRegister<EntityType<?>> ENTITIES = DeferredRegister.create(Registries.ENTITY_TYPE, MinaretMod.MOD_ID);
    public static final DeferredHolder<EntityType<?>, EntityType<AgentEntity>> AGENT = ENTITIES.register("agent", () ->
            EntityType.Builder.of(AgentEntity::new, MobCategory.CREATURE)
                    .sized(0.6F, 1.8F)
                    .clientTrackingRange(10)
                    .updateInterval(1)
                    .build("minaret:agent")
    );

    private ModEntities() {
    }

    public static void register(IEventBus modBus) {
        ENTITIES.register(modBus);
    }

    public static void onAttributes(EntityAttributeCreationEvent event) {
        event.put(AGENT.get(), AgentEntity.createAttributes().build());
    }
}
