"""从对话抽取事件与当前状态节点。不调用模型，避免每轮额外计费。"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

PREFERENCE_MARKERS = ("记住", "记得", "以后", "喜欢", "不要", "别", "prefer", "remember", "always", "never")
PLAN_MARKERS = ("去", "要", "目标", "计划", "帮我", "一起", "follow", "go ", "mine", "build", "craft")
EVENT_WEIGHTS = {
    "preference": 1.6,
    "plan": 1.5,
    "decision": 1.1,
    "chat": 0.85,
    "fact": 1.0,
}


def classify_chat(text: str) -> str:
    raw = (text or "").strip()
    low = raw.lower()
    if any(mark in raw or mark in low for mark in PREFERENCE_MARKERS):
        return "preference"
    if any(mark in raw or mark in low for mark in PLAN_MARKERS):
        return "plan"
    return "chat"


def extract_events(
    *,
    player: str,
    message: str,
    say: str = "",
    reason: str = "",
    goal: str = "",
    source: str = "chat",
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if message:
        kind = classify_chat(message) if source == "chat" else "fact"
        out.append(
            {
                "kind": kind,
                "content": f"{player}: {message}" if player else message,
                "actor": player,
                "weight": EVENT_WEIGHTS.get(kind, 1.0),
            }
        )
    if goal:
        out.append(
            {
                "kind": "plan",
                "content": f"goal: {goal}",
                "actor": "bot",
                "weight": EVENT_WEIGHTS["plan"],
            }
        )
    if reason:
        out.append(
            {
                "kind": "decision",
                "content": reason,
                "actor": "bot",
                "weight": EVENT_WEIGHTS["decision"],
            }
        )
    if say and source == "chat":
        out.append(
            {
                "kind": "chat",
                "content": f"bot: {say}",
                "actor": "bot",
                "weight": EVENT_WEIGHTS["chat"],
            }
        )
    return out


def extract_nodes(player: str, message: str, goal: str = "") -> Tuple[List[Dict[str, str]], List[Tuple[str, str, str]]]:
    nodes: List[Dict[str, str]] = []
    edges: List[Tuple[str, str, str]] = []
    if player:
        nodes.append({"name": player, "kind": "player", "state": "online"})
        edges.append((player, "bot", "talked_to"))
    nodes.append({"name": "bot", "kind": "agent", "state": "active"})
    if goal:
        nodes.append({"name": "current_goal", "kind": "goal", "state": goal})
        edges.append(("bot", "current_goal", "pursues"))
    text = message or ""
    for token in text.replace("，", " ").replace(",", " ").split():
        if token.startswith("#") or "_" in token and len(token) > 3:
            nodes.append({"name": token.lstrip("#"), "kind": "item", "state": "mentioned"})
    return nodes, edges
