package com.trix.gamebot.bridge.compat.farmersdelight;

/** 派增加 bites，盛宴减少 servings。到边界时移除方块。 */
public final class ServingMath {
    public record Change(boolean destroy, int next) {
    }

    private ServingMath() {
    }

    public static Change pie(int bites, int max) {
        if (bites >= max) {
            return new Change(true, bites);
        }
        return new Change(false, bites + 1);
    }

    public static Change feast(int servings, int min) {
        if (servings <= min) {
            return new Change(true, servings);
        }
        return new Change(false, servings - 1);
    }
}
