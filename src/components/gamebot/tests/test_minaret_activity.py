import json
from pathlib import Path

from gamebot.adapters.minecraft.activity import associate_block_changes

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "protocol" / "minaret" / "fixtures" / "activity-input.json").read_text(encoding="utf-8"))


def test_facing_swing_can_be_associated_without_claiming_certainty():
    sample = FIXTURE["matched"]
    found = associate_block_changes(sample["swings"], sample["changes"])
    assert len(found) == 1
    event = found[0]
    assert event["kind"] == "possible_block_interaction"
    assert event["inferred"] is True
    assert event["confidence"] == sample["expected_confidence"]
    assert event["player"] == "Steve"
    assert "player_swing" in event["evidence"]
    assert "block_changed" in event["evidence"]


def test_opposite_direction_is_not_guessed():
    sample = FIXTURE["unlinked"]
    assert associate_block_changes(sample["swings"], sample["changes"]) == []
