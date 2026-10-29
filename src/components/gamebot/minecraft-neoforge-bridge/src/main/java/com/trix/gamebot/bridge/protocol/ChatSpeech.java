package com.trix.gamebot.bridge.protocol;

import java.util.regex.Pattern;

/** 聊天框一行：公聊或私聊，可选短动作文案。不触发任何世界动作。 */
public final class ChatSpeech {
    public static final int LINE_LIMIT = 256;
    public static final int EMOTE_LIMIT = 32;
    private static final Pattern TARGET = Pattern.compile("^[A-Za-z0-9_]{1,16}$");

    private ChatSpeech() {
    }

    public static final class Result {
        public final boolean ok;
        public final String errorCode;
        public final String error;
        public final String audience;
        public final String target;
        public final String emote;
        public final String text;

        private Result(boolean ok, String errorCode, String error, String audience, String target, String emote, String text) {
            this.ok = ok;
            this.errorCode = errorCode;
            this.error = error;
            this.audience = audience;
            this.target = target;
            this.emote = emote;
            this.text = text;
        }

        static Result problem(String code, String message) {
            return new Result(false, code, message, "public", "", "", "");
        }

        static Result ready(String audience, String target, String emote, String text) {
            return new Result(true, null, null, audience, target, emote, text);
        }
    }

    public static Result prepare(String message, String audience, String target, String emote) {
        String text = message == null ? "" : message.trim();
        if (text.isEmpty()) {
            return Result.problem("invalid_params", "message is empty");
        }
        String mode = audience == null || audience.isBlank() ? "public" : audience.trim();
        if (!"public".equals(mode) && !"private".equals(mode)) {
            return Result.problem("invalid_params", "audience must be public or private");
        }
        String who = target == null ? "" : target.trim();
        if ("private".equals(mode)) {
            if (who.isEmpty()) {
                return Result.problem("invalid_params", "private say requires target");
            }
            if (!TARGET.matcher(who).matches()) {
                return Result.problem("invalid_params", "target is not a player name");
            }
        } else {
            who = "";
        }
        String action = emote == null ? "" : emote.trim();
        if (action.length() > EMOTE_LIMIT || action.indexOf('\n') >= 0 || action.indexOf('\r') >= 0 || action.indexOf('*') >= 0) {
            return Result.problem("invalid_params", "emote must be a short line without asterisks");
        }
        return Result.ready(mode, who, action, text);
    }

    /** 聊天框展示。整行截断到 256，动作文案只出现在这一行里。 */
    public static String line(String name, Result speech) {
        String who = name == null ? "" : name;
        String raw = speech.emote.isEmpty()
                ? "<" + who + "> " + speech.text
                : "<" + who + "> *" + speech.emote + "* " + speech.text;
        return raw.length() > LINE_LIMIT ? raw.substring(0, LINE_LIMIT) : raw;
    }
}
