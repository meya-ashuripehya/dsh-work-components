"""Minecraft 能力 Provider：原版标签/配方 + loader + 高价值模组。整合包只是组合结果。"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Set

from gamebot.contracts import capabilities as cap_ids
from gamebot.contracts.models import Capability

VANILLA_LOGS = {
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "dark_oak_log",
    "mangrove_log",
    "cherry_log",
    "pale_oak_log",
    "crimson_stem",
    "warped_stem",
}

VANILLA_PLANKS = {
    "oak_planks",
    "spruce_planks",
    "birch_planks",
    "jungle_planks",
    "acacia_planks",
    "dark_oak_planks",
    "mangrove_planks",
    "cherry_planks",
    "pale_oak_planks",
    "crimson_planks",
    "warped_planks",
}

ITEM_TAGS: Dict[str, Set[str]] = {
    "#minecraft:logs": set(VANILLA_LOGS),
    "#minecraft:planks": set(VANILLA_PLANKS),
}

# 简化原版配方：产物 → 原料计数（仅样板，真实配方由 bridge/registry 覆盖）
VANILLA_RECIPES: Dict[str, Dict[str, int]] = {
    "minecraft:crafting_table": {"#minecraft:planks": 4},
    "crafting_table": {"#minecraft:planks": 4},
    "stick": {"#minecraft:planks": 2},
}

KNOWN_MODS = {
    "create": cap_ids.MOD_CREATE,
    "ae2": cap_ids.MOD_AE2,
    "appliedenergistics2": cap_ids.MOD_AE2,
    "botania": cap_ids.MOD_BOTANIA,
}


def normalize_item(item: str) -> str:
    raw = (item or "").strip()
    if raw.startswith("minecraft:"):
        raw = raw[len("minecraft:") :]
    return raw


def resolve_tag(item_or_tag: str) -> Set[str]:
    raw = (item_or_tag or "").strip()
    if not raw:
        return set()
    if raw.startswith("#"):
        key = raw if ":" in raw else f"#minecraft:{raw[1:]}"
        return set(ITEM_TAGS.get(key, set()))
    return {normalize_item(raw)}


def recipe_for(item_id: str) -> Optional[Dict[str, int]]:
    key = normalize_item(item_id)
    return VANILLA_RECIPES.get(item_id) or VANILLA_RECIPES.get(key)


class ProviderBundle:
    def __init__(
        self,
        *,
        backend: str,
        connected: bool,
        version: Optional[str] = None,
        loader: Optional[str] = None,
        mods: Optional[Iterable[str]] = None,
        advertised: Optional[Iterable[str]] = None,
        mineflayer_ready: bool = False,
        position_known: bool = False,
        health_known: bool = False,
        inventory_known: bool = False,
        block_scan_known: bool = False,
        entity_nearby_known: bool = False,
    ) -> None:
        self.backend = backend
        self.connected = connected
        self.version = version
        self.loader = (loader or "").lower() or None
        self.mods: Set[str] = {str(m).lower() for m in (mods or []) if m}
        self.advertised: Set[str] = {str(a) for a in (advertised or []) if a}
        self.mineflayer_ready = mineflayer_ready
        self.position_known = position_known
        self.health_known = health_known
        self.inventory_known = inventory_known
        self.block_scan_known = block_scan_known
        self.entity_nearby_known = entity_nearby_known

    def _avail(self, cap_id: str, available: bool, reason: Optional[str] = None) -> Capability:
        if cap_id in self.advertised:
            available = True
            reason = None
        if not self.connected and cap_id != cap_ids.STATE_QUERY:
            return Capability(id=cap_id, available=False, reason=reason or "not connected")
        return Capability(id=cap_id, available=available, reason=None if available else reason)

    def capabilities(self) -> List[Capability]:
        chat_cmd = self.backend in ("minaret", "mineflayer", "fake")
        mf = self.backend == "mineflayer" and self.mineflayer_ready
        out = [
            self._avail(cap_ids.STATE_QUERY, True),
            self._avail(cap_ids.CHAT_SAY, chat_cmd, "chat backend missing"),
            self._avail(cap_ids.SERVER_COMMAND, mf, "command execution is not advertised"),
            self._avail(
                cap_ids.POSITION_READ,
                mf or self.position_known,
                "position not exposed by this driver",
            ),
            self._avail(
                cap_ids.HEALTH_READ,
                mf or self.health_known,
                "health not exposed by this driver",
            ),
            self._avail(cap_ids.INVENTORY_READ, mf or self.inventory_known, "inventory requires Mineflayer or a Minaret snapshot"),
            self._avail(cap_ids.BLOCK_SCAN, mf or self.block_scan_known, "block scan requires Mineflayer or a Minaret snapshot"),
            self._avail(cap_ids.RECIPE_QUERY, mf, "no recipe source"),
            self._avail(cap_ids.ENTITY_NEARBY, mf or self.entity_nearby_known, "nearby entities require Mineflayer or a Minaret snapshot"),
            self._avail(cap_ids.MOVE_TO, mf, "pathfinding requires Mineflayer"),
            self._avail(cap_ids.LOOK_AT, mf, "look_at is not advertised"),
            self._avail(cap_ids.COLLECT, mf, "collect requires Mineflayer world access"),
            self._avail(cap_ids.CRAFT, mf, "craft requires Mineflayer inventory"),
            self._avail(cap_ids.PLACE_BLOCK, mf, "place_block requires Mineflayer"),
            self._avail(cap_ids.INTERACT, mf, "interact is not advertised"),
            self._avail(cap_ids.OPEN_CONTAINER, mf, "open_container requires Mineflayer"),
            self._avail(cap_ids.TRANSFER_ITEM, mf, "transfer_item requires Mineflayer"),
            self._avail(cap_ids.SELECT_ITEM, False, "select_item is not advertised"),
            self._avail(cap_ids.DROP_ITEM, False, "drop_item is not advertised"),
            self._avail(cap_ids.USE_ITEM, False, "use_item is not advertised"),
            self._avail(cap_ids.USE_ITEM_ON_BLOCK, False, "use_item_on_block is not advertised"),
            self._avail(cap_ids.ATTACK_BLOCK, False, "attack_block is not advertised"),
            self._avail(cap_ids.ENTITY_ATTACK, False, "attack_entity is not advertised"),
            self._avail(cap_ids.CONTAINER_FIND_ITEM, False, "find_item is not advertised"),
            self._avail(cap_ids.PLAYER_ACTIVITY, False, "player activity is not advertised"),
        ]
        for mod_key, cap_id in KNOWN_MODS.items():
            present = any(mod_key in m or m == mod_key for m in self.mods)
            out.append(
                self._avail(
                    cap_id,
                    present,
                    f"mod {mod_key} not loaded",
                )
            )
        return out
