"""动作前置能力校验。不支持时明确返回降级原因，禁止 AI 盲试。"""
from __future__ import annotations

from typing import List, Optional, Tuple

from gamebot.adapters.minecraft.wire import WireError, validate_action_params
from gamebot.contracts.capabilities import ACTION_REQUIRED_CAPABILITY, STATE_QUERY
from gamebot.contracts.models import ActionRequest, ActionResult, Capability, Observation


def required_capability(action: str) -> Optional[str]:
    return ACTION_REQUIRED_CAPABILITY.get((action or "").strip())


def find_capability(capabilities: List[Capability], cap_id: str) -> Optional[Capability]:
    for cap in capabilities:
        if cap.id == cap_id:
            return cap
    return None


def gate_action(observation: Observation, request: ActionRequest) -> Optional[ActionResult]:
    """若不允许执行则返回失败结果，否则返回 None 表示放行。"""
    action = (request.action or "").strip()
    if not action:
        return ActionResult(ok=False, action=action, error="action is required", observation=observation)
    cap_id = required_capability(action)
    if cap_id is None:
        return ActionResult(
            ok=False,
            action=action,
            error=f"unknown action {action}",
            observation=observation,
        )
    if cap_id == STATE_QUERY:
        return None
    cap = find_capability(observation.capabilities, cap_id)
    if cap is None or not cap.available:
        reason = (cap.reason if cap else None) or f"capability {cap_id} is not available"
        return ActionResult(
            ok=False,
            action=action,
            error=reason,
            degraded=True,
            degrade_reason=reason,
            observation=observation,
        )
    try:
        validate_action_params(action, request.params or {})
    except WireError as exc:
        return ActionResult(
            ok=False,
            action=action,
            error=exc.message,
            degraded=True,
            degrade_reason=exc.code,
            extras={"error_code": exc.code},
            observation=observation,
        )
    return None
