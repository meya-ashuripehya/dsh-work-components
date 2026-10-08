"""按 game/driver 实例化适配器。"""
from __future__ import annotations

from typing import Any, Dict

from gamebot.drivers.base import GameDriver
from gamebot.drivers.fake import FakeDriver


def normalize_driver(game: str, driver: str) -> str:
    g = (game or "").strip().lower()
    d = (driver or "").strip().lower()
    if d in ("neoforge", "neoforge_ws", "minaret", "ws"):
        return "minaret"
    if d == "mineflayer":
        return "mineflayer"
    if d in ("vision", "vision_desktop", "desktop"):
        return "vision_desktop"
    if d in ("civ6", "civ6_mcp", "civilization_mcp"):
        return "civ6_mcp"
    if d == "fake" or g == "fake":
        return "fake"
    if g in ("minecraft", "mc"):
        return "minaret" if not d else d
    if g in ("vision", "desktop"):
        return "vision_desktop"
    if g in ("civilization", "civ", "civilization-vi", "civilization_vi") and d in ("", "civ6_mcp"):
        return "civ6_mcp"
    return d or g or "fake"


def create_driver(game: str, driver: str, config: Dict[str, Any] | None = None) -> GameDriver:
    cfg = dict(config or {})
    kind = normalize_driver(game, driver)
    if kind == "fake":
        return FakeDriver(cfg)
    if kind in ("minaret", "mineflayer"):
        from gamebot.adapters.minecraft.adapter import MinecraftAdapter

        cfg.setdefault("backend", kind)
        return MinecraftAdapter(cfg)
    if kind == "vision_desktop":
        from gamebot.adapters.vision_desktop.adapter import VisionDesktopAdapter

        return VisionDesktopAdapter(cfg)
    if kind == "civ6_mcp":
        from gamebot.adapters.civilization.adapter import CivilizationAdapter

        return CivilizationAdapter(cfg)
    raise ValueError(f"unsupported game/driver: game={game!r} driver={driver!r}")
