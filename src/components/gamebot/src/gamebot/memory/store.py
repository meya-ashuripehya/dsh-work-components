"""SQLite 记忆持久层：只做读写，不做检索策略。"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")

SCHEMA = """
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    role TEXT NOT NULL,
    actor TEXT,
    text TEXT NOT NULL,
    source TEXT
);
CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_id INTEGER NOT NULL,
    end_id INTEGER NOT NULL,
    l0 TEXT, l1 TEXT, l2 TEXT, l3 TEXT, l4 TEXT,
    ready INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    actor TEXT,
    source_turn INTEGER,
    weight REAL NOT NULL DEFAULT 1.0,
    adoption_count INTEGER NOT NULL DEFAULT 0,
    last_adopted_at REAL,
    decay_anchor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT,
    state TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    rel TEXT NOT NULL,
    UNIQUE(src, dst, rel)
);
"""


def memory_root() -> Path:
    raw = (os.getenv("GAMEBOT_MEMORY_DIR") or "").strip()
    if raw:
        return Path(raw)
    return Path.cwd() / "data" / "memory"


def safe_namespace(raw: str) -> str:
    name = _SAFE.sub("-", (raw or "").strip())[:64].strip("-")
    return name or "default"


class MemoryStore:
    def __init__(self, namespace: str) -> None:
        self.namespace = safe_namespace(namespace)
        root = memory_root()
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / f"{self.namespace}.db"
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA encoding = 'UTF-8'")
        self._conn.text_factory = str
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def add_turn(self, role: str, text: str, actor: str = "", source: str = "") -> int:
        cur = self._conn.execute(
            "INSERT INTO turns(ts, role, actor, text, source) VALUES(?,?,?,?,?)",
            (time.time(), role, actor, text, source),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def turns_after(self, turn_id: int) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, ts, role, actor, text, source FROM turns WHERE id > ? ORDER BY id",
            (turn_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def recent_turns(self, limit: int = 12) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, ts, role, actor, text, source FROM turns ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return list(reversed([dict(row) for row in rows]))

    def last_block_end(self) -> int:
        row = self._conn.execute("SELECT MAX(end_id) FROM blocks").fetchone()
        return int(row[0] or 0)

    def add_block(self, start_id: int, end_id: int, views: Dict[str, str]) -> int:
        cur = self._conn.execute(
            "INSERT INTO blocks(start_id, end_id, l0, l1, l2, l3, l4, ready, created_at) VALUES(?,?,?,?,?,?,?,1,?)",
            (
                start_id,
                end_id,
                views.get("l0") or "",
                views.get("l1") or "",
                views.get("l2") or "",
                views.get("l3") or "",
                views.get("l4") or "",
                time.time(),
            ),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def blocks(self) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, start_id, end_id, l0, l1, l2, l3, l4, ready, created_at FROM blocks ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]

    def block_count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM blocks").fetchone()
        return int(row[0] or 0)

    def add_event(
        self,
        kind: str,
        content: str,
        actor: str = "",
        source_turn: Optional[int] = None,
        weight: float = 1.0,
    ) -> int:
        anchor = self.block_count()
        try:
            stored_weight = float(weight)
        except (TypeError, ValueError):
            stored_weight = 1.0
        stored_weight = max(0.1, min(2.5, stored_weight))
        cur = self._conn.execute(
            "INSERT INTO events(ts, kind, content, actor, source_turn, weight, decay_anchor) VALUES(?,?,?,?,?,?,?)",
            (time.time(), kind, content, actor, source_turn, stored_weight, anchor),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def events(self, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, ts, kind, content, actor, source_turn, weight, adoption_count, last_adopted_at, decay_anchor "
            "FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_event(self, event_id: int) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT id, ts, kind, content, actor, source_turn, weight, adoption_count, last_adopted_at, decay_anchor "
            "FROM events WHERE id=?",
            (event_id,),
        ).fetchone()
        return dict(row) if row else None

    def adopt_event(self, event_id: int) -> None:
        self._conn.execute(
            "UPDATE events SET adoption_count = adoption_count + 1, last_adopted_at=?, decay_anchor=?, "
            "weight = MIN(2.5, weight + 0.25) WHERE id=?",
            (time.time(), self.block_count(), event_id),
        )
        self._conn.commit()

    def upsert_node(self, name: str, kind: str, state: str) -> None:
        now = time.time()
        self._conn.execute(
            "INSERT INTO nodes(name, kind, state, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, state=excluded.state, updated_at=excluded.updated_at",
            (name, kind, state, now),
        )
        self._conn.commit()

    def upsert_edge(self, src: str, dst: str, rel: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO edges(src, dst, rel) VALUES(?,?,?)",
            (src, dst, rel),
        )
        self._conn.commit()

    def nodes(self, limit: int = 24) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, name, kind, state, weight, updated_at FROM nodes ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def edges(self, limit: int = 24) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT src, dst, rel FROM edges ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def counts(self) -> Dict[str, int]:
        def _count(table: str) -> int:
            return int(self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] or 0)

        return {
            "turns": _count("turns"),
            "blocks": _count("blocks"),
            "events": _count("events"),
            "nodes": _count("nodes"),
            "edges": _count("edges"),
        }
