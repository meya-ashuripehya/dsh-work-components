"""跨游戏契约：会话、观察、能力、动作。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class Vec3(BaseModel):
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


class NearbyPlayer(BaseModel):
    name: str
    distance: float = 0.0


class Capability(BaseModel):
    id: str
    available: bool = False
    reason: Optional[str] = None
    params_schema: Optional[Dict[str, Any]] = None


class Evidence(BaseModel):
    kind: str = "none"
    changed: Optional[bool] = None
    path_before: Optional[str] = None
    path_after: Optional[str] = None
    ocr_before: Optional[str] = None
    ocr_after: Optional[str] = None
    checksum_before: Optional[str] = None
    checksum_after: Optional[str] = None
    notes: Optional[str] = None


class Observation(BaseModel):
    game: str
    driver: str
    connected: bool = False
    connecting: bool = False
    username: Optional[str] = None
    position: Optional[Vec3] = None
    health: Optional[float] = None
    food: Optional[float] = None
    version: Optional[str] = None
    loader: Optional[str] = None
    mods: List[str] = Field(default_factory=list)
    online_players: List[str] = Field(default_factory=list)
    nearby_players: List[NearbyPlayer] = Field(default_factory=list)
    recent_events: List[Dict[str, Any]] = Field(default_factory=list)
    capabilities: List[Capability] = Field(default_factory=list)
    extras: Dict[str, Any] = Field(default_factory=dict)
    last_error: Optional[str] = None
    evidence: Optional[Evidence] = None

    def capability_map(self) -> Dict[str, Capability]:
        return {c.id: c for c in self.capabilities}

    def has_capability(self, cap_id: str) -> bool:
        cap = self.capability_map().get(cap_id)
        return bool(cap and cap.available)


class ActionRequest(BaseModel):
    action: str
    params: Dict[str, Any] = Field(default_factory=dict)
    require_confirm: bool = False


class ActionResult(BaseModel):
    ok: bool
    action: str
    sent: Optional[str] = None
    observation: Optional[Observation] = None
    error: Optional[str] = None
    degraded: bool = False
    degrade_reason: Optional[str] = None
    evidence: Optional[Evidence] = None
    extras: Dict[str, Any] = Field(default_factory=dict)


class ProbeResult(BaseModel):
    reachable: bool = False
    driver: str
    game: str
    version: Optional[str] = None
    loader: Optional[str] = None
    mods: List[str] = Field(default_factory=list)
    capabilities: List[Capability] = Field(default_factory=list)
    error: Optional[str] = None
    extras: Dict[str, Any] = Field(default_factory=dict)


class GameSession(BaseModel):
    id: str
    game: str
    driver: str
    config: Dict[str, Any] = Field(default_factory=dict)
    connected: bool = False


class CreateSessionRequest(BaseModel):
    game: str
    driver: str
    config: Dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = None


class CreateSessionResponse(BaseModel):
    ok: bool = True
    session: GameSession


class SessionListResponse(BaseModel):
    ok: bool = True
    sessions: List[GameSession]


class CapabilitiesResponse(BaseModel):
    ok: bool = True
    session_id: str
    capabilities: List[Capability]
    version: Optional[str] = None
    loader: Optional[str] = None
    mods: List[str] = Field(default_factory=list)


class EventsResponse(BaseModel):
    ok: bool = True
    events: List[Dict[str, Any]] = Field(default_factory=list)
