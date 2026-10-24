import asyncio

from gamebot.contracts.models import ActionRequest
from gamebot.drivers.fake import FakeDriver


def test_fake_connect_observe_say():
    async def _run():
        drv = FakeDriver({"username": "BotA"})
        probe = await drv.probe()
        assert probe.reachable
        obs = await drv.connect()
        assert obs.connected
        assert obs.username == "BotA"
        said = await drv.act(ActionRequest(action="say", params={"text": "hello"}))
        assert said.ok
        assert said.sent == "hello"
        state = await drv.act(ActionRequest(action="query_state"))
        assert state.ok
        assert any(e.get("text") == "hello" for e in state.observation.recent_events)

    asyncio.run(_run())


def test_fake_disabled_capability_still_listed():
    async def _run():
        drv = FakeDriver({"capabilities": ["generic.state.query", "minecraft.chat.say"]})
        obs = await drv.connect()
        cap_map = obs.capability_map()
        assert cap_map["minecraft.chat.say"].available
        assert cap_map["minecraft.player.move_to"].available is False

    asyncio.run(_run())
