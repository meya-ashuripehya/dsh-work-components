package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Set;
import java.util.regex.Pattern;

/** 与 Python wire.validate_action_params 对齐的字段规则。 */
public final class Validators {
    public static final Set<String> FACES = Set.of("down", "up", "north", "south", "west", "east");
    public static final Set<String> HANDS = Set.of("main_hand", "off_hand");
    public static final Set<String> USE_MODES = Set.of("once", "until_finished");
    public static final Set<String> CORE_ACTIONS = Set.of(
            "look_at", "move_to", "interact", "select_item", "use_item_on_block", "attack_block", "attack_entity",
            "drop_item", "use_item", "find_item", "place_block", "probe_blocks", "break_block"
    );
    private static final Pattern STATE_KEY = Pattern.compile("^[a-z0-9_]+$");
    private static final Pattern STATE_VALUE = Pattern.compile("^[a-z0-9_]+$");
    private static final int MAX_STATE_PROPERTIES = 16;
    private static final java.util.regex.Pattern UUID_TEXT = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    );
    public static final double MAX_INTERACT_DISTANCE = 6.0;
    private static final Pattern RESOURCE_ID = Pattern.compile("^[a-z0-9_.-]+:[a-z0-9_./-]+$");

    private Validators() {
    }

    public static boolean isResourceId(String value) {
        return value != null && RESOURCE_ID.matcher(value).matches();
    }

    public static JsonObject validateAction(String action, JsonObject params) throws ProtocolException {
        JsonObject raw = params == null ? new JsonObject() : params;
        if (!CORE_ACTIONS.contains(action)) {
            throw new ProtocolException("unsupported", "action is not supported");
        }
        if ("look_at".equals(action) || "move_to".equals(action)) {
            JsonObject out = new JsonObject();
            out.addProperty("x", finite(raw.get("x"), "x"));
            out.addProperty("y", finite(raw.get("y"), "y"));
            out.addProperty("z", finite(raw.get("z"), "z"));
            if ("move_to".equals(action)) {
                if (raw.has("arrival_tolerance") && !raw.get("arrival_tolerance").isJsonNull()) {
                    double tolerance = finite(raw.get("arrival_tolerance"), "arrival_tolerance");
                    if (tolerance <= 0 || tolerance > 2.0) {
                        throw new ProtocolException("invalid_params", "arrival_tolerance must be within (0, 2]");
                    }
                    out.addProperty("arrival_tolerance", tolerance);
                }
                if (raw.has("exclusions") && !raw.get("exclusions").isJsonNull()) {
                    out.add("exclusions", raw.getAsJsonArray("exclusions"));
                }
            }
            return out;
        }
        if ("attack_entity".equals(action)) {
            JsonObject out = new JsonObject();
            if (raw.has("uuid") && !raw.get("uuid").isJsonNull()) {
                String uuid = raw.get("uuid").getAsString();
                if (!UUID_TEXT.matcher(uuid).matches()) {
                    throw new ProtocolException("invalid_params", "uuid is invalid");
                }
                out.addProperty("uuid", uuid);
            }
            return out;
        }
        if ("select_item".equals(action)) {
            return itemOrSlot(raw, "select_item", false);
        }
        if ("drop_item".equals(action)) {
            JsonObject out = itemOrSlot(raw, "drop_item", true);
            int count = 1;
            if (raw.has("count") && !raw.get("count").isJsonNull()) {
                count = integer(raw.get("count"), "count");
            }
            if (count <= 0) {
                throw new ProtocolException("invalid_params", "count must be positive");
            }
            out.addProperty("count", count);
            return out;
        }
        if ("find_item".equals(action)) {
            JsonObject out = new JsonObject();
            out.addProperty("item_id", resourceId(raw.get("item_id"), "item_id"));
            if (raw.has("radius") && !raw.get("radius").isJsonNull()) {
                int radius = integer(raw.get("radius"), "radius");
                if (radius < 1 || radius > 16) {
                    throw new ProtocolException("invalid_params", "radius must be from 1 to 16");
                }
                out.addProperty("radius", radius);
            }
            return out;
        }
        if ("use_item".equals(action)) {
            String mode = raw.has("mode") ? raw.get("mode").getAsString() : "once";
            if (!USE_MODES.contains(mode)) {
                throw new ProtocolException("invalid_params", "mode must be once or until_finished");
            }
            String hand = raw.has("hand") ? raw.get("hand").getAsString() : "main_hand";
            if (!HANDS.contains(hand)) {
                throw new ProtocolException("invalid_params", "hand is invalid");
            }
            JsonObject out = new JsonObject();
            out.addProperty("mode", mode);
            out.addProperty("hand", hand);
            if (raw.has("item_id") && !raw.get("item_id").isJsonNull()) {
                out.addProperty("item_id", resourceId(raw.get("item_id"), "item_id"));
            }
            return out;
        }
        if ("place_block".equals(action)) {
            return placeBlock(raw);
        }
        if ("probe_blocks".equals(action)) {
            return probeBlocks(raw);
        }
        JsonObject out = new JsonObject();
        out.add("pos", blockPos(raw.get("pos"), "pos"));
        String face = raw.has("face") && !raw.get("face").isJsonNull() ? raw.get("face").getAsString() : "up";
        if (!FACES.contains(face)) {
            throw new ProtocolException("invalid_params", "face is invalid");
        }
        out.addProperty("face", face);
        String hand = raw.has("hand") && !raw.get("hand").isJsonNull() ? raw.get("hand").getAsString() : "main_hand";
        if (!HANDS.contains(hand)) {
            throw new ProtocolException("invalid_params", "hand is invalid");
        }
        out.addProperty("hand", hand);
        if (!raw.has("hit_offset") || raw.get("hit_offset").isJsonNull()) {
            out.add("hit_offset", offsetObject(FacePoints.center(face)));
        } else {
            out.add("hit_offset", hitOffset(raw.get("hit_offset")));
        }
        boolean sneaking = raw.has("sneaking") && !raw.get("sneaking").isJsonNull() && raw.get("sneaking").getAsBoolean();
        out.addProperty("sneaking", sneaking);
        double maxDistance = raw.has("max_distance") ? finite(raw.get("max_distance"), "max_distance") : 4.5;
        if (maxDistance <= 0 || maxDistance > MAX_INTERACT_DISTANCE) {
            throw new ProtocolException("invalid_params", "max_distance must be within (0, 6]");
        }
        out.addProperty("max_distance", maxDistance);
        if (raw.has("item_id") && !raw.get("item_id").isJsonNull()) {
            out.addProperty("item_id", resourceId(raw.get("item_id"), "item_id"));
        }
        if ("break_block".equals(action)) {
            out.addProperty("expected_block", resourceId(raw.get("expected_block"), "expected_block"));
        }
        return out;
    }

    /**
     * place_block：pos 是方块最终要在的位置；block_id 必须是快捷栏里某个方块物品对应的方块；
     * face 是从 pos 指向支撑方块的方向（缺省自动在相邻方块里找）；state 是要求的方块状态（字符串键值）。
     */
    private static JsonObject placeBlock(JsonObject raw) throws ProtocolException {
        JsonObject out = new JsonObject();
        out.add("pos", blockPos(raw.get("pos"), "pos"));
        out.addProperty("block_id", resourceId(raw.get("block_id"), "block_id"));
        if (raw.has("face") && !raw.get("face").isJsonNull()) {
            String face = raw.get("face").isJsonPrimitive() ? raw.get("face").getAsString() : "";
            if (!FACES.contains(face)) {
                throw new ProtocolException("invalid_params", "face is invalid");
            }
            out.addProperty("face", face);
        }
        if (raw.has("state") && !raw.get("state").isJsonNull()) {
            if (!raw.get("state").isJsonObject()) {
                throw new ProtocolException("invalid_params", "state must be an object");
            }
            JsonObject state = raw.getAsJsonObject("state");
            if (state.size() > MAX_STATE_PROPERTIES) {
                throw new ProtocolException("invalid_params", "state has too many properties");
            }
            JsonObject cleaned = new JsonObject();
            for (var entry : state.entrySet()) {
                JsonElement value = entry.getValue();
                if (!STATE_KEY.matcher(entry.getKey()).matches() || value == null || !value.isJsonPrimitive()) {
                    throw new ProtocolException("invalid_params", "state properties must be lowercase names with scalar values");
                }
                String text = value.getAsString().toLowerCase(java.util.Locale.ROOT);
                if (!STATE_VALUE.matcher(text).matches()) {
                    throw new ProtocolException("invalid_params", "state values must be lowercase words");
                }
                cleaned.addProperty(entry.getKey(), text);
            }
            out.add("state", cleaned);
        }
        double maxDistance = raw.has("max_distance") ? finite(raw.get("max_distance"), "max_distance") : 4.5;
        if (maxDistance <= 0 || maxDistance > MAX_INTERACT_DISTANCE) {
            throw new ProtocolException("invalid_params", "max_distance must be within (0, 6]");
        }
        out.addProperty("max_distance", maxDistance);
        if (raw.has("auto_move") && !raw.get("auto_move").isJsonNull()) {
            out.addProperty("auto_move", raw.get("auto_move").getAsBoolean());
        }
        if (raw.has("hit_offset") && !raw.get("hit_offset").isJsonNull()) {
            out.add("hit_offset", hitOffset(raw.get("hit_offset")));
        }
        if (raw.has("exclusions") && !raw.get("exclusions").isJsonNull()) {
            out.add("exclusions", raw.getAsJsonArray("exclusions"));
        }
        return out;
    }

    /** Read-only cell probe. positions is 1..16 block coordinates. Does not change the world. */
    private static JsonObject probeBlocks(JsonObject raw) throws ProtocolException {
        if (!raw.has("positions") || !raw.get("positions").isJsonArray()) {
            throw new ProtocolException("invalid_params", "positions must be an array");
        }
        com.google.gson.JsonArray in = raw.getAsJsonArray("positions");
        if (in.isEmpty() || in.size() > 16) {
            throw new ProtocolException("invalid_params", "positions must contain 1 to 16 entries");
        }
        com.google.gson.JsonArray positions = new com.google.gson.JsonArray();
        for (com.google.gson.JsonElement element : in) {
            positions.add(blockPos(element, "positions"));
        }
        JsonObject out = new JsonObject();
        out.add("positions", positions);
        return out;
    }

    private static JsonObject itemOrSlot(JsonObject raw, String action, boolean drop) throws ProtocolException {
        boolean hasItem = raw.has("item_id") && !raw.get("item_id").isJsonNull();
        boolean hasSlot = raw.has("slot") && !raw.get("slot").isJsonNull();
        if (!hasItem && !hasSlot) {
            throw new ProtocolException("invalid_params", action + " requires item_id or slot");
        }
        JsonObject out = new JsonObject();
        if (hasItem) {
            out.addProperty("item_id", resourceId(raw.get("item_id"), "item_id"));
        }
        if (hasSlot) {
            int slot = integer(raw.get("slot"), "slot");
            if (slot < 0 || slot > 8) {
                String message = drop
                        ? "only hotbar slots 0-8 can be dropped in this version"
                        : "only hotbar slots 0-8 can be selected";
                throw new ProtocolException("unsupported", message);
            }
            out.addProperty("slot", slot);
        }
        return out;
    }

    public static String resourceId(JsonElement value, String field) throws ProtocolException {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString() || !isResourceId(value.getAsString())) {
            throw new ProtocolException("invalid_params", field + " must be a lowercase namespace:path id");
        }
        return value.getAsString();
    }

    public static double finite(JsonElement value, String field) throws ProtocolException {
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException("invalid_params", field + " must be a finite number");
        }
        double number = value.getAsDouble();
        if (!Double.isFinite(number)) {
            throw new ProtocolException("invalid_params", field + " must be a finite number");
        }
        return number;
    }

    public static int integer(JsonElement value, String field) throws ProtocolException {
        if (value == null || value.isJsonNull()) {
            throw new ProtocolException("invalid_params", field + " must be an integer");
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException("invalid_params", field + " must be an integer");
        }
        double number = value.getAsDouble();
        if (!Double.isFinite(number) || number != Math.rint(number)) {
            throw new ProtocolException("invalid_params", field + " must be an integer");
        }
        return (int) number;
    }

    public static JsonObject blockPos(JsonElement value, String field) throws ProtocolException {
        if (value == null || !value.isJsonObject()) {
            throw new ProtocolException("invalid_params", field + " must be an object");
        }
        JsonObject pos = value.getAsJsonObject();
        JsonObject out = new JsonObject();
        out.addProperty("x", integer(pos.get("x"), field + ".x"));
        out.addProperty("y", integer(pos.get("y"), field + ".y"));
        out.addProperty("z", integer(pos.get("z"), field + ".z"));
        return out;
    }

    public static JsonObject hitOffset(JsonElement value) throws ProtocolException {
        if (value == null || !value.isJsonObject()) {
            throw new ProtocolException("invalid_params", "hit_offset must be an object");
        }
        JsonObject raw = value.getAsJsonObject();
        JsonObject out = new JsonObject();
        for (String axis : new String[]{"x", "y", "z"}) {
            double number = finite(raw.get(axis), "hit_offset." + axis);
            if (number < 0 || number > 1) {
                throw new ProtocolException("invalid_params", "hit_offset." + axis + " must be between 0 and 1");
            }
            out.addProperty(axis, number);
        }
        return out;
    }

    private static JsonObject offsetObject(double[] center) {
        JsonObject out = new JsonObject();
        out.addProperty("x", center[0]);
        out.addProperty("y", center[1]);
        out.addProperty("z", center[2]);
        return out;
    }
}
