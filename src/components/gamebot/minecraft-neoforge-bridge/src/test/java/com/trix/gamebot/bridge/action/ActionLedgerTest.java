package com.trix.gamebot.bridge.action;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ActionLedgerTest {
    private static final String[] MEMBERS = {"claude", "gpt", "grok", "deepseek", "gemini"};

    @Test
    void sameRequestIdFromFiveMembersCompletesIndependently() throws Exception {
        ActionLedger ledger = new ActionLedger(10);
        ExecutorService pool = Executors.newFixedThreadPool(MEMBERS.length);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(MEMBERS.length);
        for (String agentId : MEMBERS) {
            pool.submit(() -> {
                start.await();
                ActionLedger.Decision decision = ledger.accept(agentId, "same-request", 1L, "look_at", false, 1_000L);
                assertEquals(ActionLedger.Status.ACCEPTED, decision.status);
                done.countDown();
                return null;
            });
        }
        start.countDown();
        assertTrue(done.await(5, TimeUnit.SECONDS));
        pool.shutdown();
        assertEquals(5, ledger.pending());
        for (String agentId : MEMBERS) {
            assertTrue(ledger.complete(agentId, "same-request", 1L));
        }
        assertEquals(0, ledger.pending());
    }

    @Test
    void spoofedCancelDoesNotTouchTheTarget() {
        ActionLedger ledger = new ActionLedger(10);
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("claude", "move-1", 3L, "move_to", true, 1_000L).status);
        assertNull(ledger.cancel("gpt", "move-1", 3L));
        assertTrue(ledger.has("claude", "move-1", 3L));
        assertEquals(1, ledger.pending("claude"));
        assertEquals(0, ledger.pending("gpt"));
    }

    @Test
    void reconnectFailsOnlyThatGeneration() {
        ActionLedger ledger = new ActionLedger(10);
        for (String agentId : MEMBERS) {
            assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept(agentId, "dig", 1L, "break_block", true, 2_000L).status);
        }
        assertEquals(1, ledger.failAgent("claude", 1L).size());
        assertFalse(ledger.has("claude", "dig", 1L));
        for (int i = 1; i < MEMBERS.length; i++) {
            assertTrue(ledger.has(MEMBERS[i], "dig", 1L));
        }
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("claude", "dig", 2L, "break_block", true, 2_000L).status);
        assertFalse(ledger.complete("claude", "dig", 1L));
        assertTrue(ledger.has("claude", "dig", 2L));
        assertTrue(ledger.complete("claude", "dig", 2L));
        assertEquals(4, ledger.pending());
    }

    @Test
    void longActionIsExclusivePerAgentAndRateLimitDoesNotSpill() {
        ActionLedger ledger = new ActionLedger(10);
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("claude", "move", 1L, "move_to", true, 5_000L).status);
        ActionLedger.Decision busy = ledger.accept("claude", "move-2", 1L, "break_block", true, 5_000L);
        assertEquals(ActionLedger.Status.BUSY, busy.status);
        assertEquals("busy", busy.code);
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("claude", "look", 1L, "look_at", false, 5_000L).status);
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("gpt", "move", 1L, "move_to", true, 5_000L).status);
        int accepted = 1;
        for (int i = 0; i < 20; i++) {
            ActionLedger.Decision decision = ledger.accept("gpt", "tick-" + i, 1L, "look_at", false, 5_000L);
            if (decision.status == ActionLedger.Status.ACCEPTED) {
                accepted++;
            }
        }
        ActionLedger.Decision limited = ledger.accept("gpt", "overflow", 1L, "look_at", false, 5_000L);
        assertEquals(ActionLedger.Status.RATE_LIMITED, limited.status);
        assertEquals(10, accepted);
        assertEquals(ActionLedger.Status.ACCEPTED, ledger.accept("grok", "look", 1L, "look_at", false, 5_000L).status);
        assertTrue(ledger.has("claude", "move", 1L));
    }

    @Test
    void disconnectClearsOnlyThatAgent() {
        ActionLedger ledger = new ActionLedger(10);
        ledger.accept("claude", "a", 4L, "look_at", false, 1_000L);
        ledger.accept("gpt", "a", 4L, "look_at", false, 1_000L);
        ledger.failAgent("claude", 4L);
        assertEquals(0, ledger.pending("claude"));
        assertTrue(ledger.has("gpt", "a", 4L));
    }
}
