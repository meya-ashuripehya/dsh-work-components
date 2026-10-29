package com.trix.gamebot.bridge.protocol;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChatSpeechTest {
    @Test
    void publicLineKeepsNameAndOptionalEmote() {
        ChatSpeech.Result plain = ChatSpeech.prepare("hello", null, null, null);
        assertTrue(plain.ok);
        assertEquals("public", plain.audience);
        assertEquals("<Steve> hello", ChatSpeech.line("Steve", plain));

        ChatSpeech.Result emote = ChatSpeech.prepare("hello", "public", "", "waves");
        assertEquals("<Steve> *waves* hello", ChatSpeech.line("Steve", emote));
    }

    @Test
    void privateRequiresAPlayerNameAndDoesNotDefaultToBroadcast() {
        ChatSpeech.Result missing = ChatSpeech.prepare("hello", "private", " ", null);
        assertFalse(missing.ok);
        assertEquals("invalid_params", missing.errorCode);

        ChatSpeech.Result bad = ChatSpeech.prepare("hello", "private", "Steve!", null);
        assertFalse(bad.ok);

        ChatSpeech.Result ready = ChatSpeech.prepare("hello", "private", "Alex", "nods");
        assertTrue(ready.ok);
        assertEquals("private", ready.audience);
        assertEquals("Alex", ready.target);
        assertEquals("<Bot> *nods* hello", ChatSpeech.line("Bot", ready));
    }

    @Test
    void rejectsUnknownAudienceAndLongEmote() {
        assertEquals("invalid_params", ChatSpeech.prepare("hello", "team", null, null).errorCode);
        assertEquals("invalid_params", ChatSpeech.prepare("hello", "public", null, "a".repeat(33)).errorCode);
        assertEquals("invalid_params", ChatSpeech.prepare("hello", "public", null, "wave*").errorCode);
        assertEquals("invalid_params", ChatSpeech.prepare("   ", "public", null, null).errorCode);
    }

    @Test
    void clipsTheWholeChatLine() {
        ChatSpeech.Result speech = ChatSpeech.prepare("m".repeat(300), "public", null, "waves");
        String line = ChatSpeech.line("Steve", speech);
        assertEquals(ChatSpeech.LINE_LIMIT, line.length());
        assertTrue(line.startsWith("<Steve> *waves* "));
    }
}
