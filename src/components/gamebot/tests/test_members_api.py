import asyncio
import json
import threading

import websockets

from gamebot.brain.service import BrainService
from gamebot.config_store import get_game_config, save_game_config
from gamebot.mcp_bridge import tool_connect, tool_create_session
from gamebot.members import ensure_member_session
from gamebot.session import manager


TOKEN = "member-token-test"


def _auth(token=TOKEN):
    return {"X-Gamebot-Member-Token": token}


def _hello(agent_id: str) -> str:
    return json.dumps(
        {
            "protocol_version": 2,
            "event": "hello",
            "sequence": 1,
            "timestamp_ms": 1,
            "data": {
                "agent_id": agent_id,
                "entity_uuid": f"entity-{agent_id}",
                "world_ready": True,
                "actor_type": "server_npc",
                "username": agent_id,
                "version": "1.21.1",
                "loader": "neoforge",
                "capabilities": [],
            },
        }
    )


def test_member_routes_require_token(client, tmp_path, monkeypatch):
    monkeypatch.delenv("GAMEBOT_MEMBER_TOKEN_FILE", raising=False)
    missing = client.post("/v1/minecraft/members/claude/connect")
    assert missing.status_code == 503

    token_file = tmp_path / "member-token"
    token_file.write_text(TOKEN, encoding="utf-8")
    monkeypatch.setenv("GAMEBOT_MEMBER_TOKEN_FILE", str(token_file))
    no_header = client.get("/v1/minecraft/members/claude/status")
    assert no_header.status_code == 401
    wrong = client.get("/v1/minecraft/members/claude/status", headers=_auth("nope"))
    assert wrong.status_code == 403
    bad_id = client.get("/v1/minecraft/members/Bad_Id/status", headers=_auth())
    assert bad_id.status_code == 400
    ok = client.get("/v1/minecraft/members/claude/status", headers=_auth())
    assert ok.status_code == 200
    assert ok.json()["member_id"] == "claude"
    assert ok.json()["exists"] is False


