package com.trix.gamebot.bridge.config;

import net.neoforged.neoforge.common.ModConfigSpec;

/**
 * 客户端配置。监听地址固定为 127.0.0.1，没有局域网开关。
 */
public final class BridgeConfig {
    public static final ModConfigSpec SPEC;
    public static final ModConfigSpec.BooleanValue ENABLED;
    public static final ModConfigSpec.IntValue PORT;
    public static final ModConfigSpec.ConfigValue<String> AUTH_USER;
    public static final ModConfigSpec.ConfigValue<String> AUTH_PASS;
    public static final ModConfigSpec.BooleanValue ALLOW_COMMANDS;
    public static final ModConfigSpec.IntValue SCAN_RADIUS;
    public static final ModConfigSpec.IntValue MAX_ACTIONS_PER_SECOND;

    static {
        ModConfigSpec.Builder builder = new ModConfigSpec.Builder();
        ENABLED = builder.comment("Start the loopback WebSocket bridge.").define("enabled", true);
        PORT = builder.comment("Port bound on 127.0.0.1 only.").defineInRange("port", 8765, 1, 65535);
        AUTH_USER = builder.comment("Optional Basic Auth user. Empty disables authentication.").define("authUser", "");
        AUTH_PASS = builder.comment("Optional Basic Auth password. Never written to the game log by this mod.").define("authPass", "");
        ALLOW_COMMANDS = builder.comment("Advertise and accept run_command. Default off.").define("allowCommands", false);
        SCAN_RADIUS = builder.comment("Nearby block scan radius, in blocks.").defineInRange("scanRadius", 8, 1, 16);
        MAX_ACTIONS_PER_SECOND = builder.comment("Accepted action requests per connection per second.").defineInRange("maxActionsPerSecond", 10, 1, 20);
        SPEC = builder.build();
    }

    private BridgeConfig() {
    }

    public static boolean enabled() {
        return ENABLED.get();
    }

    public static int port() {
        return PORT.get();
    }

    public static String authUser() {
        return AUTH_USER.get() == null ? "" : AUTH_USER.get();
    }

    public static String authPass() {
        return AUTH_PASS.get() == null ? "" : AUTH_PASS.get();
    }

    public static boolean allowCommands() {
        return ALLOW_COMMANDS.get();
    }

    public static int scanRadius() {
        return SCAN_RADIUS.get();
    }

    public static int maxActionsPerSecond() {
        return MAX_ACTIONS_PER_SECOND.get();
    }
}
