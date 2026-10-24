"""成员 NPC 的 REST。调用者身份在路径里，不接受 body 里的成员字段。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from gamebot.contracts.models import ActionRequest, ActionResult, Observation
from gamebot.members import (
    act_member,
    cancel_member,
    connect_member,
    disconnect_member,
    observe_member,
    reconcile_members,
    require_member_token,
    revoke_member_claim,
    status_member,
    valid_member_id,
)

router = APIRouter()


class NoMemberFields(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemberAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str
    params: Dict[str, Any] = Field(default_factory=dict)
    require_confirm: bool = False


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_request_id: str


class ClaimRevoke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pid: str
    tid: str
    gen: int
    sig: str


class ReconcileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_ids: List[str]
    names: Optional[Dict[str, str]] = None


def _auth(token: Optional[str]) -> None:
    require_member_token(token)


def _check_id(member_id: str) -> None:
    if not valid_member_id(member_id):
        raise HTTPException(status_code=400, detail="member id is invalid")


@router.post("/v1/minecraft/members/reconcile")
async def reconcile(
    body: ReconcileRequest,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth(x_gamebot_member_token)
    results = await reconcile_members(body.member_ids, body.names)
    return {"ok": True, "members": results}


@router.post("/v1/minecraft/members/{member_id}/connect", response_model=Observation)
async def connect(
    member_id: str,
    body: Optional[NoMemberFields] = None,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Observation:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    try:
        return await connect_member(member_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/v1/minecraft/members/{member_id}/disconnect", response_model=Observation)
async def disconnect(
    member_id: str,
    body: Optional[NoMemberFields] = None,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Observation:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    try:
        return await disconnect_member(member_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="member session not found") from exc


@router.get("/v1/minecraft/members/{member_id}/observe", response_model=Observation)
async def observe(
    member_id: str,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Observation:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    return await observe_member(member_id)


@router.post("/v1/minecraft/members/{member_id}/actions", response_model=ActionResult)
async def act(
    member_id: str,
    body: MemberAction,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> ActionResult:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    try:
        return await act_member(
            member_id,
            ActionRequest(action=body.action, params=body.params, require_confirm=body.require_confirm),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="member session not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/v1/minecraft/members/{member_id}/cancel")
async def cancel(
    member_id: str,
    body: CancelRequest,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    try:
        return await cancel_member(member_id, body.target_request_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="member session not found") from exc
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/v1/minecraft/members/{member_id}/claims/revoke")
async def revoke_claim(
    member_id: str,
    body: ClaimRevoke,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    try:
        return await revoke_member_claim(member_id, body.pid, body.tid, body.gen, body.sig)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="member session not found") from exc
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/v1/minecraft/members/{member_id}/status")
async def status(
    member_id: str,
    x_gamebot_member_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _auth(x_gamebot_member_token)
    _check_id(member_id)
    return await status_member(member_id)
