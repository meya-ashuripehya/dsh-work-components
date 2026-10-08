"""分游戏配置持久化。

路由层只负责 HTTP 入参出参；这里负责默认配置、文件读写和合并规则。
"""
from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List

from pydantic import BaseModel, Field

from gamebot.brain.settings import DEFAULT_LLM_CONFIG, normalize_provider


class GameConfig(BaseModel):
    game: str
    title: str
    description: str = ""
    driver: str
    config: Dict[str, Any] = Field(default_factory=dict)


PROVIDER_IDS = ("openai", "deepseek", "xai", "anthropic", "ollama", "custom")
_KEY_FIELDS = ("LLM_API_KEY", "CHAT_API_KEY", "LLM_API_KEY_REF", "CHAT_API_KEY_REF")


def _blank_keys() -> Dict[str, str]:
    return {name: "" for name in PROVIDER_IDS}


def _read_provider_keys(raw: Dict[str, Any]) -> Dict[str, str]:
    keys = _blank_keys()
    stored = raw.get("provider_keys")
    if isinstance(stored, dict):
        for name in PROVIDER_IDS:
            keys[name] = str(stored.get(name) or "").strip()
    return keys


def _harvest_provider_keys(raw: Dict[str, Any]) -> Dict[str, str]:
    keys = _read_provider_keys(raw)
    for value in raw.values():
        if not isinstance(value, dict):
            continue
        cfg = value.get("config")
        if not isinstance(cfg, dict):
            continue
        for prefix in ("LLM", "CHAT"):
            secret = str(cfg.get(f"{prefix}_API_KEY") or "").strip()
            provider_raw = str(cfg.get(f"{prefix}_PROVIDER") or "").strip()
            if not secret or not provider_raw:
                continue
            provider = normalize_provider(provider_raw)
            if provider in keys and not keys[provider]:
                keys[provider] = secret
    return keys


def _blank_game_keys(raw: Dict[str, Any]) -> bool:
    changed = False
    for value in raw.values():
        if not isinstance(value, dict):
            continue
        cfg = value.get("config")
        if not isinstance(cfg, dict):
            continue
        for field in _KEY_FIELDS:
            if str(cfg.get(field) or "").strip():
                cfg[field] = ""
                changed = True
    return changed


def ensure_provider_keys() -> Dict[str, str]:
    raw = _load_raw()
    keys = _harvest_provider_keys(raw)
    dirty = raw.get("provider_keys") != keys
    if _blank_game_keys(raw):
        dirty = True
    if dirty:
        raw["provider_keys"] = keys
        _write_raw(raw)
    return keys


def lookup_provider_key(provider: str) -> str:
    name = normalize_provider(provider)
    if name not in PROVIDER_IDS:
        return ""
    return _read_provider_keys(_load_raw()).get(name, "")


def save_provider_keys(updates: Dict[str, Any]) -> Dict[str, str]:
    raw = _load_raw()
    keys = _harvest_provider_keys(raw)
    for name, secret in (updates or {}).items():
        provider = normalize_provider(str(name))
        if provider not in PROVIDER_IDS:
            continue
        keys[provider] = str(secret or "").strip()
    raw["provider_keys"] = keys
    _blank_game_keys(raw)
    _write_raw(raw)
    return keys


DEFAULT_GAME_CONFIGS: Dict[str, GameConfig] = {
    "minecraft": GameConfig(
        game="minecraft",
        title="Minecraft",
        description="支持 NeoForge Minaret 和原版/Paper Mineflayer。",
        driver="minaret",
        config={
            "backend": "minaret",
            "MC_DRIVER": "neoforge_ws",
            "NEOFORGE_WS_URL": "ws://127.0.0.1:8765",
            "NEOFORGE_WS_AUTH_USER": "",
            "NEOFORGE_WS_AUTH_PASS": "",
            "MC_HOST": "127.0.0.1",
            "MC_PORT": "25565",
            "MC_USERNAME": "Player",
            "MC_VERSION": "1.21.1",
            "MC_AUTH": "offline",
            "MC_BRIDGE_PORT": "3100",
            "MC_BRIDGE_URL": "http://127.0.0.1:3100",
            "MC_ARCHIVE": "",
            "MC_CHAT_FORWARD": "1",
            "MC_USE_TOOLS": "1",
            "MC_CHAT_PREFIX": "",
            "MC_CHAT_COOLDOWN_MS": "3000",
            "LLM_ENABLED": "0",
            "LLM_PROVIDER": "openai",
            "LLM_PROTOCOL": "openai-completions",
            "LLM_BASE_URL": "",
            "LLM_MODEL": "",
            "LLM_API_KEY": "",
            "LLM_API_KEY_REF": "",
            "LLM_DECISION_TIMEOUT_S": "60",
            "LLM_MAX_STEPS": "8",
            "LLM_TEMPERATURE": "0.2",
            "LLM_TOP_P": "",
            "LLM_MAX_TOKENS": "",
            "LLM_REASONING_EFFORT": "",
            "LLM_THINKING_BUDGET": "",
            "LLM_PERSONA": "",
            "CHAT_ENABLED": "",
            "CHAT_PROVIDER": "",
            "CHAT_PROTOCOL": "",
            "CHAT_BASE_URL": "",
            "CHAT_MODEL": "",
            "CHAT_API_KEY": "",
            "CHAT_API_KEY_REF": "",
            "CHAT_TEMPERATURE": "",
            "CHAT_TOP_P": "",
            "CHAT_MAX_TOKENS": "",
            "CHAT_REASONING_EFFORT": "",
            "CHAT_THINKING_BUDGET": "",
            "CHAT_PERSONA": "",
            "MEMORY_ENABLED": "1",
            "MEMORY_BLOCK_SIZE": "6",
            "DSH_SESSION": "",
            "MC_MODS_DIR": "",
            "WIZARD_SAVED": "0",
        },
    ),
    "civilization": GameConfig(
        game="civilization",
        title="Civilization",
        description="文明6陪玩。通过 civ6-mcp 读取局面，玩家操作后评论；交流正文写入指定的 DSH 会话；不主动结束回合。",
        driver="civ6_mcp",
        config={
            "backend": "civ6_mcp",
            "CIV6_MCP_PROJECT": "",
            "CIV6_MODS_DIR": "",
            "CIV_POLL_INTERVAL_S": "1",
            "WIZARD_SAVED": "0",
            "CIV_SAFE_AUTO": "1",
            "CIV_DSH_SESSION": "",
            **DEFAULT_LLM_CONFIG,
        },
    ),
    "vision": GameConfig(
        game="vision",
        title="视觉兜底",
        description="只处理启动器、菜单、设置页；不用于战斗或路径主循环。",
        driver="vision_desktop",
        config={
            "backend": "vision_desktop",
            "monitor": "1",
            "max_px": "1280",
            "settle_s": "0.15",
            "evidence_dir": "",
            "WIZARD_SAVED": "0",
        },
    ),
}


