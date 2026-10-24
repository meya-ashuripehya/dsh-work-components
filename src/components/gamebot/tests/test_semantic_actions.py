def test_semantic_actions_on_fake_driver(client):
    c = client
    c.post("/v1/sessions", json={"game": "fake", "driver": "fake", "session_id": "sem"})
    c.post("/v1/sessions/sem/connect")

    moved = c.post(
        "/v1/sessions/sem/actions",
        json={"action": "move_to", "params": {"x": 10, "y": 70, "z": -4}},
    )
    assert moved.json()["ok"] is True
    pos = moved.json()["observation"]["position"]
    assert pos["x"] == 10
    assert pos["y"] == 70

    collected = c.post(
        "/v1/sessions/sem/actions",
        json={"action": "collect", "params": {"item_tag": "#minecraft:logs", "count": 3}},
    )
    assert collected.json()["ok"] is True
    inv = collected.json()["observation"]["extras"]["inventory"]
    assert inv["oak_log"] >= 3

    crafted = c.post(
        "/v1/sessions/sem/actions",
        json={"action": "craft", "params": {"item_id": "crafting_table", "count": 1}},
    )
    assert crafted.json()["ok"] is True
    assert crafted.json()["observation"]["extras"]["inventory"]["crafting_table"] == 1

    placed = c.post(
        "/v1/sessions/sem/actions",
        json={"action": "place_block", "params": {"block_id": "crafting_table", "x": 10, "y": 70, "z": -4}},
    )
    assert placed.json()["ok"] is True

    opened = c.post(
        "/v1/sessions/sem/actions",
        json={"action": "open_container", "params": {"x": 10, "y": 70, "z": -4}},
    )
    assert opened.json()["ok"] is True


def test_providers_mark_mod_capabilities():
    from gamebot.adapters.minecraft.providers import ProviderBundle
    from gamebot.contracts.capabilities import MOD_CREATE

    bundle = ProviderBundle(
        backend="minaret",
        connected=True,
        loader="neoforge",
        mods=["create-1.21.1", "jei"],
    )
    caps = {c.id: c.available for c in bundle.capabilities()}
    assert caps[MOD_CREATE] is True
    assert caps["minecraft.mod.ae2"] is False
    assert caps["minecraft.player.move_to"] is False
    assert caps["minecraft.chat.say"] is True
    assert caps["minecraft.recipe.query"] is False
    assert caps["minecraft.server.command"] is False
    assert caps["minecraft.world.use_item_on_block"] is False
    assert caps["minecraft.container.find_item"] is False


def test_minaret_capabilities_follow_advertisement_not_mod_names():
    from gamebot.adapters.minecraft.providers import ProviderBundle
    from gamebot.contracts.capabilities import CONTAINER_FIND_ITEM, USE_ITEM_ON_BLOCK

    bundle = ProviderBundle(
        backend="minaret",
        connected=True,
        loader="neoforge",
        mods=["farmersdelight", "create"],
        advertised=[USE_ITEM_ON_BLOCK, CONTAINER_FIND_ITEM, "minecraft.server.command"],
        inventory_known=True,
        block_scan_known=True,
    )
    caps = {c.id: c.available for c in bundle.capabilities()}
    assert caps[USE_ITEM_ON_BLOCK] is True
    assert caps[CONTAINER_FIND_ITEM] is True
    assert caps["minecraft.server.command"] is True
    assert caps["minecraft.inventory.read"] is True
    assert caps["minecraft.block.scan"] is True
    assert caps["minecraft.player.move_to"] is False
