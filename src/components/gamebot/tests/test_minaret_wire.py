import json
from pathlib import Path

import jsonschema
import pytest

from gamebot.adapters.minecraft.protocol import extract_handshake, parse_incoming_chat
from gamebot.adapters.minecraft.wire import (
    WireError,
    build_action_request,
    build_claim_revoke,
    build_hello,
    compact_nearby_blocks,
    normalize_snapshot,
    validate_action_params,
)
from gamebot.brain.prompt import DECISION_MECHANICS, compact_observation
from gamebot.contracts.capabilities import USE_ITEM_ON_BLOCK
from gamebot.contracts.models import ActionRequest, Capability, Observation
from gamebot.router import gate_action

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "protocol" / "minaret" / "fixtures"
SCHEMA = json.loads((ROOT / "protocol" / "minaret" / "minaret-v1.schema.json").read_text(encoding="utf-8"))


def test_v1_fixtures_match_schema():
    validator = jsonschema.Draft202012Validator(SCHEMA)
    for name in (
        "hello-v1.json",
        "snapshot-v1.json",
        "action-request-use.json",
        "action-result-confirmed.json",
        "hello-v2.json",
        "action-request-v2.json",
        "error-agent-mismatch-v2.json",
    ):
        validator.validate(json.loads((FIXTURES / name).read_text(encoding="utf-8")))


def test_v1_hello_keeps_legacy_user_and_capabilities():
    hello = build_hello("Bot", 1)
    assert hello["user"] == "Bot"
    assert "claim_key" not in hello["data"]
    signed = build_hello("Bot", 2, agent_id="alpha", claim_key="secret")
    assert signed["data"]["claim_key"] == "secret"
    revoked = build_claim_revoke("alpha", "site", "floor", 2, "sig", 3)
    assert revoked["event"] == "claim_revoke"
    assert revoked["data"]["gen"] == 2
    assert "secret" not in json.dumps(revoked)
    parsed = extract_handshake(json.loads((FIXTURES / "hello-v1.json").read_text(encoding="utf-8")))
    assert parsed["version"] == "1.21.1"
    assert parsed["loader"] == "neoforge"
    assert "create" in parsed["mods"]
    assert "minecraft.world.use_item_on_block" in parsed["raw_capabilities"]


def test_snapshot_exposes_mod_block_and_compacts_for_prompt():
    snapshot = normalize_snapshot(json.loads((FIXTURES / "snapshot-v1.json").read_text(encoding="utf-8")))
    assert snapshot["nearby_blocks"][0]["block_id"] == "create:depot"
    assert snapshot["inventory"]["counts"]["minecraft:iron_ingot"] == 5
    observation = Observation(
        game="minecraft",
        driver="minaret",
        connected=True,
        extras={"minecraft": snapshot},
        capabilities=[Capability(id=USE_ITEM_ON_BLOCK, available=True)],
    )
    compact = compact_observation(observation)
    assert "inferred=true" in DECISION_MECHANICS
    assert compact["nearby_blocks"][0]["block_id"] == "create:depot"
    assert compact["nearby_blocks"][0]["nearest"][0]["pos"]["x"] == 12
    assert len(json.dumps(compact["nearby_blocks"])) < 4000
    assert "item_search" not in compact


def test_find_item_stays_out_of_the_normal_block_list():
    observation = Observation(
        game="minecraft",
        driver="minaret",
        connected=True,
        extras={
            "minecraft": {"nearby_blocks": [{"block_id": "minecraft:chest", "pos": {"x": 1, "y": 64, "z": 2}, "distance": 3}]},
            "item_search": {
                "item_id": "minecraft:iron_ingot",
                "matches": [
                    {
                        "block_id": "create:depot",
                        "name": "置物台",
                        "pos": {"x": 41, "y": 63, "z": 211},
                        "distance": 1.0,
                        "count": 7,
                        "slots": [{"slot": 0, "count": 7}],
                    }
                ],
            },
        },
        recent_events=[
            {
                "type": "action_result",
                "data": {"data": {"action": "find_item", "evidence": {"matches": [{"count": 7}]}}},
                "at": 1,
            }
        ],
        capabilities=[Capability(id="minecraft.container.find_item", available=True)],
    )
    compact = compact_observation(observation)
    assert compact["nearby_blocks"][0]["block_id"] == "minecraft:chest"
    assert "slots" not in compact["nearby_blocks"][0]
    assert compact["item_search"]["matches"][0]["count"] == 7
    assert compact["item_search"]["matches"][0]["pos"]["x"] == 41
    assert compact["recent_events"] == []
    assert "find_item" in compact["available_actions"]
    cleaned = validate_action_params("find_item", {"item_id": "minecraft:iron_ingot"})
    assert cleaned == {"item_id": "minecraft:iron_ingot"}


def test_duplicate_blocks_keep_three_nearest_coordinates():
    blocks = [
        {"block_id": "create:depot", "pos": {"x": index, "y": 64, "z": 0}, "distance": float(index)}
        for index in range(5)
    ]
    compact = compact_nearby_blocks(blocks, coords_per_group=3)
    assert compact[0]["count"] == 5
    assert [item["pos"]["x"] for item in compact[0]["nearest"]] == [0, 1, 2]


