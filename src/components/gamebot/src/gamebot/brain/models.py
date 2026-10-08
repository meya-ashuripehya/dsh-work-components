"""LLM 决策契约：大脑只输出这些结构，执行层仍走语义动作。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from gamebot.contracts.models import ActionResult


class PlannedAction(BaseModel):
    action: str
    params: Dict[str, Any] = Field(default_factory=dict)


class Decision(BaseModel):
    reason: str = ""
    say: Optional[str] = None
    goal: Optional[str] = None
    mode: Optional[str] = None
    actions: List[PlannedAction] = Field(default_factory=list)
    wait: bool = False
    skip: bool = False
    stop_current: bool = True
    rejected_actions: List[PlannedAction] = Field(default_factory=list)
    memory_used: List[str] = Field(default_factory=list)


class BrainTaskRequest(BaseModel):
    goal: str
    max_steps: Optional[int] = None
    interrupt: bool = True
    execute: bool = True


class BrainDecideRequest(BaseModel):
    goal: Optional[str] = None
    player: Optional[str] = None
    message: Optional[str] = None


class BrainChatRequest(BaseModel):
    player: str
    message: str


class MemorySearchRequest(BaseModel):
    query: str = ""


class MemorySnapshot(BaseModel):
    ok: bool = True
    namespace: str = ""
    counts: Dict[str, int] = Field(default_factory=dict)
    recent_events: List[Dict[str, Any]] = Field(default_factory=list)
    nodes: List[Dict[str, Any]] = Field(default_factory=list)
    edges: List[Dict[str, Any]] = Field(default_factory=list)
    blocks: List[Dict[str, Any]] = Field(default_factory=list)
    unsealed: Dict[str, Any] = Field(default_factory=dict)
    text: str = ""
    evidence_ok: bool = True
    missing: List[str] = Field(default_factory=list)


class BrainTaskResult(BaseModel):
    ok: bool = True
    decision: Optional[Decision] = None
    results: List[ActionResult] = Field(default_factory=list)
    error: Optional[str] = None
    interrupted: bool = False
    executed: bool = False
    source: str = "task"


class BrainStatus(BaseModel):
    ok: bool = True
    session_id: str
    enabled: bool = False
    running: bool = False
    busy: bool = False
    provider: str = ""
    protocol: str = ""
    model: str = ""
    base_url: str = ""
    last_error: Optional[str] = None
    last_reason: Optional[str] = None
    last_source: Optional[str] = None
    current_goal: Optional[str] = None
    work_mode: str = "rest"
    last_chat_directive: Optional[str] = None
    chat_provider: str = ""
    chat_protocol: str = ""
    chat_model: str = ""
    memory_enabled: bool = False
    memory_namespace: str = ""
    memory_turns: int = 0
    memory_events: int = 0
