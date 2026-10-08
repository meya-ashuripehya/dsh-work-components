"""分层短记忆视图：近期详细、越旧越浓缩，源记录不删。"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Sequence

FILLERS = {
    "ok",
    "okay",
    "thanks",
    "thank you",
    "got it",
    "yes",
    "no",
    "嗯",
    "好的",
    "好",
    "明白",
    "收到",
    "谢谢",
    "可以",
    "行",
    "哦",
}

_WS = re.compile(r"\s+")


def display_level(age: int) -> int:
    """age = 与最新已封块的距离（对话进展，不是日历天数）。"""
    if age <= 1:
        return 5
    if age == 2:
        return 4
    if age <= 4:
        return 3
    if age <= 6:
        return 2
    if age <= 8:
        return 1
    return 0


def format_turn(role: str, actor: str, text: str) -> str:
    who = (actor or role or "user").strip() or "user"
    label = "Player" if role == "user" else "Assistant" if role == "assistant" else who
    if actor and role == "user":
        label = actor
    return f"{label}: {(text or '').strip()}"


def build_l4(turns: Sequence[Dict[str, Any]]) -> str:
    lines = []
    for turn in turns:
        role = str(turn.get("role") or "user")
        if role == "system":
            continue
        line = format_turn(role, str(turn.get("actor") or ""), str(turn.get("text") or ""))
        lines.append(line.strip())
    return "\n".join(lines).strip()


def _is_filler(sentence: str) -> bool:
    body = sentence.strip().strip("。.!！？?~…")
    return _WS.sub(" ", body).strip().lower() in FILLERS


def build_l3(turns: Sequence[Dict[str, Any]]) -> str:
    lines = []
    seen_long: set[str] = set()
    for raw in build_l4(turns).splitlines():
        text = raw.strip()
        if not text:
            continue
        payload = text.split(":", 1)[-1].strip()
        if _is_filler(payload):
            continue
        key = _WS.sub(" ", payload).strip().lower()
        if len(key) >= 80 or "{" in payload or payload.startswith("/"):
            if key in seen_long:
                continue
            seen_long.add(key)
        lines.append(text)
    l3 = "\n".join(lines).strip()
    l4 = build_l4(turns)
    if not l3:
        return l4
    return l3 if len(l3) <= len(l4) else l4


def build_l2(turns: Sequence[Dict[str, Any]]) -> str:
    facts = []
    for raw in build_l3(turns).splitlines():
        payload = raw.split(":", 1)[-1].strip()
        if len(payload) < 6:
            continue
        facts.append(payload)
    return "；".join(facts[:8]).strip()


def build_l1(turns: Sequence[Dict[str, Any]]) -> str:
    summary = build_l2(turns) or build_l4(turns)
    return summary[:160].strip()


def build_l0(turns: Sequence[Dict[str, Any]]) -> str:
    title = build_l1(turns)
    return (title[:40] or "对话片段").strip()


def views_for_turns(turns: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    l4 = build_l4(turns)
    l5 = l4
    l3 = build_l3(turns)
    l2 = build_l2(turns) or l3[:200]
    l1 = (l2 or l3)[:160]
    l0 = (l1 or l4 or "对话片段")[:40]
    return {"l0": l0, "l1": l1, "l2": l2, "l3": l3, "l4": l4, "l5": l5}


def view_text(views: Dict[str, str], level: int) -> str:
    key = f"l{max(0, min(5, int(level)))}"
    return str(views.get(key) or views.get("l0") or "").strip()
