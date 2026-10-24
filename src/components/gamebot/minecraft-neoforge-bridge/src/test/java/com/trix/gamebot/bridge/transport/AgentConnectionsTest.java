package com.trix.gamebot.bridge.transport;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentConnectionsTest {
    private static final String[] MEMBERS = {"claude", "gpt", "grok", "deepseek", "gemini"};

    @Test
    void fiveAgentsBindWithoutReplacingEachOther() throws Exception {
        AgentConnections connections = new AgentConnections();
        Fake[] channels = new Fake[MEMBERS.length];
        ExecutorService pool = Executors.newFixedThreadPool(MEMBERS.length);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(MEMBERS.length);
        for (int i = 0; i < MEMBERS.length; i++) {
            Fake channel = new Fake();
            channels[i] = channel;
            String agentId = MEMBERS[i];
            pool.submit(() -> {
                start.await();
                connections.open(channel);
                assertNull(connections.bind(channel, agentId));
                done.countDown();
                return null;
            });
        }
        start.countDown();
        assertTrue(done.await(5, TimeUnit.SECONDS));
        pool.shutdown();
        assertEquals(MEMBERS.length, connections.bound().size());
        for (int i = 0; i < MEMBERS.length; i++) {
            AgentConnections.Binding binding = connections.bindingOf(channels[i]);
            assertEquals(MEMBERS[i], binding.agentId);
            assertTrue(binding.generation > 0);
        }
    }

    @Test
    void reconnectReplacesOnlyThatAgent() {
        AgentConnections connections = new AgentConnections();
        Fake[] first = openAll(connections);
        Fake replacement = new Fake();
        connections.open(replacement);
        AgentConnections.Binding previous = connections.bind(replacement, "claude");
        assertEquals(first[0], previous.channel);
        assertTrue(connections.bindingOf(replacement).generation > previous.generation);
        assertNull(connections.bindingOf(first[0]));
        for (int i = 1; i < MEMBERS.length; i++) {
            assertEquals(MEMBERS[i], connections.bindingOf(first[i]).agentId);
            assertEquals(first[i], connections.bindingOfAgent(MEMBERS[i]).channel);
        }
        assertNull(connections.close(first[0]));
        connections.onChannelError(first[0]);
        assertEquals(replacement, connections.bindingOfAgent("claude").channel);
        assertEquals("claude", connections.bindingOf(replacement).agentId);
    }

    @Test
    void staleGenerationCannotDeliverOntoTheReplacementOrAnotherAgent() {
        AgentConnections connections = new AgentConnections();
        Fake original = new Fake();
        connections.open(original);
        connections.bind(original, "claude");
        long oldGeneration = connections.bindingOf(original).generation;
        Fake replacement = new Fake();
        connections.open(replacement);
        connections.bind(replacement, "claude");
        Fake other = new Fake();
        connections.open(other);
        connections.bind(other, "gpt");
        assertEquals(
                AgentConnections.Delivery.STALE,
                connections.send("claude", oldGeneration, "action_result", "{\"agent\":\"claude\"}", false)
        );
        assertTrue(replacement.sent.isEmpty());
        assertTrue(original.sent.isEmpty());
        assertTrue(other.sent.isEmpty());
        assertEquals(
                AgentConnections.Delivery.DELIVERED,
                connections.send("claude", connections.bindingOf(replacement).generation, "action_result", "{\"agent\":\"claude-new\"}", false)
        );
        assertEquals(List.of("{\"agent\":\"claude-new\"}"), replacement.sent);
        assertTrue(other.sent.isEmpty());
    }

    @Test
    void fullQueueDropsSnapshotsAndDoesNotLeak() {
        AgentConnections connections = new AgentConnections();
        Fake claude = new Fake();
        claude.open = false;
        Fake gpt = new Fake();
        connections.open(claude);
        connections.open(gpt);
        connections.bind(claude, "claude");
        connections.bind(gpt, "gpt");
        long claudeGeneration = connections.bindingOf(claude).generation;
        for (int i = 0; i < AgentConnections.QUEUE_LIMIT; i++) {
            connections.send("claude", claudeGeneration, "snapshot", "snap-" + i, true);
        }
        assertEquals(AgentConnections.QUEUE_LIMIT, connections.queued("claude"));
        connections.send("claude", claudeGeneration, "action_result", "result-claude", false);
        assertEquals(AgentConnections.QUEUE_LIMIT, connections.queued("claude"));
        assertEquals(
                AgentConnections.Delivery.DELIVERED,
                connections.send("gpt", connections.bindingOf(gpt).generation, "action_result", "result-gpt", false)
        );
        assertEquals(List.of("result-gpt"), gpt.sent);
        assertTrue(claude.sent.isEmpty());
        claude.open = true;
        connections.send("claude", claudeGeneration, "snapshot", "tail", true);
        assertTrue(claude.sent.contains("result-claude"));
        assertTrue(!claude.sent.contains("result-gpt"));
        assertEquals(0, connections.queued("claude"));
        AgentConnections.Binding closed = connections.close(claude);
        assertEquals("claude", closed.agentId);
        assertNull(connections.bindingOfAgent("claude"));
        assertEquals("gpt", connections.bindingOfAgent("gpt").agentId);
    }

    private static Fake[] openAll(AgentConnections connections) {
        Fake[] channels = new Fake[MEMBERS.length];
        for (int i = 0; i < MEMBERS.length; i++) {
            channels[i] = new Fake();
            connections.open(channels[i]);
            connections.bind(channels[i], MEMBERS[i]);
        }
        return channels;
    }

    private static final class Fake implements AgentConnections.Channel {
        private final List<String> sent = new ArrayList<>();
        private boolean open = true;

        @Override
        public boolean isOpen() {
            return open;
        }

        @Override
        public void send(String text) {
            sent.add(text);
        }

        @Override
        public void close(int code, String reason) {
            open = false;
        }
    }
}
