import asyncio
import json

import pytest
import websockets

from gamebot.adapters.minecraft.minaret import MinaretBackend
from gamebot.adapters.minecraft.wire import WireError
from gamebot.contracts.models import ActionRequest


MEMBERS = ("claude", "gpt", "grok", "deepseek", "gemini")


def _hello_reply(agent_id: str, entity: str) -> str:
    return json.dumps(
        {
            "protocol_version": 2,
            "event": "hello",
            "sequence": 1,
            "timestamp_ms": 1,
            "data": {
                "agent_id": agent_id,
                "entity_uuid": entity,
                "world_ready": True,
                "actor_type": "server_npc",
                "username": agent_id,
                "version": "1.21.1",
                "loader": "neoforge",
                "capabilities": ["minecraft.player.look_at"],
            },
        }
    )


def test_member_hello_waits_for_matching_agent():
    asyncio.run(_member_hello())


def test_member_hello_mismatch_raises():
    asyncio.run(_member_hello_mismatch())


def test_stale_generation_does_not_complete_new_request():
    asyncio.run(_stale_generation())


def test_cancel_only_own_pending_request():
    asyncio.run(_cancel_own())


def test_five_backends_stay_isolated():
    asyncio.run(_five_backends())


async def _member_hello() -> None:
    seen = []

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        seen.append(hello)
        await websocket.send(_hello_reply("claude", "entity-claude"))
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend(
            {
                "NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}",
                "MC_USERNAME": "Claude",
                "MC_AGENT_ID": "claude",
                "MC_AGENT_NAME": "Claude",
            }
        )
        await backend.connect()
        fields = backend.snapshot_fields()
        assert fields["agent_id"] == "claude"
        assert fields["entity_uuid"] == "entity-claude"
        await backend.disconnect()
    assert seen[0]["protocol_version"] == 2
    assert seen[0]["data"]["agent_id"] == "claude"
    assert seen[0]["data"]["provision"] is True


async def _member_hello_mismatch() -> None:
    async def handler(websocket):
        await websocket.recv()
        await websocket.send(_hello_reply("gpt", "entity-gpt"))
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend(
            {"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MC_AGENT_ID": "claude", "MC_AGENT_NAME": "Claude"}
        )
        with pytest.raises(RuntimeError, match="does not match"):
            await backend.connect()
        await backend.disconnect()


async def _stale_generation() -> None:
    release = asyncio.Event()

    async def handler(websocket):
        await websocket.recv()
        await websocket.send(_hello_reply("claude", "entity-claude"))
        request = json.loads(await websocket.recv())
        await release.wait()
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 2,
                    "event": "action_result",
                    "request_id": request["request_id"],
                    "sequence": 2,
                    "timestamp_ms": 2,
                    "data": {
                        "agent_id": "claude",
                        "ok": True,
                        "action": "look_at",
                        "effect": "confirmed",
                        "error": None,
                        "error_code": None,
                        "sent": "looked",
                        "evidence": {},
                    },
                }
            )
        )
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend(
            {"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MC_AGENT_ID": "claude", "MC_AGENT_NAME": "Claude"}
        )
        await backend.connect()
        task = asyncio.create_task(backend.act(ActionRequest(action="look_at", params={"x": 1, "y": 2, "z": 3})))
        await asyncio.sleep(0.05)
        pending_id = next(iter(backend._pending))
        future, generation = backend._pending[pending_id]
        await backend._handle_event(
            {
                "protocol_version": 2,
                "event": "action_result",
                "request_id": pending_id,
                "data": {"agent_id": "claude", "ok": True, "action": "look_at", "effect": "confirmed", "evidence": {}},
            },
            generation - 1,
        )
        assert future.done() is False
        release.set()
        result = await task
        assert result.ok is True
        assert result.sent == "looked"
        await backend.disconnect()


async def _cancel_own() -> None:
    async def handler(websocket):
        await websocket.recv()
        await websocket.send(_hello_reply("claude", "entity-claude"))
        await websocket.recv()
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend(
            {"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MC_AGENT_ID": "claude", "MINARET_ACTION_TIMEOUT": "2"}
        )
        await backend.connect()
        task = asyncio.create_task(backend.act(ActionRequest(action="look_at", params={"x": 1, "y": 2, "z": 3})))
        await asyncio.sleep(0.05)
        with pytest.raises(WireError):
            await backend.cancel_action("not-mine")
        pending_id = next(iter(backend._pending))
        await backend.cancel_action(pending_id)
        await backend.disconnect()
        result = await task
        assert result.ok is False


async def _five_backends() -> None:
    seen = {}

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        agent_id = hello["data"]["agent_id"]
        seen.setdefault(agent_id, []).append(hello["event"])
        await websocket.send(_hello_reply(agent_id, f"entity-{agent_id}"))
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 2,
                    "event": "snapshot",
                    "sequence": 2,
                    "timestamp_ms": 2,
                    "data": {
                        "agent_id": agent_id,
                        "entity_uuid": f"entity-{agent_id}",
                        "player": {"position": {"x": 1, "y": 64, "z": 2}, "health": 20, "food": 20},
                        "inventory": {"slots": [], "counts": {}},
                        "nearby_blocks": [],
                        "nearby_players": [],
                        "screen": {"id": None, "open": False},
                    },
                }
            )
        )
        request = json.loads(await websocket.recv())
        seen[agent_id].append(request["data"]["agent_id"])
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 2,
                    "event": "action_result",
                    "request_id": request["request_id"],
                    "sequence": 3,
                    "timestamp_ms": 3,
                    "data": {
                        "agent_id": agent_id,
                        "ok": True,
                        "action": "look_at",
                        "effect": "confirmed",
                        "error": None,
                        "error_code": None,
                        "sent": agent_id,
                        "evidence": {},
                    },
                }
            )
        )
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backends = [
            MinaretBackend(
                {
                    "NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}",
                    "MC_AGENT_ID": member,
                    "MC_AGENT_NAME": member,
                    "MC_USERNAME": member,
                }
            )
            for member in MEMBERS
        ]
        await asyncio.gather(*(backend.connect() for backend in backends))
        results = await asyncio.gather(
            *(
                backend.act(ActionRequest(action="look_at", params={"x": 1, "y": 2, "z": 3}))
                for backend in backends
            )
        )
        for member, backend, result in zip(MEMBERS, backends, results):
            assert backend.snapshot_fields()["agent_id"] == member
            assert backend.snapshot_fields()["entity_uuid"] == f"entity-{member}"
            assert result.ok is True
            assert result.sent == member
        await asyncio.gather(*(backend.disconnect() for backend in backends))
    assert set(seen) == set(MEMBERS)
    for member in MEMBERS:
        assert seen[member] == ["hello", member]