def test_invalid_mod_id_never_reaches_driver():
    observation = Observation(
        game="minecraft",
        driver="minaret",
        connected=True,
        capabilities=[Capability(id=USE_ITEM_ON_BLOCK, available=True)],
    )
    blocked = gate_action(
        observation,
        ActionRequest(action="use_item_on_block", params={"item_id": "Iron", "pos": {"x": 1, "y": 2, "z": 3}}),
    )
    assert blocked is not None
    assert blocked.degrade_reason == "invalid_params"


def test_hotbar_slot_limit_is_explicit():
    with pytest.raises(WireError) as raised:
        validate_action_params("select_item", {"slot": 9})
    assert raised.value.code == "unsupported"


def test_action_request_uses_v1_envelope():
    envelope = build_action_request("look_at", {"x": 1, "y": 64, "z": -2}, 3, request_id="abc")
    assert envelope["protocol_version"] == 1
    assert envelope["request_id"] == "abc"
    assert envelope["data"]["params"] == {"x": 1.0, "y": 64.0, "z": -2.0}


def test_v1_chat_still_parses():
    player, text = parse_incoming_chat(
        {"protocol_version": 1, "event": "chat", "sequence": 1, "timestamp_ms": 1, "data": {"player": "Steve", "message": "hi"}},
        "Bot",
    )
    assert player == "Steve"
    assert text == "hi"


def test_place_block_normalizes_defaults_and_state():
    cleaned = validate_action_params(
        "place_block",
        {"pos": {"x": 1, "y": 64, "z": -3}, "block_id": "minecraft:oak_stairs", "state": {"facing": "north", "waterlogged": False}},
    )
    assert cleaned["block_id"] == "minecraft:oak_stairs"
    assert cleaned["max_distance"] == 4.5
    assert cleaned["state"] == {"facing": "north", "waterlogged": "false"}
    assert "face" not in cleaned


def test_place_block_keeps_legacy_flat_coordinates():
    cleaned = validate_action_params("place_block", {"block_id": "crafting_table", "x": 10.7, "y": 70, "z": -4})
    assert cleaned["pos"] == {"x": 10, "y": 70, "z": -4}
    assert cleaned["block_id"] == "minecraft:crafting_table"


@pytest.mark.parametrize(
    "params",
    [
        {"block_id": "minecraft:stone"},
        {"pos": {"x": 1, "y": 2, "z": 3}},
        {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "Stone:x"},
        {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone", "face": "sideways"},
        {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone", "state": {"Facing": "north"}},
        {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone", "state": {"facing": "north east"}},
        {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone", "max_distance": 9},
    ],
)
def test_place_block_rejects_bad_params(params):
    with pytest.raises(WireError) as raised:
        validate_action_params("place_block", params)
    assert raised.value.code == "invalid_params"


def test_probe_blocks_requires_positions_and_keeps_air_out_of_validation():
    cleaned = validate_action_params("probe_blocks", {"positions": [{"x": 4, "y": 2, "z": 3}, {"x": 4, "y": 3, "z": 3}]})
    assert cleaned["positions"] == [{"x": 4, "y": 2, "z": 3}, {"x": 4, "y": 3, "z": 3}]
    with pytest.raises(WireError) as raised:
        validate_action_params("probe_blocks", {"positions": []})
    assert raised.value.code == "invalid_params"


def test_snapshot_records_truncation_without_treating_it_as_air():
    snapshot = normalize_snapshot(
        {
            "player": {"position": {"x": 0, "y": 64, "z": 0}, "dimension": "minecraft:overworld"},
            "nearby_blocks": [],
            "nearby_blocks_truncated": True,
            "nearby_players": [],
            "inventory": {"slots": [], "counts": {}},
            "screen": {"open": False},
        }
    )
    assert snapshot["nearby_blocks"] == []
    assert snapshot["nearby_blocks_truncated"] is True
    assert snapshot["player"]["dimension"] == "minecraft:overworld"


def test_break_block_requires_expected_block():
    cleaned = validate_action_params("break_block", {"pos": {"x": 1, "y": 64, "z": -3}, "expected_block": "minecraft:dirt"})
    assert cleaned["expected_block"] == "minecraft:dirt"
    with pytest.raises(WireError):
        validate_action_params("break_block", {"pos": {"x": 1, "y": 64, "z": -3}})


def test_new_actions_use_the_long_timeout_only_for_breaking():
    from gamebot.adapters.minecraft.wire import action_timeout_seconds

    assert action_timeout_seconds("break_block", {}) == 30.0
    assert action_timeout_seconds("place_block", {}) == 5.0


def test_action_request_passes_claim_through_and_caps_its_size():
    claim = {"holder": "bot-a", "version": 7, "sig": "abc"}
    envelope = build_action_request(
        "place_block", {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone"}, 4, claim=claim
    )
    assert envelope["data"]["claim"] == claim
    with pytest.raises(WireError):
        build_action_request(
            "place_block", {"pos": {"x": 1, "y": 2, "z": 3}, "block_id": "minecraft:stone"}, 5, claim={"blob": "x" * 2000}
        )


def test_new_error_codes_survive_result_parsing():
    from gamebot.adapters.minecraft.wire import parse_action_result

    for code in ("position_occupied", "state_mismatch"):
        parsed = parse_action_result(
            {"protocol_version": 1, "event": "action_result", "sequence": 1, "timestamp_ms": 1, "request_id": "r",
             "data": {"ok": False, "action": "place_block", "effect": "failed", "error": "x", "error_code": code}}
        )
        assert parsed["error_code"] == code
