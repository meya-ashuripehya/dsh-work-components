from gamebot.contracts.capabilities import ACTION_REQUIRED_CAPABILITY, CHAT_SAY
from gamebot.contracts.models import ActionRequest, Capability, Observation


def test_action_capability_map_covers_basic_and_semantic():
    for action in ("say", "run_command", "query_state", "move_to", "craft", "vision_click"):
        assert action in ACTION_REQUIRED_CAPABILITY


def test_observation_has_capability():
    obs = Observation(
        game="fake",
        driver="fake",
        capabilities=[Capability(id=CHAT_SAY, available=True)],
    )
    assert obs.has_capability(CHAT_SAY)
    assert not obs.has_capability("minecraft.world.collect")


def test_action_request_defaults():
    req = ActionRequest(action="say", params={"text": "hi"})
    assert req.require_confirm is False
    assert req.params["text"] == "hi"
