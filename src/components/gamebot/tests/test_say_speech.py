"""say 的参数、组包和送达回执。没收到服务端结果不算成功。"""
import asyncio
import json

import websockets

from gamebot.adapters.minecraft.minaret import MinaretBackend
from gamebot.adapters.minecraft.wire import WireError, compose_chat_line, validate_say
from gamebot.contracts.models import ActionRequest


def test_validate_say_rejects_private_without_target_and_bad_emote():
    public = validate_say({"text": "hello"})
    assert public == {"text": "hello", "audience": "public", "emote": ""}
    waved = validate_say({"text": "hello", "audience": "public", "emote": "waves"})
    assert waved["emote"] == "waves"
    private = validate_say({"text": "hi", "audience": "private", "target": "Alex"})
    assert private["target"] == "Alex"
    try:
        validate_say({"text": "hi", "audience": "private"})
    except WireError as exc:
        assert exc.code == "invalid_params"
    else:
        raise AssertionError("private without target must fail")
    try:
        validate_say({"text": "hi", "emote": "wave*"})
    except WireError as exc:
        assert "emote" in exc.message
    else:
        raise AssertionError("emote with asterisk must fail")
    try:
        validate_say({"text": "  "})
    except WireError as exc:
        assert exc.code == "invalid_params"
    else:
        raise AssertionError("empty text must fail")


def test_compose_chat_line_matches_the_chat_box():
    assert compose_chat_line("Steve", "hello") == "<Steve> hello"
    assert compose_chat_line("Steve", "hello", "waves") == "<Steve> *waves* hello"
    line = compose_chat_line("Steve", "m" * 300, "waves")
    assert len(line) == 256
    assert line.startswith("<Steve> *waves* ")


def test_say_waits_for_server_receipt():
    asyncio.run(_receipt())


def test_say_offline_target_is_not_success():
    asyncio.run(_offline())


def test_say_without_receipt_is_not_success():
    asyncio.run(_timeout())


def test_act_rejects_private_before_connecting():
    async def run():
        backend = MinaretBackend({})
        return await backend.act(ActionRequest(action="say", params={"text": "hi", "audience": "private"}))

    result = asyncio.run(run())
    assert result.ok is False
    assert result.extras["error_code"] == "invalid_params"


async def _connect(handler, params, **config):
    outcome = {}

    async def wrapped(websocket):
        await handler(websocket, outcome)

    async with websockets.serve(wrapped, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        backend = MinaretBackend({"NEOFORGE_WS_URL": f"ws://127.0.0.1:{port}", "MC_USERNAME": "Bot", **config})
        await backend.connect()
        try:
            result = await backend.act(ActionRequest(action="say", params=params))
        finally:
            await backend.disconnect()
        return result, outcome


async def _receipt():
    async def handler(websocket, outcome):
        await websocket.recv()
        request = json.loads(await websocket.recv())
        outcome["request"] = request
        await websocket.send(json.dumps({
            "event": "chat_result",
            "data": {
                "ok": True,
                "say_id": request["say_id"],
                "message_id": request["say_id"],
                "audience": "public",
                "sent": "<Bot> *waves* hello",
            },
        }))
        await websocket.wait_closed()

    result, outcome = await _connect(handler, {"text": "hello", "emote": "waves", "say_id": "11111111-1111-1111-1111-111111111111"})
    sent = outcome["request"]
    assert sent["message"] == "hello"
    assert sent["audience"] == "public"
    assert sent["emote"] == "waves"
    assert sent["say_id"] == "11111111-1111-1111-1111-111111111111"
    assert "command" not in sent
    assert result.ok is True
    assert result.sent == "<Bot> *waves* hello"
    assert result.extras["message_id"] == sent["say_id"]


async def _offline():
    async def handler(websocket, outcome):
        await websocket.recv()
        request = json.loads(await websocket.recv())
        outcome["request"] = request
        await websocket.send(json.dumps({
            "event": "chat_result",
            "data": {
                "ok": False,
                "say_id": request["say_id"],
                "audience": "private",
                "target": "Alex",
                "error_code": "target_offline",
                "error": "target is offline",
            },
        }))
        await websocket.wait_closed()

    result, outcome = await _connect(handler, {"text": "psst", "audience": "private", "target": "Alex"})
    assert outcome["request"]["audience"] == "private"
    assert outcome["request"]["target"] == "Alex"
    assert result.ok is False
    assert result.extras["error_code"] == "target_offline"


async def _timeout():
    async def handler(websocket, outcome):
        await websocket.recv()
        outcome["request"] = json.loads(await websocket.recv())
        await websocket.wait_closed()

    result, _outcome = await _connect(handler, {"text": "hello"}, MINARET_SAY_TIMEOUT="0.2")
    assert result.ok is False
    assert result.extras["error_code"] == "timeout"
