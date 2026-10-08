"""记忆编排：分层展示、检索、证据评估、仅采纳加固。"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence

from gamebot.memory.extract import extract_events, extract_nodes
from gamebot.memory.layers import display_level, view_text, views_for_turns
from gamebot.memory.store import MemoryStore, safe_namespace

_TOKEN = re.compile(r"[A-Za-z0-9_#\u4e00-\u9fff]+")


def _tokens(text: str) -> List[str]:
    found = [part.lower() for part in _TOKEN.findall(text or "") if part]
    grams: List[str] = []
    for part in found:
        if len(part) > 1:
            grams.append(part)
        chars = [ch for ch in part if "\u4e00" <= ch <= "\u9fff"]
        if len(chars) >= 2:
            grams.extend("".join(chars[i : i + 2]) for i in range(len(chars) - 1))
    return grams


def _score(query: str, content: str, weight: float, age_blocks: int, adoption: int) -> float:
    q = set(_tokens(query))
    c = set(_tokens(content))
    if not q:
        overlap = 0.15
    else:
        overlap = len(q & c) / max(1, len(q))
    raw_q = (query or "").strip().lower()
    if raw_q and raw_q in (content or "").lower():
        overlap = max(overlap, 0.6)
    decay = math.exp(-0.08 * max(0, age_blocks))
    adopt = 1.0 + min(1.0, 0.15 * adoption)
    return overlap * weight * decay * adopt


class MemoryService:
    def __init__(self, namespace: str, block_size: int = 6) -> None:
        self.namespace = safe_namespace(namespace)
        self.block_size = max(2, int(block_size or 6))
        self.store = MemoryStore(self.namespace)

    def enabled(self) -> bool:
        return True

    def record_turn(self, role: str, text: str, actor: str = "", source: str = "") -> int:
        turn_id = self.store.add_turn(role, text, actor=actor, source=source)
        self.maybe_seal()
        return turn_id

    def maybe_seal(self) -> Optional[int]:
        last_end = self.store.last_block_end()
        pending = self.store.turns_after(last_end)
        if len(pending) < self.block_size:
            return None
        chunk = pending[: self.block_size]
        views = views_for_turns(chunk)
        return self.store.add_block(int(chunk[0]["id"]), int(chunk[-1]["id"]), views)

    def remember_interaction(
        self,
        *,
        player: str = "",
        message: str = "",
        say: str = "",
        reason: str = "",
        goal: str = "",
        source: str = "chat",
    ) -> None:
        turn_id = None
        if message:
            turn_id = self.record_turn("user", message, actor=player, source=source)
        if say:
            self.record_turn("assistant", say, actor="bot", source=source)
        for event in extract_events(player=player, message=message, say=say, reason=reason, goal=goal, source=source):
            self.store.add_event(
                event["kind"],
                event["content"],
                actor=str(event.get("actor") or ""),
                source_turn=turn_id,
                weight=float(event.get("weight") or 1.0),
            )
        nodes, edges = extract_nodes(player, message, goal)
        for node in nodes:
            self.store.upsert_node(node["name"], node["kind"], node["state"])
        for src, dst, rel in edges:
            self.store.upsert_edge(src, dst, rel)

    def context(self, query: str = "", *, budget: int = 1200) -> Dict[str, Any]:
        blocks = self.store.blocks()
        newest = blocks[-1]["id"] if blocks else 0
        layered: List[str] = []
        for block in reversed(blocks):
            age = newest - int(block["id"])
            level = display_level(age)
            text = view_text(
                {
                    "l0": block.get("l0") or "",
                    "l1": block.get("l1") or "",
                    "l2": block.get("l2") or "",
                    "l3": block.get("l3") or "",
                    "l4": block.get("l4") or "",
                    "l5": block.get("l4") or "",
                },
                level,
            )
            if text:
                layered.append(f"[B{block['id']} L{level}] {text}")
            if len("\n".join(layered)) > budget // 2:
                break
        last_end = self.store.last_block_end()
        unsealed = self.store.turns_after(last_end)
        if unsealed:
            layered.insert(0, "[unsealed L5] " + " | ".join(f"{t.get('actor') or t.get('role')}: {t.get('text')}" for t in unsealed[-6:]))

        progress = self.store.block_count()
        ranked = []
        for event in self.store.events(limit=80):
            age = progress - int(event.get("decay_anchor") or 0)
            score = _score(query, str(event.get("content") or ""), float(event.get("weight") or 1), age, int(event.get("adoption_count") or 0))
            ranked.append((score, event))
        ranked.sort(key=lambda item: item[0], reverse=True)
        events = [item[1] for item in ranked[:4] if item[0] > 0.02]
        nodes = self.store.nodes(limit=4)
        evidence_ok = bool(events) or bool(unsealed) or bool(layered)
        missing = []
        if query and not events:
            missing.append("no long-term event matched the query")
        text_parts = []
        if events:
            text_parts.append("[Long-term events]")
            for event in events:
                text_parts.append(f"- #{event['id']} ({event['kind']}) {event['content']}")
        if nodes:
            text_parts.append("[Current state graph]")
            for node in nodes:
                text_parts.append(f"- {node['name']}: {node.get('kind')} / {node.get('state')}")
        if layered:
            text_parts.append("[Layered short-term memory]")
            text_parts.extend(layered[:6])
        packed = "\n".join(text_parts)
        if len(packed) > budget:
            packed = packed[: budget - 3] + "..."
        return {
            "text": packed,
            "events": events,
            "nodes": nodes,
            "evidence_ok": evidence_ok,
            "missing": missing,
            "counts": self.store.counts(),
        }

    def adopt(self, event_ids: Sequence[Any]) -> List[int]:
        used: List[int] = []
        for raw in event_ids:
            try:
                event_id = int(str(raw).lstrip("#"))
            except (TypeError, ValueError):
                continue
            if self.store.get_event(event_id) is None:
                continue
            self.store.adopt_event(event_id)
            used.append(event_id)
        return used

    def panel(self) -> Dict[str, Any]:
        counts = self.store.counts()
        blocks_raw = self.store.blocks()
        newest = int(blocks_raw[-1]["id"]) if blocks_raw else 0
        blocks: List[Dict[str, Any]] = []
        for block in blocks_raw:
            age = newest - int(block["id"])
            level = display_level(age)
            levels = {
                "l0": block.get("l0") or "",
                "l1": block.get("l1") or "",
                "l2": block.get("l2") or "",
                "l3": block.get("l3") or "",
                "l4": block.get("l4") or "",
                "l5": block.get("l4") or "",
            }
            blocks.append(
                {
                    "id": int(block["id"]),
                    "start_id": int(block["start_id"]),
                    "end_id": int(block["end_id"]),
                    "ready": bool(block.get("ready", 1)),
                    "created_at": block.get("created_at"),
                    "display_level": level,
                    "age": age,
                    "summary": view_text(levels, level),
                    "levels": levels,
                }
            )
        last_end = self.store.last_block_end()
        turns = self.store.turns_after(last_end)
        summary = " | ".join(
            f"{item.get('actor') or item.get('role')}: {item.get('text')}" for item in turns[-8:]
        )
        unsealed = {
            "open": bool(turns),
            "start_id": int(turns[0]["id"]) if turns else 0,
            "end_id": int(turns[-1]["id"]) if turns else 0,
            "turns": turns,
            "summary": summary,
        }
        return {
            "namespace": self.namespace,
            "counts": counts,
            "blocks": blocks,
            "unsealed": unsealed,
            "nodes": self.store.nodes(limit=24),
            "edges": self.store.edges(limit=48),
        }

    def snapshot(self) -> Dict[str, Any]:
        data = self.panel()
        data["recent_events"] = self.store.events(limit=50)
        return data

    def search(self, query: str) -> Dict[str, Any]:
        found = self.context(query, budget=1600)
        data = self.panel()
        data.update(
            {
                "text": found.get("text") or "",
                "recent_events": found.get("events") or [],
                "evidence_ok": bool(found.get("evidence_ok", True)),
                "missing": list(found.get("missing") or []),
            }
        )
        return data
