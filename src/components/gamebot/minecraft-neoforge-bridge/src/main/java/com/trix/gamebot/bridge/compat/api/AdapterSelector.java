package com.trix.gamebot.bridge.compat.api;

import java.util.List;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.ToIntFunction;

/** 已加载且声明支持该动作的适配器里，优先级高的胜出。同优先级按 id 稳定排序。 */
public final class AdapterSelector {
    private AdapterSelector() {
    }

    public static <T> T select(
            List<T> adapters,
            Predicate<T> available,
            ToIntFunction<T> priority,
            Predicate<T> supports,
            Function<T, String> id
    ) {
        T best = null;
        int bestPriority = Integer.MIN_VALUE;
        String bestId = null;
        for (T adapter : adapters) {
            if (!available.test(adapter) || !supports.test(adapter)) {
                continue;
            }
            int value = priority.applyAsInt(adapter);
            String name = id.apply(adapter);
            if (best == null || value > bestPriority || (value == bestPriority && name.compareTo(bestId) < 0)) {
                best = adapter;
                bestPriority = value;
                bestId = name;
            }
        }
        return best;
    }
}