def _config_path() -> Path:
    raw = (os.getenv("GAMEBOT_CONFIG_FILE") or "").strip()
    if raw:
        return Path(raw)
    return Path.cwd() / "data" / "game-configs.json"


def _load_raw() -> Dict[str, Any]:
    path = _config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_raw(data: Dict[str, Any]) -> None:
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _overlay_provider_key(cfg: GameConfig, keys: Dict[str, str]) -> GameConfig:
    if "LLM_PROVIDER" not in cfg.config:
        return cfg
    provider = normalize_provider(str(cfg.config.get("LLM_PROVIDER") or "openai"))
    cfg.config["LLM_API_KEY"] = keys.get(provider, "")
    cfg.config["CHAT_API_KEY"] = ""
    cfg.config["LLM_API_KEY_REF"] = ""
    cfg.config["CHAT_API_KEY_REF"] = ""
    return cfg


def list_games() -> List[GameConfig]:
    keys = ensure_provider_keys()
    stored = _load_raw()
    out: List[GameConfig] = []
    for key, default in DEFAULT_GAME_CONFIGS.items():
        out.append(_overlay_provider_key(_merge_game_config(default, stored.get(key)), keys))
    return out


def get_game_config(game: str) -> GameConfig:
    key = _normalize_game(game)
    default = DEFAULT_GAME_CONFIGS.get(key)
    if default is None:
        raise KeyError(game)
    keys = ensure_provider_keys()
    return _overlay_provider_key(_merge_game_config(default, _load_raw().get(key)), keys)


def save_game_config(
    game: str,
    driver: str | None,
    config: Dict[str, Any],
    provider_keys: Dict[str, Any] | None = None,
) -> GameConfig:
    key = _normalize_game(game)
    default = DEFAULT_GAME_CONFIGS.get(key)
    if default is None:
        raise KeyError(game)
    current = get_game_config(key)
    next_config = deepcopy(current.config)
    next_config.update({k: v for k, v in (config or {}).items() if v is not None})
    next_driver = (driver or current.driver).strip() or current.driver
    if key == "minecraft":
        _sync_minecraft_driver(next_driver, next_config)
        port = str(next_config.get("MC_BRIDGE_PORT") or "3100").strip() or "3100"
        next_config["MC_BRIDGE_URL"] = f"http://127.0.0.1:{port}"
    if provider_keys:
        save_provider_keys(provider_keys)
    incoming = config or {}
    if "LLM_API_KEY" in incoming and "LLM_PROVIDER" in next_config:
        save_provider_keys({str(next_config.get("LLM_PROVIDER") or "openai"): incoming.get("LLM_API_KEY")})
    for field in _KEY_FIELDS:
        if field in next_config:
            next_config[field] = ""
    saved = GameConfig(
        game=current.game,
        title=current.title,
        description=current.description,
        driver=next_driver,
        config=next_config,
    )
    raw = _load_raw()
    raw[key] = saved.model_dump()
    _write_raw(raw)
    return get_game_config(key)


def _merge_game_config(default: GameConfig, stored: Any) -> GameConfig:
    base = default.model_copy(deep=True)
    if not isinstance(stored, dict):
        return base
    driver = str(stored.get("driver") or base.driver)
    config = deepcopy(base.config)
    if isinstance(stored.get("config"), dict):
        config.update(stored["config"])
    return GameConfig(
        game=base.game,
        title=str(stored.get("title") or base.title),
        description=str(stored.get("description") or base.description),
        driver=driver,
        config=config,
    )


def _normalize_game(game: str) -> str:
    key = (game or "").strip().lower()
    if key in ("mc", "minecraft-java", "minecraft_bedrock"):
        return "minecraft"
    if key in ("civ", "civilization-vi", "civilization_vi"):
        return "civilization"
    if key in ("desktop", "vision_desktop"):
        return "vision"
    return key


def _sync_minecraft_driver(driver: str, config: Dict[str, Any]) -> None:
    d = (driver or "").strip().lower()
    if d == "minaret":
        config["backend"] = "minaret"
        config["MC_DRIVER"] = "neoforge_ws"
    elif d == "mineflayer":
        config["backend"] = "mineflayer"
        config["MC_DRIVER"] = "mineflayer"
