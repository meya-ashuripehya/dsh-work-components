"""聊天室成员的 Minecraft 会话。一个成员一个 NPC，不启动 GameBot 自己的大脑。"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from gamebot.config_store import get_game_config
from gamebot.contracts.models import ActionRequest, ActionResult, Observation
from gamebot.session import manager

AGENT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MEMBER_SESSION = re.compile(r"^minecraft-([a-z0-9][a-z0-9-]{0,31})$")
_TOKEN_HEADER = "X-Gamebot-Member-Token"


def valid_member_id(member_id: str) -> bool:
    return bool(AGENT_ID.fullmatch(member_id or ""))


def member_session_id(member_id: str) -> str:
    if not valid_member_id(member_id):
        raise ValueError("member id is invalid")
    return f"minecraft-{member_id}"


def member_id_from_session(session_id: str) -> Optional[str]:
    match = MEMBER_SESSION.fullmatch(session_id or "")
    return match.group(1) if match else None


def is_member_session(session_id: str) -> bool:
    return member_id_from_session(session_id) is not None


def configured_member_token() -> Optional[str]:
    path = (os.getenv("GAMEBOT_MEMBER_TOKEN_FILE") or "").strip()
    if not path:
        return None
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def require_member_token(presented: Optional[str]) -> None:
    expected = configured_member_token()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="member token is not configured; restart the GameBot body from the workbench",
        )
    if not presented:
        raise HTTPException(status_code=401, detail=f"{_TOKEN_HEADER} is required")
    import hmac

    try:
        matches = hmac.compare_digest(presented, expected)
    except (TypeError, ValueError):
        matches = False
    if not matches:
        raise HTTPException(status_code=403, detail="member token was rejected")


def session_config_for(member_id: str, display_name: Optional[str] = None) -> Dict[str, Any]:
    saved = get_game_config("minecraft")
    config = dict(saved.config)
    name = (display_name or member_id).strip() or member_id
    config["LLM_ENABLED"] = "0"
    config["CHAT_ENABLED"] = "0"
    config["MC_CHAT_FORWARD"] = "0"
    config["MC_AGENT_ID"] = member_id
    config["MC_AGENT_NAME"] = name[:32]
    config["MC_USERNAME"] = name[:32]
    config["MC_MEMBER_MANAGED"] = "1"
    return config


def ensure_member_session(member_id: str, display_name: Optional[str] = None):
    session_id = member_session_id(member_id)
    config = session_config_for(member_id, display_name)
    return manager.upsert("minecraft", "minaret", config, session_id=session_id)


async def connect_member(member_id: str, display_name: Optional[str] = None) -> Observation:
    session = ensure_member_session(member_id, display_name)
    return await manager.connect(session.id)


async def disconnect_member(member_id: str) -> Observation:
    return await manager.disconnect(member_session_id(member_id))


async def observe_member(member_id: str) -> Observation:
    session_id = member_session_id(member_id)
    try:
        manager.get(session_id)
    except KeyError:
        ensure_member_session(member_id)
    return await manager.observe(session_id)


async def act_member(member_id: str, request: ActionRequest) -> ActionResult:
    session_id = member_session_id(member_id)
    try:
        manager.get(session_id)
    except KeyError as exc:
        raise KeyError(session_id) from exc
    params = dict(request.params or {})
    for key in ("agent_id", "member_id"):
        if key in params and str(params[key]) != member_id:
            raise ValueError(f"{key} does not match this member")
        params.pop(key, None)
    cleaned = ActionRequest(action=request.action, params=params, require_confirm=request.require_confirm)
    return await manager.act(session_id, cleaned)


async def cancel_member(member_id: str, target_request_id: str) -> Dict[str, Any]:
    session_id = member_session_id(member_id)
    rec = manager.get(session_id)
    backend = getattr(rec.driver, "_minaret", None)
    if backend is None or not hasattr(backend, "cancel_action"):
        raise RuntimeError("this session has no Minaret backend")
    await backend.cancel_action(target_request_id)
    return {"ok": True, "member_id": member_id, "target_request_id": target_request_id}


async def revoke_member_claim(member_id: str, pid: str, tid: str, gen: int, sig: str) -> Dict[str, Any]:
    session_id = member_session_id(member_id)
    rec = manager.get(session_id)
    backend = getattr(rec.driver, "_minaret", None)
    if backend is None or not hasattr(backend, "send_claim_revoke"):
        raise RuntimeError("this session has no Minaret backend")
    await backend.send_claim_revoke(pid, tid, gen, sig)
    return {"ok": True, "member_id": member_id, "pid": pid, "tid": tid, "gen": int(gen)}


async def status_member(member_id: str) -> Dict[str, Any]:
    session_id = member_session_id(member_id)
    try:
        rec = manager.get(session_id)
    except KeyError:
        return {"ok": True, "member_id": member_id, "session_id": session_id, "connected": False, "exists": False}
    obs = await manager.observe(session_id)
    return {
        "ok": True,
        "member_id": member_id,
        "session_id": session_id,
        "exists": True,
        "connected": obs.connected,
        "connecting": obs.connecting,
        "last_error": obs.last_error,
        "agent_id": (obs.extras or {}).get("agent_id"),
        "username": obs.username,
    }


async def reconcile_members(member_ids: List[str], names: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    names = names or {}

    async def one(member_id: str) -> Dict[str, Any]:
        if not valid_member_id(member_id):
            return {"ok": False, "member_id": member_id, "error": "member id is invalid"}
        try:
            obs = await connect_member(member_id, names.get(member_id) or None)
        except Exception as exc:
            return {"ok": False, "member_id": member_id, "error": str(exc)}
        return {
            "ok": bool(obs.connected),
            "member_id": member_id,
            "session_id": member_session_id(member_id),
            "connected": obs.connected,
            "last_error": obs.last_error,
        }

    return list(await asyncio.gather(*(one(member_id) for member_id in member_ids)))