def test_generic_sessions_cannot_own_a_member(client, tmp_path, monkeypatch):
    token_file = tmp_path / "member-token"
    token_file.write_text(TOKEN, encoding="utf-8")
    monkeypatch.setenv("GAMEBOT_MEMBER_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("GAMEBOT_CONFIG_FILE", str(tmp_path / "games.json"))

    created = client.post(
        "/v1/sessions",
        json={"game": "minecraft", "driver": "minaret", "session_id": "minecraft-claude", "config": {}},
    )
    assert created.status_code == 403
    patched = client.post(
        "/v1/sessions",
        json={
            "game": "minecraft",
            "driver": "minaret",
            "session_id": "default-minecraft",
            "config": {"MC_AGENT_ID": "claude"},
        },
    )
    assert patched.status_code == 403
    saved = save_game_config("minecraft", "minaret", {"MC_AGENT_ID": "claude", "MC_MEMBER_MANAGED": "1", "MC_USERNAME": "Bot"})
    assert "MC_AGENT_ID" not in saved.config
    assert "MC_MEMBER_MANAGED" not in saved.config
    assert get_game_config("minecraft").config.get("MC_USERNAME") == "Bot"

    ordinary = client.post(
        "/v1/sessions",
        json={"game": "minecraft", "driver": "minaret", "session_id": "default-minecraft", "config": {"MC_USERNAME": "Bot"}},
    )
    assert ordinary.status_code == 200
    assert "MC_AGENT_ID" not in ordinary.json()["session"]["config"]
    changed = client.patch("/v1/sessions/default-minecraft", json={"config": {"MC_AGENT_ID": "gpt"}})
    assert changed.status_code == 403
    removed = client.delete("/v1/sessions/minecraft-claude", headers=_auth())
    assert removed.status_code == 403


def test_member_connect_does_not_start_brain(client, tmp_path, monkeypatch):
    token_file = tmp_path / "member-token"
    token_file.write_text(TOKEN, encoding="utf-8")
    monkeypatch.setenv("GAMEBOT_MEMBER_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("GAMEBOT_CONFIG_FILE", str(tmp_path / "games.json"))
    ready = threading.Event()
    stop = threading.Event()
    holder = {}

    async def handler(websocket):
        hello = json.loads(await websocket.recv())
        await websocket.send(_hello(hello["data"]["agent_id"]))
        await websocket.wait_closed()

    def _serve():
        async def main():
            async with websockets.serve(handler, "127.0.0.1", 0) as server:
                holder["port"] = server.sockets[0].getsockname()[1]
                ready.set()
                while not stop.is_set():
                    await asyncio.sleep(0.05)

        asyncio.run(main())

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    assert ready.wait(5)
    try:
        save_game_config("minecraft", "minaret", {"NEOFORGE_WS_URL": f"ws://127.0.0.1:{holder['port']}", "MC_USERNAME": "Bot"})
        response = client.post("/v1/minecraft/members/claude/connect", headers=_auth())
        assert response.status_code == 200
        body = response.json()
        assert body["connected"] is True
        rec = manager.get("minecraft-claude")
        assert rec.brain._running is False
        assert rec.session.config["MC_AGENT_ID"] == "claude"
        assert rec.session.config["MC_MEMBER_MANAGED"] == "1"
        assert rec.session.config["LLM_ENABLED"] == "0"
        spoof = client.post(
            "/v1/minecraft/members/claude/actions",
            headers=_auth(),
            json={"action": "look_at", "params": {"agent_id": "gpt", "x": 1, "y": 2, "z": 3}},
        )
        assert spoof.status_code == 400
        extra = client.post(
            "/v1/minecraft/members/claude/connect",
            headers=_auth(),
            json={"member_id": "gpt"},
        )
        assert extra.status_code == 422
        client.post("/v1/minecraft/members/claude/disconnect", headers=_auth())
    finally:
        stop.set()
        thread.join(timeout=3)


def test_legacy_mcp_refuses_member_sessions():
    blocked = json.loads(tool_connect("minecraft-claude"))
    assert blocked["ok"] is False
    assert "mc_*" in blocked["error"]
    created = json.loads(
        tool_create_session("minecraft", "minaret", json.dumps({"MC_AGENT_ID": "claude"}), "default-minecraft")
    )
    assert created["ok"] is False


def test_default_session_still_starts_brain(monkeypatch, tmp_path):
    monkeypatch.setenv("GAMEBOT_CONFIG_FILE", str(tmp_path / "games.json"))
    started = []

    def fake_start(self):
        started.append(self.session_id)
        self._running = True

    monkeypatch.setattr(BrainService, "start", fake_start)

    async def go():
        session = manager.upsert("minecraft", "minaret", {"MC_USERNAME": "Bot"}, session_id="default-minecraft")
        assert "MC_AGENT_ID" not in session.config

        class Driver:
            async def connect(self):
                from gamebot.contracts.models import Observation

                return Observation(game="minecraft", driver="minaret", connected=True, username="Bot")

            async def disconnect(self):
                from gamebot.contracts.models import Observation

                return Observation(game="minecraft", driver="minaret", connected=False, username="Bot")

        manager.get(session.id).driver = Driver()
        await manager.connect(session.id)
        await manager.disconnect(session.id)

    asyncio.run(go())
    assert started == ["default-minecraft"]

    async def member_go():
        member = ensure_member_session("gpt", "GPT")
        assert member.config["MC_AGENT_ID"] == "gpt"

        class Driver:
            async def connect(self):
                from gamebot.contracts.models import Observation

                return Observation(game="minecraft", driver="minaret", connected=True, username="GPT")

        manager.get(member.id).driver = Driver()
        await manager.connect(member.id)
        assert manager.get(member.id).brain._running is False

    asyncio.run(member_go())
    assert started == ["default-minecraft"]
    manager._sessions.clear()
