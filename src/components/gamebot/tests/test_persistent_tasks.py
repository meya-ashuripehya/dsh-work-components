import pytest
from gamebot.adapters.minecraft.wire import validate_action_params, normalize_snapshot, WireError
from gamebot.adapters.minecraft.providers import ProviderBundle
from gamebot.adapters.minecraft.minaret import MinaretBackend
from gamebot.contracts.models import Observation, ActionRequest
from gamebot.router import gate_action


@pytest.mark.parametrize("action,params", [
    ("navigate_to", {"x": 130, "y": -60, "z": 225}),
    ("follow_entity", {"target_agent_id": "seat-5"}),
    ("explore_area", {}), ("stop_task", {}),
    ("inspect_blocks", {"tag": "c:ores"}),
])
def test_tasks_pass_capability_gate_only_when_advertised(action, params):
    prefix = "minecraft.world" if action == "inspect_blocks" else "minecraft.task"
    bundle = ProviderBundle(backend="minaret", connected=True, advertised=[f"{prefix}.{action}"])
    obs = Observation(game="minecraft", driver="minaret", connected=True, capabilities=bundle.capabilities())
    assert gate_action(obs, ActionRequest(action=action, params=params)) is None
    missing = Observation(game="minecraft", driver="minaret", connected=True, capabilities=ProviderBundle(backend="minaret", connected=True).capabilities())
    assert gate_action(missing, ActionRequest(action=action, params=params)).ok is False


@pytest.mark.parametrize("action,params", [
    ("navigate_to", {"x": float("nan"), "y": 0, "z": 0}),
    ("follow_entity", {}), ("follow_entity", {"target_agent_id": "../foreign"}),
    ("follow_entity", {"uuid": "invalid"}),
    ("explore_area", {"seconds": 1000}), ("explore_area", {"return_to_start": "false"}),
    ("inspect_blocks", {"category": "secret"}),
])
def test_task_arguments_fail_closed(action, params):
    with pytest.raises(WireError):
        validate_action_params(action, params)


def test_snapshot_age_is_monotonic_and_invalid_snapshots_cannot_refresh_it(monkeypatch):
    backend = MinaretBackend({"MC_AGENT_ID": "seat-5"})
    now = [100.0]
    monkeypatch.setattr("gamebot.adapters.minecraft.minaret.time.monotonic", lambda: now[0])
    frame = {"protocol_version": 2, "event": "snapshot", "sequence": 4, "data": {"world_id": "world", "game_time": 20, "player": {"position": {"x": 0, "y": 64, "z": 0}}, "task": {"task_id": "one", "state": "running"}, "terrain_summary": {"sampled": True}, "points_of_interest": []}}
    backend._apply_snapshot(frame)
    now[0] = 104
    fields = backend.snapshot_fields()
    assert fields["snapshot_age_ms"] == 4000
    assert fields["game_time"] == 20
    assert fields["minecraft"]["task"]["task_id"] == "one"
    backend._apply_snapshot({"sequence": 5, "data": {"world_id": "world"}})
    assert backend.snapshot_fields()["snapshot_age_ms"] == 4000
    assert backend.snapshot_fields()["snapshot_seq"] == 4
    assert normalize_snapshot(frame)["terrain_summary"] == {"sampled": True}


def test_resource_snapshot_preserves_full_inventory_damage_visible_items_and_pickup_receipts():
    view = {"player": {"position": {"x": 0, "y": 64, "z": 0}},
            "inventory": {"slots": [{"slot": 29, "item_id": "minecraft:iron_pickaxe", "count": 1, "damage": 7, "max_damage": 250}], "counts": {"minecraft:iron_pickaxe": 1}, "capacity": 36, "used_slots": 1},
            "nearby_items": [{"uuid": "one", "item_id": "minecraft:cobblestone", "count": 2, "position": {"x": 1, "y": 64, "z": 0}}],
            "recent_pickups": [{"id": 3, "item_id": "minecraft:dirt", "count": 1}]}
    normalized = normalize_snapshot({"protocol_version": 2, "event": "snapshot", "sequence": 1, "data": view})
    assert normalized["inventory"]["slots"][0]["slot"] == 29
    assert normalized["inventory"]["slots"][0]["damage"] == 7
    assert normalized["inventory"]["capacity"] == 36
    assert normalized["nearby_items"] == view["nearby_items"]
    assert normalized["recent_pickups"] == view["recent_pickups"]
