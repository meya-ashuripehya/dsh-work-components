"""文明6动作权限。模型可见的工具仍会在执行前再判一次。"""
from __future__ import annotations

import json
from enum import Enum
from typing import Any, Dict, Mapping


class ActionClass(str, Enum):
    READ = "read"
    SAFE = "safe"
    CONFIRM = "confirm"
    FORBIDDEN = "forbidden"
    HOST = "host"


FORBIDDEN_TOOLS = frozenset(
    {
        "end_turn",
        "run_lua",
        "load_save",
        "load_game_save",
        "kill_game",
        "launch_game",
        "load_save_from_menu",
        "restart_and_load",
    }
)

HOST_ONLY_TOOLS = frozenset(
    {
        "companion_panel_status",
        "companion_poll_events",
        "companion_publish",
    }
)

SAFE_TOOLS = frozenset({"set_research", "set_city_production", "set_city_focus"})
SAFE_UNIT_ACTIONS = frozenset({"fortify", "heal", "alert", "sleep", "skip"})
REPEAT_LIMIT = 5


def classify(name: str, arguments: Mapping[str, Any] | None = None, *, read_only: bool = False) -> ActionClass:
    tool = (name or "").strip()
    args = dict(arguments or {})
    if tool in HOST_ONLY_TOOLS:
        return ActionClass.HOST
    if tool in FORBIDDEN_TOOLS:
        return ActionClass.FORBIDDEN
    if tool == "unit_action":
        action = str(args.get("action") or "").strip().lower()
        if action in SAFE_UNIT_ACTIONS:
            return ActionClass.SAFE
        return ActionClass.CONFIRM
    if tool in SAFE_TOOLS:
        return ActionClass.SAFE
    if read_only:
        return ActionClass.READ
    return ActionClass.CONFIRM


def tool_fingerprint(name: str, arguments: Mapping[str, Any] | None = None) -> str:
    payload = json.dumps(dict(arguments or {}), ensure_ascii=False, sort_keys=True, default=str)
    return f"{name}:{payload}"


def compact_args(arguments: Mapping[str, Any] | None, limit: int = 1000) -> str:
    text = json.dumps(dict(arguments or {}), ensure_ascii=False, sort_keys=True, default=str)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"
