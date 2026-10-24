package com.trix.gamebot.bridge.transport;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/** Basic Auth。比较的是哈希，日志不得记录密码或 Authorization。 */
public final class Auth {
    private Auth() {
    }

    public static boolean authorize(String expectedUser, String expectedPass, String authorizationHeader) {
        if (expectedPass == null || expectedPass.isEmpty()) {
            return true;
        }
        String actual = decode(authorizationHeader);
        String expected = (expectedUser == null ? "" : expectedUser) + ":" + expectedPass;
        return MessageDigest.isEqual(sha256(actual), sha256(expected));
    }

    private static String decode(String header) {
        if (header == null) {
            return "";
        }
        String value = header.trim();
        if (value.regionMatches(true, 0, "Basic ", 0, 6)) {
            value = value.substring(6).trim();
        }
        try {
            byte[] decoded = Base64.getDecoder().decode(value);
            return new String(decoded, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new byte[32];
        }
    }
}
