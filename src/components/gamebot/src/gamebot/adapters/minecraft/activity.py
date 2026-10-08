"""客户端可见动作的保守关联。推断不是精确右键事件。"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Sequence


WINDOW_MS = 500
MAX_DISTANCE = 6.0
MIN_DOT = 0.5


def round_half_up(value: float, digits: int = 3) -> float:
    factor = 10 ** digits
    return math.floor(value * factor + 0.5) / factor


def _unit(x: float, y: float, z: float) -> Optional[tuple]:
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-8:
        return None
    return x / length, y / length, z / length


def associate_block_changes(
    swings: Sequence[Mapping[str, Any]],
    changes: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """把方块变化与面向它的挥手关联。无法关联时不猜测玩家。"""
    results: List[Dict[str, Any]] = []
    for change in sorted(changes, key=lambda item: int(item.get("time_ms") or 0)):
        best: Optional[Dict[str, Any]] = None
        best_confidence = -1.0
        cx = float(change["x"]) + 0.5
        cy = float(change["y"]) + 0.5
        cz = float(change["z"]) + 0.5
        for swing in swings:
            dt = int(change.get("time_ms") or 0) - int(swing.get("time_ms") or 0)
            if dt < 0 or dt > WINDOW_MS:
                continue
            vector = _unit(cx - float(swing["x"]), cy - float(swing["y"]), cz - float(swing["z"]))
            look_raw = swing.get("look") or {}
            look = _unit(float(look_raw.get("x") or 0), float(look_raw.get("y") or 0), float(look_raw.get("z") or 0))
            if vector is None or look is None:
                continue
            distance = math.sqrt((cx - float(swing["x"])) ** 2 + (cy - float(swing["y"])) ** 2 + (cz - float(swing["z"])) ** 2)
            if distance > MAX_DISTANCE:
                continue
            dot = look[0] * vector[0] + look[1] * vector[1] + look[2] * vector[2]
            if dot < MIN_DOT:
                continue
            confidence = round_half_up(dot * (1 - dt / WINDOW_MS) * (1 - distance / MAX_DISTANCE))
            if confidence > best_confidence:
                best_confidence = confidence
                best = {
                    "kind": "possible_block_interaction",
                    "inferred": True,
                    "confidence": confidence,
                    "player": swing.get("player"),
                    "player_uuid": swing.get("uuid"),
                    "block_id": change.get("block_id"),
                    "pos": {"x": change["x"], "y": change["y"], "z": change["z"]},
                    "evidence": ["player_swing", "block_changed", "facing", "time_window", "distance"],
                }
        if best is not None:
            results.append(best)
    return results
