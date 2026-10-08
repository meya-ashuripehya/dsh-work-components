"""目标循环的去重。断线后下一次规划会跳过刚完成的同一个动作。"""
from __future__ import annotations

import json
from typing import Any, Optional, Sequence, Tuple


def action_fingerprint(action: str, params: Optional[dict]) -> str:
    body = params if isinstance(params, dict) else {}
    return action + "\n" + json.dumps(body, sort_keys=True, default=str, ensure_ascii=False)


def skip_completed(actions: Sequence[Any], skip_once: Optional[str]) -> Tuple[list, Optional[str]]:
    if not skip_once:
        return list(actions), None
    kept = []
    used = False
    for action in actions:
        name, params = _parts(action)
        if not used and action_fingerprint(name, params) == skip_once:
            used = True
            continue
        kept.append(action)
    return kept, None if used else skip_once


def _parts(action: Any) -> Tuple[str, dict]:
    if isinstance(action, dict):
        params = action.get("params")
        return str(action.get("action") or ""), params if isinstance(params, dict) else {}
    params = getattr(action, "params", None)
    return str(getattr(action, "action", "") or ""), params if isinstance(params, dict) else {}
