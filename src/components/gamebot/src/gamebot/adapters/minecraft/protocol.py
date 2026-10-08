"""Minaret / Mineflayer 入站消息解析。固定样例，避免协议静默漂移。"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from gamebot.adapters.minecraft.wire import merged_view


def parse_incoming_chat(data: Dict[str, Any], bot_name: str = "") -> Optional[Tuple[str, str]]:
    data = merged_view(data)
    event = str(data.get("event") or data.get("type") or "").strip().lower()
    if event in ("chat", "player_chat", "chat_message"):
        player = str(data.get("player") or data.get("user") or data.get("username") or "").strip()
        message = str(data.get("message") or data.get("text") or data.get("content") or "").strip()
        if player and message:
            return player, message
    if "message" in data and "user" in data and "event" not in data:
        player = str(data.get("user") or "").strip()
        message = str(data.get("message") or "").strip()
        if player and message and player != bot_name:
            return player, message
    return None


def apply_presence_event(data: Dict[str, Any], online_players: set) -> None:
    event = str(data.get("event") or data.get("type") or "").strip().lower()
    player = str(data.get("player") or data.get("user") or "").strip()
    if event == "player_join" and player:
        online_players.add(player)
    elif event == "player_leave" and player:
        online_players.discard(player)


def extract_handshake(data: Dict[str, Any]) -> Dict[str, Any]:
    """从 hello/status/snapshot 消息提取 version/loader/mods。"""
    data = merged_view(data)
    out: Dict[str, Any] = {}
    event = str(data.get("event") or data.get("type") or "").strip().lower()
    if event not in ("hello", "handshake", "status", "info", "capabilities", "snapshot"):
        if "version" not in data and "mods" not in data and "loader" not in data and "position" not in data:
            return out
    if data.get("version"):
        out["version"] = str(data["version"])
    if data.get("loader"):
        out["loader"] = str(data["loader"]).lower()
    mods = data.get("mods") or data.get("modList") or data.get("mod_list")
    if isinstance(mods, list):
        out["mods"] = [str(m).lower() for m in mods if m]
    elif isinstance(mods, str) and mods.strip():
        out["mods"] = [p.strip().lower() for p in mods.split(",") if p.strip()]
    caps = data.get("capabilities") or data.get("caps")
    if isinstance(caps, list):
        out["raw_capabilities"] = [str(c) for c in caps]
    pos = data.get("position") or data.get("pos")
    if isinstance(pos, dict) and all(k in pos for k in ("x", "y", "z")):
        out["position"] = {"x": float(pos["x"]), "y": float(pos["y"]), "z": float(pos["z"])}
    if data.get("health") is not None:
        try:
            out["health"] = float(data["health"])
        except (TypeError, ValueError):
            pass
    return out
