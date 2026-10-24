from gamebot.adapters.minecraft.providers import ITEM_TAGS, recipe_for, resolve_tag


def test_log_tag_does_not_hardcode_single_wood():
    logs = resolve_tag("#minecraft:logs")
    assert "oak_log" in logs
    assert "spruce_log" in logs
    assert logs == ITEM_TAGS["#minecraft:logs"]


def test_crafting_table_recipe_uses_planks_tag():
    recipe = recipe_for("minecraft:crafting_table")
    assert recipe is not None
    assert "#minecraft:planks" in recipe
    assert recipe["#minecraft:planks"] == 4


def test_minaret_construction_capabilities_follow_the_hello_list():
    from gamebot.adapters.minecraft.providers import ProviderBundle
    from gamebot.contracts import capabilities as caps

    def avail(advertised):
        bundle = ProviderBundle(backend="minaret", connected=True, advertised=advertised)
        return {c.id: c.available for c in bundle.capabilities()}

    bare = avail([])
    assert bare[caps.PLACE_BLOCK] is False and bare[caps.BREAK_BLOCK] is False
    assert bare[caps.PROBE_BLOCKS] is False
    full = avail([caps.PLACE_BLOCK, caps.BREAK_BLOCK, caps.PROBE_BLOCKS])
    assert full[caps.PLACE_BLOCK] is True and full[caps.BREAK_BLOCK] is True
    assert full[caps.PROBE_BLOCKS] is True
