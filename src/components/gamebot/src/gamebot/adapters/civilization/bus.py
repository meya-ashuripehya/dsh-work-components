"""陪玩面板行协议解析。与 civ6-mcp 的 companion_bus 输出对齐。"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict


def parse_status(text: str) -> Dict[str, Any]:
    data: Dict[str, Any] = {"ready": False, "paused": False, "inbox": 0, "outbox": 0, "error": ""}
    raw = text or ""
    if raw.startswith("Error:") or raw.startswith("Connection"):
        data["error"] = raw.strip()
        return data
    for line in raw.splitlines():
        if line.startswith("READY|"):
            data["ready"] = line.split("|", 1)[1].strip() == "1"
        elif line.startswith("PAUSED|"):
            data["paused"] = line.split("|", 1)[1].strip() == "1"
        elif line.startswith("INBOX|"):
            data["inbox"] = _int(line.split("|", 1)[1])
        elif line.startswith("OUTBOX|"):
            data["outbox"] = _int(line.split("|", 1)[1])
    return data


def parse_events(text: str) -> Dict[str, Any]:
    data: Dict[str, Any] = {"ready": False, "paused": False, "events": [], "error": ""}
    raw = text or ""
    if raw.startswith("Error:") or raw.startswith("Connection"):
        data["error"] = raw.strip()
        return data
    for line in raw.splitlines():
        if line.startswith("READY|"):
            data["ready"] = line.split("|", 1)[1].strip() == "1"
        elif line.startswith("PAUSED|"):
            data["paused"] = line.split("|", 1)[1].strip() == "1"
        elif line.startswith("EVENT|"):
            parts = line.split("|", 4)
            if len(parts) < 5:
                continue
            data["events"].append(
                {
                    "id": parts[1],
                    "kind": parts[2],
                    "proposal_id": parts[3],
                    "text": parts[4],
                }
            )
    return data


def fingerprint(snapshot: Dict[str, Any]) -> str:
    payload = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _int(raw: str) -> int:
    try:
        return int(str(raw).strip() or "0")
    except ValueError:
        return 0
