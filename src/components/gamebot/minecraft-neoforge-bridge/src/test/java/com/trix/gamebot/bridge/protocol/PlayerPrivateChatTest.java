package com.trix.gamebot.bridge.protocol;

import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.transport.AgentBridgeServer;
import com.trix.gamebot.bridge.transport.AgentConnections;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PlayerPrivateChatTest {
    @Test
    void deliversToOnlyTheSelectedConnectionWithoutPublicBroadcast() {
        AgentBridgeServer server = mock(AgentBridgeServer.class);
        AgentConnections connections = new AgentConnections();
        AgentConnections.Channel first = mock(AgentConnections.Channel.class);
        AgentConnections.Channel other = mock(AgentConnections.Channel.class);
        when(first.isOpen()).thenReturn(true);
        when(other.isOpen()).thenReturn(true);
        connections.open(first); connections.bind(first, "seat-5");
        connections.open(other); connections.bind(other, "seat-1");
        when(server.connections()).thenReturn(connections);
        when(server.nextSequence()).thenReturn(42L);
        assertNull(PlayerPrivateChat.deliver(server, "Player", "seat-5", "private-test-marker"));
        ArgumentCaptor<JsonObject> envelope = ArgumentCaptor.forClass(JsonObject.class);
        verify(server).send(eq("seat-5"), eq(connections.bindingOfAgent("seat-5").generation), envelope.capture());
        verify(server, never()).broadcast(any(JsonObject.class));
        verify(server, never()).send(eq("seat-1"), anyLong(), any());
        JsonObject data = envelope.getValue().getAsJsonObject("data");
        assertEquals("private", data.get("audience").getAsString());
        assertEquals("player", data.get("source").getAsString());
        assertEquals("Player", data.get("player").getAsString());
        assertEquals("seat-5", data.get("target").getAsString());
        assertEquals("private-test-marker", data.get("message").getAsString());
        assertFalse(data.has("say_id"));
    }

    @Test
    void unavailableSeatDoesNotFallBackToBroadcast() {
        AgentBridgeServer server = mock(AgentBridgeServer.class);
        when(server.connections()).thenReturn(new AgentConnections());
        assertNotNull(PlayerPrivateChat.deliver(server, "Player", "seat-5", "private-test-marker"));
        verify(server, never()).send(anyString(), anyLong(), any());
        verify(server, never()).broadcast(any(JsonObject.class));
    }
}
