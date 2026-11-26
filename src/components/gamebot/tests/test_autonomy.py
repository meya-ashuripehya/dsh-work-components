import asyncio
from types import SimpleNamespace

from gamebot import members
from gamebot.adapters.minecraft.minaret import MinaretBackend


def test_roster_registration_can_wait_for_spawn_and_remove_without_reprovision():
    async def run():
        backend = MinaretBackend({"MC_AGENT_ID": "gpt"})
        hello = {"protocol_version": 2, "event": "hello", "data": {"agent_id": "gpt", "world_id": "world-a", "world_ready": False, "capabilities": []}}
        backend._apply_handshake(hello)
        assert backend.snapshot_fields()["world_id"] == "world-a"
        assert backend.snapshot_fields()["joined"] is False
        future = asyncio.get_running_loop().create_future()
        backend._hello_waiter = (future, 0, "gpt")
        backend._complete_hello(hello, 0)
        assert (await future)["ok"] is True
        backend._apply_handshake({"protocol_version": 2, "event": "hello", "data": {"world_id": "world-a", "world_ready": True, "capabilities": ["minecraft.player.move_to"]}})
        assert backend._joined is True
        assert backend.snapshot_fields()["advertised"] == ["minecraft.player.move_to"]
        backend._apply_handshake(hello)
        assert backend._joined is False
        assert backend.snapshot_fields()["advertised"] == []
        assert backend.snapshot_fields()["position"] is None
    asyncio.run(run())


def test_explicit_empty_capabilities_revoke_even_with_nonempty_legacy_alias():
    from gamebot.adapters.minecraft.protocol import extract_handshake
    assert extract_handshake({"event": "hello", "capabilities": [], "caps": ["minecraft.chat.say"]})["raw_capabilities"] == []


def test_standable_feet_goals_survive_snapshot_normalization():
    from gamebot.adapters.minecraft.wire import normalize_snapshot
    goals = [{"position": {"x": 125.5, "y": -60, "z": 225.5}, "path_checked": False}]
    snapshot = {"player": {"position": {"x": 125.5, "y": -60, "z": 222.5}}, "standable_goals": goals}
    assert normalize_snapshot(snapshot)["standable_goals"] == goals
    del snapshot["standable_goals"]
    assert normalize_snapshot(snapshot)["standable_goals"] == []


def test_world_changes_clear_cached_observation_and_events():
    backend = MinaretBackend({"MC_AGENT_ID": "gpt"})
    backend._world_id = "old"
    backend._minecraft = {"player": {"dimension": "old"}}
    backend._recent_events = [{"text": "old public message"}]
    backend._snapshot_seq = 123
    backend._apply_handshake({"event": "hello", "data": {"world_id": "new", "world_ready": True}})
    assert backend._world_id == "new"
    assert backend._minecraft == {}
    assert backend._recent_events == []
    assert backend._snapshot_seq == 0


def test_existing_member_registration_does_not_replace_driver(monkeypatch):
    existing = SimpleNamespace(id="minecraft-gpt")
    monkeypatch.setattr(members, "manager", SimpleNamespace(get=lambda _: SimpleNamespace(session=existing), upsert=lambda *a, **k: (_ for _ in ()).throw(AssertionError("recreated driver"))))
    assert members.ensure_member_session("gpt") is existing


def test_reconcile_revokes_unselected_members_even_for_empty_roster(monkeypatch):
    removed = []
    async def disconnect(sid):
        removed.append(sid)
    monkeypatch.setattr(members, "_eligible_members", None)
    monkeypatch.setattr(members, "manager", SimpleNamespace(list_sessions=lambda: [SimpleNamespace(id="minecraft-gpt"), SimpleNamespace(id="other")], disconnect=disconnect))
    assert asyncio.run(members.reconcile_members([])) == []
    assert removed == ["minecraft-gpt"]
