import asyncio
import json
import tempfile

import websockets

from gamebot.adapters.minecraft.minaret import MinaretBackend
from gamebot.contracts.capabilities import USE_ITEM_ON_BLOCK
from gamebot.contracts.models import ActionRequest


def test_backend_round_trip_snapshot_and_action():
    asyncio.run(_round_trip())


def test_disconnect_fails_pending_action():
    asyncio.run(_disconnect_pending())


async def _round_trip() -> None:
    seen = []

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        seen.append(hello)
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "event": "hello",
                    "sequence": 1,
                    "timestamp_ms": 1,
                    "data": {
                        "version": "1.21.1",
                        "loader": "neoforge",
                        "mods": ["create"],
                        "capabilities": [USE_ITEM_ON_BLOCK, "minecraft.chat.say"],
                    },
                }
            )
        )
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "event": "snapshot",
                    "sequence": 2,
                    "timestamp_ms": 2,
                    "data": {
                        "player": {
                            "position": {"x": 1, "y": 64, "z": 2},
                            "health": 19,
                            "food": 17,
                            "main_hand": {"item_id": "minecraft:iron_ingot", "count": 3},
                        },
                        "inventory": {"slots": [], "counts": {"minecraft:iron_ingot": 3}},
                        "nearby_blocks": [
                            {"block_id": "create:mechanical_press", "pos": {"x": 2, "y": 64, "z": 2}, "state": {}, "distance": 1}
                        ],
                        "nearby_players": [{"name": "Alex", "distance": 4, "position": {"x": 5, "y": 64, "z": 2}}],
                        "screen": {"id": None, "open": False},
                    },
                }
            )
        )
        request = json.loads(await websocket.recv())
        seen.append(request)
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "event": "action_result",
                    "request_id": request["request_id"],
                    "sequence": 3,
                    "timestamp_ms": 3,
                    "data": {
                        "ok": True,
                        "action": "use_item_on_block",
                        "effect": "confirmed",
                        "error": None,
                        "error_code": None,
                        "sent": "used",
                        "evidence": {"inventory_before": {"minecraft:iron_ingot": 3}, "inventory_after": {"minecraft:iron_ingot": 2}},
                    },
                }
            )
        )
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend({"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MC_USERNAME": "Bot"})
        await backend.connect()
        for _ in range(40):
            fields = backend.snapshot_fields()
            if USE_ITEM_ON_BLOCK in fields["advertised"] and fields["position"] is not None:
                break
            await asyncio.sleep(0.02)
        fields = backend.snapshot_fields()
        assert fields["version"] == "1.21.1"
        assert fields["inventory"]["minecraft:iron_ingot"] == 3
        assert fields["minecraft"]["nearby_blocks"][0]["block_id"] == "create:mechanical_press"
        result = await backend.act(
            ActionRequest(
                action="use_item_on_block",
                params={"item_id": "minecraft:iron_ingot", "pos": {"x": 2, "y": 64, "z": 2}, "face": "up"},
            )
        )
        assert result.ok is True
        assert result.extras["effect"] == "confirmed"
        assert result.extras["evidence"]["inventory_after"]["minecraft:iron_ingot"] == 2
        await backend.disconnect()
    assert seen[0]["event"] == "hello"
    assert seen[0]["user"] == "Bot"
    assert seen[1]["event"] == "action_request"


def test_place_timeout_is_unknown_and_not_replayed():
    asyncio.run(_place_timeout())


def test_hello_carries_claim_key_without_putting_it_in_the_snapshot():
    asyncio.run(_hello_claim_key())


async def _place_timeout() -> None:
    seen = []

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        seen.append(hello)
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "event": "hello",
                    "sequence": 1,
                    "timestamp_ms": 1,
                    "data": {"version": "1.21.1", "loader": "neoforge", "capabilities": []},
                }
            )
        )
        request = json.loads(await websocket.recv())
        seen.append(request)
        try:
            while True:
                seen.append(json.loads(await websocket.recv()))
        except Exception:
            return

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend({"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MINARET_ACTION_TIMEOUT": "0.2"})
        await backend.connect()
        place = ActionRequest(
            action="place_block",
            params={"pos": {"x": 0, "y": 64, "z": 0}, "block_id": "minecraft:oak_planks"},
        )
        first = await backend.act(place)
        second = await backend.act(place)
        look = await backend.act(ActionRequest(action="look_at", params={"x": 1, "y": 2, "z": 3}))
        await backend.disconnect()
    assert first.degrade_reason == "needs_reconciliation"
    assert first.extras["effect"] == "unknown"
    assert first.extras["replay"] is False
    assert second.degrade_reason == "needs_reconciliation"
    assert second.extras["replay"] is False
    assert look.degrade_reason == "timeout"
    assert [item["event"] for item in seen].count("action_request") == 2
    actions = [item["data"]["action"] for item in seen if item.get("event") == "action_request"]
    assert actions == ["place_block", "look_at"]


async def _hello_claim_key() -> None:
    secret = "claim-key-must-stay-out-of-snapshots"
    seen = []

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        seen.append(hello)
        agent_id = hello["data"]["agent_id"]
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 2,
                    "event": "hello",
                    "sequence": 1,
                    "timestamp_ms": 1,
                    "data": {
                        "agent_id": agent_id,
                        "world_ready": True,
                        "version": "1.21.1",
                        "loader": "neoforge",
                        "capabilities": [],
                    },
                }
            )
        )
        revoke = json.loads(await websocket.recv())
        seen.append(revoke)
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        key = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8")
        key.write(secret + "\n")
        key.close()
        backend = MinaretBackend(
            {
                "NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}",
                "MC_AGENT_ID": "alpha",
                "MC_AGENT_NAME": "Alpha",
                "GAMEBOT_CLAIM_KEY_FILE": key.name,
            }
        )
        await backend.connect()
        await backend.send_claim_revoke("site", "floor", 2, "sig")
        fields = json.dumps(backend.snapshot_fields())
        await backend.disconnect()
    assert seen[0]["data"]["claim_key"] == secret
    assert secret not in fields
    assert secret not in json.dumps(backend.snapshot_fields())
    assert seen[1]["event"] == "claim_revoke"
    assert seen[1]["data"]["pid"] == "site"
    assert seen[1]["data"]["gen"] == 2
    assert "claim_key" not in json.dumps(seen[1])


async def _disconnect_pending() -> None:
    async def handler(websocket):
        await websocket.recv()
        await websocket.send(
            json.dumps(
                {
                    "protocol_version": 1,
                    "event": "hello",
                    "sequence": 1,
                    "timestamp_ms": 1,
                    "data": {"version": "1.21.1", "loader": "neoforge", "capabilities": ["minecraft.player.look_at"]},
                }
            )
        )
        await websocket.recv()
        await websocket.wait_closed()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend({"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MINARET_ACTION_TIMEOUT": "0.2"})
        await backend.connect()
        task = asyncio.create_task(backend.act(ActionRequest(action="look_at", params={"x": 1, "y": 2, "z": 3})))
        await asyncio.sleep(0.05)
        await backend.disconnect()
        result = await task
        assert result.ok is False
        assert result.degrade_reason in {"not_connected", "timeout"}
