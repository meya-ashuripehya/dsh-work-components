package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.command.AgentCommands;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.ai.navigation.PathNavigation;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.MockedStatic;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Dispatcher lifecycle tests with simulated movement failures, not live-world navigation tests. */
class MovementFailureLifecycleTest {
    @BeforeAll
    static void boot() {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
    }

    @ParameterizedTest
    @CsvSource({
            "false,timeout", "false,block_unloaded", "false,action_rejected",
            "true,timeout", "true,block_unloaded", "true,action_rejected"
    })
    void failureKeepsOwnershipUntilStoppedThenRepliesOnce(boolean placement, String code) throws Exception {
        Harness h = new Harness(placement);
        ActionOutcome failure = failure(code);
        try (MockedStatic<AgentCommands> agents = mockStatic(AgentCommands.class);
             MockedStatic<MovementService> movement = mockStatic(MovementService.class)) {
            h.configure(agents, movement, failure);
            h.dispatcher.tick(h.server);
            assertSame(failure, field(h.job, "terminalOutcome"));
            assertSame(h.session, placement
                    ? ((PlacementService.Run) field(h.job, "placementRun")).movement
                    : field(h.job, "movementSession"));
            assertTrue(h.session.awaitingStop);
            for (int i = 0; i < 3; i++) {
                h.dispatcher.tick(h.server);
                assertSame(h.job, h.pending.get(Harness.KEY));
                assertTrue(h.ledger.has("gpt", "request", 1));
                assertEquals("original-fingerprint", h.payloads.get(Harness.KEY));
                assertTrue(h.replies.isEmpty());
            }
            assertEquals(ActionLedger.Status.BUSY,
                    h.ledger.accept("gpt", "next", 1, "move_to", true, 100).status);
            h.stopped.set(true);
            h.dispatcher.tick(h.server);
            h.dispatcher.tick(h.server);
            assertFalse(h.pending.containsKey(Harness.KEY));
            assertFalse(h.ledger.has("gpt", "request", 1));
            assertEquals("original-fingerprint", h.payloads.get(Harness.KEY));
            assertEquals(1, h.replies.size());
            JsonObject data = h.replies.get(0).getAsJsonObject("data");
            assertFalse(data.get("ok").getAsBoolean());
            assertEquals(code, data.get("error_code").getAsString());
            assertEquals(failure.error, data.get("error").getAsString());
            assertEquals("original-evidence", data.getAsJsonObject("evidence").get("marker").getAsString());
            assertEquals(ActionLedger.Status.ACCEPTED,
                    h.ledger.accept("gpt", "next", 1, "move_to", true, 200).status);
            movement.verify(() -> MovementService.tick(eq(h.agent), same(h.session), anyLong()), times(1));
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void staleCallbackDoesNotStopOrSettleReplacement(boolean placement) throws Exception {
        Harness h = new Harness(placement);
        ActionOutcome failure = failure("timeout");
        try (MockedStatic<AgentCommands> agents = mockStatic(AgentCommands.class);
             MockedStatic<MovementService> movement = mockStatic(MovementService.class)) {
            h.configure(agents, movement, failure);
            h.dispatcher.tick(h.server);
            Object replacement = h.newJob(2);
            assertEquals(ActionLedger.Status.ACCEPTED,
                    h.ledger.accept("gpt", "request", 2, "move_to", true, 100).status);
            h.pending.put(Harness.KEY, replacement);
            h.payloads.put(Harness.KEY, "replacement-fingerprint");
            clearInvocations(h.navigation);
            h.stopped.set(true);
            h.lateFailure(failure);
            assertSame(replacement, h.pending.get(Harness.KEY));
            assertTrue(h.ledger.has("gpt", "request", 2));
            assertEquals("replacement-fingerprint", h.payloads.get(Harness.KEY));
            assertTrue(h.replies.isEmpty());
            verify(h.navigation, never()).stop();
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void ledgerGenerationMismatchCannotSendOldReply(boolean placement) throws Exception {
        Harness h = new Harness(placement);
        ActionOutcome failure = failure("timeout");
        try (MockedStatic<AgentCommands> agents = mockStatic(AgentCommands.class);
             MockedStatic<MovementService> movement = mockStatic(MovementService.class)) {
            h.configure(agents, movement, failure);
            h.dispatcher.tick(h.server);
            assertEquals(ActionLedger.Status.ACCEPTED,
                    h.ledger.accept("gpt", "request", 2, "move_to", true, 100).status);
            h.stopped.set(true);
            h.dispatcher.tick(h.server);
            h.lateFailure(failure);
            assertTrue(h.ledger.has("gpt", "request", 2));
            assertEquals("original-fingerprint", h.payloads.get(Harness.KEY));
            assertTrue(h.replies.isEmpty());
        }
    }

    private static ActionOutcome failure(String code) {
        JsonObject evidence = new JsonObject();
        evidence.addProperty("marker", "original-evidence");
        return ActionOutcome.failure(code, "original " + code, evidence);
    }

    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    /** Seed an accepted in-flight request without invoking pathfinding or world placement. */
    private static final class Harness {
        static final String KEY = "gpt\nrequest";
        final boolean placement;
        final ServerActionDispatcher dispatcher = new ServerActionDispatcher();
        final MinecraftServer server = mock(MinecraftServer.class);
        final AgentEntity agent = mock(AgentEntity.class);
        final PathNavigation navigation = mock(PathNavigation.class);
        final AtomicBoolean stopped = new AtomicBoolean();
        final List<JsonObject> replies = new ArrayList<>();
        final MovementSession session = new MovementSession(
                new NavCandidate("test", 1, 64, 1), 0.45, MovementExclusions.NONE, Long.MAX_VALUE);
        final Map<String, Object> pending;
        final Map<String, String> payloads;
        final ActionLedger ledger;
        final Object job;

        @SuppressWarnings("unchecked")
        Harness(boolean placement) throws Exception {
            this.placement = placement;
            pending = (Map<String, Object>) field(dispatcher, "pending");
            payloads = (Map<String, String>) field(dispatcher, "requestPayloads");
            ledger = (ActionLedger) field(dispatcher, "ledger");
            job = newJob(1);
            pending.put(KEY, job);
            payloads.put(KEY, "original-fingerprint");
            assertEquals(ActionLedger.Status.ACCEPTED,
                    ledger.accept("gpt", "request", 1, placement ? "place_block" : "move_to", true, 0).status);
            when(agent.isAlive()).thenReturn(true);
            when(agent.level()).thenReturn(mock(ServerLevel.class));
            when(agent.getNavigation()).thenReturn(navigation);
            when(navigation.isDone()).thenAnswer(ignored -> stopped.get());
            when(agent.getDeltaMovement()).thenAnswer(ignored -> stopped.get() ? Vec3.ZERO : new Vec3(0.4, 0, 0));
            dispatcher.bind(new ActionReplies() {
                private long sequence;

                public long nextSequence() {
                    return ++sequence;
                }

                public void send(String agentId, long generation, JsonObject payload) {
                    assertEquals("gpt", agentId);
                    assertEquals(1L, generation);
                    replies.add(payload);
                }
            });
        }

        Object newJob(long generation) throws Exception {
            Class<?> type = Class.forName(ServerActionDispatcher.class.getName() + "$Pending");
            Constructor<?> constructor = type.getDeclaredConstructor(
                    String.class, long.class, String.class, String.class, JsonObject.class, long.class);
            constructor.setAccessible(true);
            Object result = constructor.newInstance("gpt", generation, "request",
                    placement ? "place_block" : "move_to", new JsonObject(), Long.MAX_VALUE);
            set(result, "started", true);
            if (placement) {
                PlacementService.Run run = new PlacementService.Run();
                run.params = new JsonObject();
                run.movement = session;
                set(result, "placing", true);
                set(result, "placementRun", run);
            } else {
                set(result, "moving", true);
                set(result, "movementSession", session);
            }
            return result;
        }

        void configure(MockedStatic<AgentCommands> agents, MockedStatic<MovementService> movement,
                       ActionOutcome failure) {
            agents.when(() -> AgentCommands.find(server, "gpt")).thenReturn(agent);
            movement.when(() -> MovementService.tick(eq(agent), same(session), anyLong())).thenReturn(failure);
            movement.when(() -> MovementService.requestStop(agent, session)).thenCallRealMethod();
            movement.when(() -> MovementService.stopComplete(agent, session)).thenCallRealMethod();
        }

        void lateFailure(ActionOutcome failure) throws Exception {
            Method method = ServerActionDispatcher.class.getDeclaredMethod("holdOrRelease",
                    AgentEntity.class, job.getClass(), ActionOutcome.class, boolean.class);
            method.setAccessible(true);
            method.invoke(dispatcher, agent, job, failure, true);
        }
    }
}
