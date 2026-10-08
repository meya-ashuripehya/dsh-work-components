"""解析 LLM 输出为 Decision。非法动作丢弃，不让执行层盲试。"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from gamebot.brain.models import Decision, PlannedAction
from gamebot.brain.work_mode import canonical_mode
from gamebot.contracts.capabilities import ACTION_REQUIRED_CAPABILITY

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)


class DecisionParseError(ValueError):
    pass


def extract_json_object(text: str) -> Dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        raise DecisionParseError("empty LLM output")
    fenced = _FENCE_RE.search(raw)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            raise DecisionParseError("LLM output is not JSON")
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as e:
            raise DecisionParseError("LLM output is not JSON") from e
    if not isinstance(data, dict):
        raise DecisionParseError("LLM JSON must be an object")
    return data


def _as_params(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _planned(item: Any) -> Optional[PlannedAction]:
    if isinstance(item, str):
        action = item.strip()
        return PlannedAction(action=action) if action else None
    if not isinstance(item, dict):
        return None
    action = str(item.get("action") or item.get("name") or "").strip()
    if not action:
        return None
    params = item.get("params") if isinstance(item.get("params"), dict) else {}
    extra = {
        k: v
        for k, v in item.items()
        if k not in ("action", "name", "params")
    }
    merged = {**extra, **params}
    return PlannedAction(action=action, params=_as_params(merged))


def parse_decision(text: str, *, max_steps: int = 8) -> Decision:
    data = extract_json_object(text)
    raw_actions = data.get("actions") or data.get("steps") or []
    if isinstance(raw_actions, dict):
        raw_actions = [raw_actions]
    if not isinstance(raw_actions, list):
        raw_actions = []
    accepted: List[PlannedAction] = []
    rejected: List[PlannedAction] = []
    for item in raw_actions:
        planned = _planned(item)
        if planned is None:
            continue
        action = planned.action.strip()
        if action == "command":
            action = "run_command"
            planned = PlannedAction(action=action, params=planned.params)
        if action not in ACTION_REQUIRED_CAPABILITY:
            rejected.append(planned)
            continue
        if len(accepted) >= max_steps:
            rejected.append(planned)
            continue
        accepted.append(planned)
    say = data.get("say")
    if say is not None:
        say = str(say).strip() or None
        if say and len(say) > 240:
            say = say[:237] + "..."
    goal = data.get("goal")
    if goal is not None:
        goal = str(goal).strip() or None
        if goal and len(goal) > 200:
            goal = goal[:197] + "..."
    mode = canonical_mode(data.get("mode"))
    skip = bool(data.get("skip"))
    wait = bool(data.get("wait"))
    if "stop_current" in data:
        stop_current = bool(data.get("stop_current"))
    else:
        stop_current = bool(accepted)
    return Decision(
        reason=str(data.get("reason") or data.get("thought") or "").strip(),
        say=say,
        goal=goal,
        mode=mode,
        actions=accepted,
        wait=wait,
        skip=skip,
        stop_current=stop_current,
        rejected_actions=rejected,
        memory_used=[str(item).strip() for item in (data.get("memory_used") or []) if str(item).strip()],
    )
