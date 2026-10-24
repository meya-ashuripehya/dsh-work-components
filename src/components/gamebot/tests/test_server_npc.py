from gamebot.adapters.minecraft.wire import (
    WireError,
    action_timeout_seconds,
    build_action_request,
    normalize_snapshot,
    parse_action_result,
    validate_action_params,
)
from gamebot.brain.goal import action_fingerprint, skip_completed
from gamebot.brain.prompt import compact_observation
from gamebot.contracts.models import Capability, Observation


def test_server_npc_snapshot_keeps_agent_identity_and_closed_screen():
    snapshot = normalize_snapshot(
        {
            "event": "snapshot",
            "actor_type": "server_npc",
            "agent_id": "12345678-1234-1234-1234-123456789abc",
            "player": {"position": {"x": 1, "y": 64, "z": 2}, "health": 20},
            "inventory": {"slots": [], "counts": {}},
            "nearby_blocks": [],
            "nearby_players": [],
            "screen": {"id": None, "open": False},
        }
    )
    assert snapshot["actor_type"] == "server_npc"
    assert snapshot["agent_id"] == "12345678-1234-1234-1234-123456789abc"
    observation = Observation(
        game="minecraft",
        driver="minaret",
        connected=True,
        extras={"minecraft": snapshot},
        capabilities=[Capability(id="minecraft.player.move_to", available=True)],
    )
    compact = compact_observation(observation)
    assert compact["actor_type"] == "server_npc"
    assert compact["screen"]["open"] is False
    assert "move_to" in compact["available_actions"]


def test_move_and_attack_params_and_adapter_error_survive():
    move = validate_action_params("move_to", {"x": 1, "y": 64, "z": 2})
    assert move == {"x": 1.0, "y": 64.0, "z": 2.0}
    assert action_timeout_seconds("move_to", move) == 30.0
    assert validate_action_params("attack_entity", {}) == {}
    try:
        validate_action_params("attack_entity", {"uuid": "nope"})
    except WireError as exc:
        assert exc.code == "invalid_params"
    else:
        raise AssertionError("bad uuid was accepted")
    parsed = parse_action_result(
        {
            "protocol_version": 1,
            "event": "action_result",
            "request_id": "abc",
            "data": {
                "ok": False,
                "action": "interact",
                "effect": "failed",
                "error": "no adapter can handle this block",
                "error_code": "unsupported_adapter",
                "evidence": {"block_id": "minecraft:stone", "reason": "no adapter can handle this block"},
            },
        }
    )
    assert parsed["error_code"] == "unsupported_adapter"
    envelope = build_action_request("look_at", {"x": 1, "y": 2, "z": 3}, 4, goal="find pie")
    assert envelope["data"]["goal"] == "find pie"


def test_completed_action_is_skipped_once_after_reconnect():
    fingerprint = action_fingerprint("move_to", {"x": 1, "y": 64, "z": 2})
    first = [{"action": "move_to", "params": {"x": 1, "y": 64, "z": 2}}, {"action": "look_at", "params": {"x": 1, "y": 2, "z": 3}}]
    kept, remaining = skip_completed(first, fingerprint)
    assert [item["action"] for item in kept] == ["look_at"]
    assert remaining is None
    again, still = skip_completed(first, None)
    assert len(again) == 2
    assert still is None
