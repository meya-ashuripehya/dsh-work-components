"""按游戏准备模组目录：列出常见位置，并把模组植入玩家选定的文件夹。"""
from __future__ import annotations

from typing import Any, Dict

from gamebot.adapters.civilization.mod_install import inspect_mod as inspect_civ_mod
from gamebot.adapters.civilization.mod_install import install_mod as install_civ_mod
from gamebot.adapters.civilization.mod_install import location_hints as civ_location_hints
from gamebot.adapters.minecraft.mod_install import inspect_mod as inspect_minecraft_mod
from gamebot.adapters.minecraft.mod_install import install_mod as install_minecraft_mod
from gamebot.config_store import get_game_config, save_game_config


def describe_mod(game: str) -> Dict[str, Any]:
    cfg = get_game_config(game)
    if cfg.game == "vision":
        return {
            "ok": True,
            "needs_mod": False,
            "installed": True,
            "source_ready": True,
            "mods_dir": "",
            "path": "",
            "examples": [],
            "detected": [],
            "message": "视觉不使用游戏模组。",
        }
    if cfg.game == "civilization":
        status = inspect_civ_mod(cfg.config)
        hints = civ_location_hints()
        status["needs_mod"] = True
        status["examples"] = hints["examples"]
        status["detected"] = hints["detected"]
        if status.get("installed") and not status.get("message"):
            status["message"] = "模组已在所选文件夹中。"
        return status
    if cfg.game == "minecraft":
        return inspect_minecraft_mod(cfg.config)
    raise ValueError("该游戏没有可植入的模组")


def install_for_game(game: str, mods_dir: str = "") -> Dict[str, Any]:
    cfg = get_game_config(game)
    chosen = (mods_dir or "").strip()
    if cfg.game == "vision":
        raise ValueError("视觉不需要植入模组")
    if cfg.game == "civilization":
        overlay = dict(cfg.config)
        if chosen:
            overlay["CIV6_MODS_DIR"] = chosen
        installed = install_civ_mod(overlay)
        save_game_config(cfg.game, None, {"CIV6_MODS_DIR": installed.get("mods_dir") or ""})
        message = str(installed.get("message") or "")
    elif cfg.game == "minecraft":
        overlay = dict(cfg.config)
        if chosen:
            overlay["MC_MODS_DIR"] = chosen
        elif not str(overlay.get("MC_MODS_DIR") or "").strip():
            raise FileNotFoundError("请先选择模组文件夹")
        installed = install_minecraft_mod(overlay)
        save_game_config(cfg.game, None, {"MC_MODS_DIR": installed.get("mods_dir") or ""})
        message = str(installed.get("message") or "")
    else:
        raise ValueError("该游戏没有可植入的模组")
    status = describe_mod(cfg.game)
    status["installed_now"] = True
    status["message"] = message
    return status
