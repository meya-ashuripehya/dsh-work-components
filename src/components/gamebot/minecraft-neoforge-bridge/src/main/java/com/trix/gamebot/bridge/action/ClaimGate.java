package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** 改世界前核对认领凭证。密钥只留在这条连接的内存里。 */
public final class ClaimGate {
    public static final class Denial {
        public final String code;
        public final String message;

        public Denial(String code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    private static final ConcurrentHashMap<String, byte[]> KEYS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Integer> FLOORS = new ConcurrentHashMap<>();

    private ClaimGate() {
    }

    public static boolean changesWorld(String action) {
        return switch (action == null ? "" : action) {
            case "place_block", "break_block", "attack_block", "use_item_on_block" -> true;
            default -> false;
        };
    }

    public static void remember(String agentId, long generation, byte[] key) {
        String slot = slot(agentId, generation);
        if (key == null || key.length == 0) {
            KEYS.remove(slot);
            return;
        }
        KEYS.put(slot, key.clone());
    }

    public static void forget(String agentId, long generation) {
        KEYS.remove(slot(agentId, generation));
    }

    public static Denial check(String agentId, long generation, String action, JsonObject params, JsonObject claim, long nowMs) {
        int floor = 0;
        String pid = text(claim, "pid");
        String tid = text(claim, "tid");
        if (pid != null && tid != null) {
            floor = FLOORS.getOrDefault(floorKey(pid, tid), 0);
        }
        return check(agentId, action, params, claim, KEYS.get(slot(agentId, generation)), nowMs, floor);
    }

    public static String noteRevoke(String agentId, long generation, String pid, String tid, int gen, String sig) {
        return noteRevoke(KEYS.get(slot(agentId, generation)), pid, tid, gen, sig, FLOORS);
    }

    public static Denial check(String agentId, String action, JsonObject params, JsonObject claim, byte[] key, long nowMs, int generationFloor) {
        if (!changesWorld(action)) {
            return null;
        }
        if (key == null || key.length == 0) {
            return new Denial("claim_invalid", "claim key is missing");
        }
        if (claim == null) {
            return new Denial("claim_invalid", "claim is missing");
        }
        String canonical;
        try {
            canonical = canonical(claim);
        } catch (RuntimeException e) {
            return new Denial("claim_invalid", "claim is incomplete");
        }
        String expected = hmac(key, canonical);
        String sig = text(claim, "sig");
        if (sig == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), sig.toLowerCase().getBytes(StandardCharsets.US_ASCII))) {
            return new Denial("claim_invalid", "claim signature does not match");
        }
        if (!agentId.equals(text(claim, "mid"))) {
            return new Denial("claim_invalid", "seat does not match");
        }
        long exp = claim.get("exp").getAsLong();
        if (nowMs / 1000 >= exp) {
            return new Denial("claim_invalid", "claim expired");
        }
        int gen = claim.get("gen").getAsInt();
        if (gen <= generationFloor) {
            return new Denial("claim_invalid", "claim generation is spent");
        }
        String category = category(action);
        if (!acts(claim).contains(category)) {
            return new Denial("claim_invalid", "claim does not allow this action");
        }
        int[] pos = posOf(params);
        if (pos == null || !cells(claim).contains(pos[0] + "," + pos[1] + "," + pos[2])) {
            return new Denial("claim_invalid", "cell is not in the claim");
        }
        return null;
    }

    public static String noteRevoke(byte[] key, String pid, String tid, int gen, String sig, Map<String, Integer> floors) {
        if (key == null || key.length == 0) {
            return "claim key is missing";
        }
        if (pid == null || tid == null || sig == null || gen <= 0) {
            return "revoke is incomplete";
        }
        String expected = hmac(key, "revoke|" + pid + "|" + tid + "|" + gen);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), sig.toLowerCase().getBytes(StandardCharsets.US_ASCII))) {
            return "revoke signature does not match";
        }
        floors.merge(floorKey(pid, tid), gen, Math::max);
        return null;
    }

    static String canonical(JsonObject claim) {
        List<String> lines = new ArrayList<>();
        for (String cell : cells(claim)) {
            lines.add(cell);
        }
        lines.sort(Comparator.naturalOrder());
        List<String> act = new ArrayList<>(acts(claim));
        act.sort(Comparator.naturalOrder());
        return String.join("|",
                "v1",
                text(claim, "mid"),
                text(claim, "tid"),
                text(claim, "pid"),
                Long.toString(claim.get("bv").getAsLong()),
                Long.toString(claim.get("gen").getAsLong()),
                Long.toString(claim.get("exp").getAsLong()),
                String.join(",", act),
                sha256(String.join("\n", lines))
        );
    }

    private static String category(String action) {
        return switch (action) {
            case "place_block" -> "place";
            case "break_block", "attack_block" -> "break";
            case "use_item_on_block" -> "use";
            default -> "";
        };
    }

    private static List<String> acts(JsonObject claim) {
        List<String> act = new ArrayList<>();
        JsonArray values = claim.getAsJsonArray("act");
        for (JsonElement value : values) {
            act.add(value.getAsString());
        }
        return act;
    }

    private static List<String> cells(JsonObject claim) {
        List<String> cells = new ArrayList<>();
        JsonArray values = claim.getAsJsonArray("cells");
        for (JsonElement value : values) {
            JsonObject pos = value.getAsJsonObject();
            cells.add(pos.get("x").getAsInt() + "," + pos.get("y").getAsInt() + "," + pos.get("z").getAsInt());
        }
        return cells;
    }

    private static int[] posOf(JsonObject params) {
        if (params == null || !params.has("pos") || !params.get("pos").isJsonObject()) {
            return null;
        }
        JsonObject pos = params.getAsJsonObject("pos");
        return new int[] { pos.get("x").getAsInt(), pos.get("y").getAsInt(), pos.get("z").getAsInt() };
    }

    private static String text(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static String slot(String agentId, long generation) {
        return agentId + "\0" + generation;
    }

    private static String floorKey(String pid, String tid) {
        return pid + "\0" + tid;
    }

    private static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return hex(digest.digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("sha256");
        }
    }

    private static String hmac(byte[] key, String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return hex(mac.doFinal(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("hmac");
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            out.append(Character.forDigit((value >> 4) & 0xF, 16));
            out.append(Character.forDigit(value & 0xF, 16));
        }
        return out.toString();
    }
}
