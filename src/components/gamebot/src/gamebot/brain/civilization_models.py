"""文明6陪玩的接口模型。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class CompanionMessage(BaseModel):
    role: str
    text: str
    trigger: str = ""


class CompanionProposal(BaseModel):
    id: str
    tool: str
    arguments: Dict[str, Any] = Field(default_factory=dict)
    impact: str = ""
    fingerprint: str = ""
    status: str = "pending"
    result: str = ""


class CompanionStatus(BaseModel):
    ok: bool = True
    session_id: str
    running: bool = False
    busy: bool = False
    paused: bool = False
    panel_ready: bool = False
    enabled: bool = False
    model: str = ""
    fingerprint: str = ""
    last_error: Optional[str] = None
    last_text: Optional[str] = None
    messages: List[CompanionMessage] = Field(default_factory=list)
    proposals: List[CompanionProposal] = Field(default_factory=list)


class CompanionChatRequest(BaseModel):
    text: str


class CompanionProposalRequest(BaseModel):
    proposal_id: str


class CompanionTurnResult(BaseModel):
    ok: bool = True
    text: str = ""
    error: Optional[str] = None
    proposals: List[CompanionProposal] = Field(default_factory=list)
    executed: List[Dict[str, Any]] = Field(default_factory=list)
