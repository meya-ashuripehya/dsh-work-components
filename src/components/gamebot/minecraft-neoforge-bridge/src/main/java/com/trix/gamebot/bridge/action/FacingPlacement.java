package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.core.Direction;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.BlockHitResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Explore bounded vanilla placement contexts; match only requested partial state properties. */
public final class FacingPlacement {
    private static final int MAX_CONTEXT_TRIES = 24;

    private FacingPlacement() {
    }

    public static OrientedPlaceContext choose(Level level, Block block, ItemStack stack, BlockHitResult hit, JsonObject requested) {
        List<OrientedPlaceContext> contexts = enumerateContexts(level, stack, hit);
        for (OrientedPlaceContext ctx : contexts) {
            BlockState predicted = block.getStateForPlacement(ctx);
            if (predicted != null && partialMatches(predicted, requested)) {
                return ctx;
            }
        }
        return null;
    }

    /** Legacy helper for tests that pass a fully specified desired state. */
    public static OrientedPlaceContext choose(Level level, Block block, ItemStack stack, BlockHitResult hit, BlockState desired) {
        JsonObject requested = new JsonObject();
        if (desired != null) {
            for (Property<?> property : desired.getProperties()) {
                requested.addProperty(property.getName(), valueName(desired, property));
            }
        }
        return choose(level, block, stack, hit, requested);
    }

    public static boolean partialMatches(BlockState actual, JsonObject requested) {
        if (actual == null || requested == null) {
            return false;
        }
        for (Map.Entry<String, com.google.gson.JsonElement> entry : requested.entrySet()) {
            Property<?> property = actual.getBlock().getStateDefinition().getProperty(entry.getKey());
            if (property == null) {
                return false;
            }
            String want = entry.getValue().getAsString().toLowerCase(Locale.ROOT);
            if (!valueName(actual, property).equals(want)) {
                return false;
            }
        }
        return true;
    }

    public static boolean matches(BlockState actual, BlockState desired) {
        if (actual == null || desired == null || actual.getBlock() != desired.getBlock()) {
            return false;
        }
        for (Property<?> property : desired.getProperties()) {
            if (!same(actual, desired, property)) {
                return false;
            }
        }
        return true;
    }

    private static List<OrientedPlaceContext> enumerateContexts(Level level, ItemStack stack, BlockHitResult hit) {
        List<OrientedPlaceContext> out = new ArrayList<>();
        Direction clicked = hit.getDirection();
        if (clicked == Direction.UP || clicked == Direction.DOWN) {
            out.add(OrientedPlaceContext.vertical(level, stack, hit, clicked));
            for (Direction horizontal : Direction.Plane.HORIZONTAL) {
                if (out.size() >= MAX_CONTEXT_TRIES) {
                    break;
                }
                out.add(OrientedPlaceContext.horizontal(level, stack, hit, horizontal));
            }
        } else {
            for (Direction horizontal : Direction.Plane.HORIZONTAL) {
                if (out.size() >= MAX_CONTEXT_TRIES) {
                    break;
                }
                out.add(OrientedPlaceContext.horizontal(level, stack, hit, horizontal));
            }
            out.add(OrientedPlaceContext.vertical(level, stack, hit, Direction.UP));
            out.add(OrientedPlaceContext.vertical(level, stack, hit, Direction.DOWN));
        }
        return out;
    }

    private static <T extends Comparable<T>> boolean same(BlockState actual, BlockState desired, Property<T> property) {
        return actual.getValue(property).equals(desired.getValue(property));
    }

    private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> property) {
        return property.getName(state.getValue(property));
    }
}
