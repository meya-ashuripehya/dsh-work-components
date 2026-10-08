"""会话管理：创建驱动实例、连接、观察、执行动作。"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from gamebot.brain.civilization import CivilizationCompanion
from gamebot.brain.service import BrainService
from gamebot.contracts.models import (
    ActionRequest,
    ActionResult,
    GameSession,
    Observation,
    ProbeResult,
)
from gamebot.drivers.base import GameDriver
from gamebot.registry import create_driver, normalize_driver
from gamebot.router import gate_action


class SessionRecord:
    def __init__(self, session: GameSession, driver: GameDriver, manager: "SessionManager") -> None:
        self.session = session
        self.driver = driver
        self.last_observation: Optional[Observation] = None
        self.brain = BrainService(session.id, manager)
        self.companion: Optional[CivilizationCompanion] = None
        if session.driver == "civ6_mcp":
            self.companion = CivilizationCompanion(session.id, manager)


class SessionManager:
    def __init__(self) -> None:
        self._sessions: Dict[str, SessionRecord] = {}

    def list_sessions(self) -> List[GameSession]:
        return [r.session for r in self._sessions.values()]

    def get(self, session_id: str) -> SessionRecord:
        rec = self._sessions.get(session_id)
        if rec is None:
            raise KeyError(session_id)
        return rec

    def create(
        self,
        game: str,
        driver: str,
        config: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> GameSession:
        sid = (session_id or "").strip() or uuid.uuid4().hex[:12]
        if sid in self._sessions:
            raise ValueError(f"session {sid} already exists")
        kind = normalize_driver(game, driver)
        impl = create_driver(game, kind, config or {})
        session = GameSession(id=sid, game=game, driver=kind, config=dict(config or {}))
        rec = SessionRecord(session, impl, self)
        self._sessions[sid] = rec
        rec.brain.attach_driver()
        return session

    def upsert(
        self,
        game: str,
        driver: str,
        config: Optional[Dict[str, Any]] = None,
        session_id: Optional[str] = None,
    ) -> GameSession:
        sid = (session_id or "").strip()
        if sid and sid in self._sessions:
            rec = self._sessions[sid]
            rec.session.config = dict(config or rec.session.config)
            rec.session.game = game
            rec.session.driver = normalize_driver(game, driver)
            rec.brain.shutdown_now()
            if rec.companion is not None:
                rec.companion.shutdown_now()
            rec.driver = create_driver(game, rec.session.driver, rec.session.config)
            rec.last_observation = None
            rec.session.connected = False
            rec.companion = (
                CivilizationCompanion(rec.session.id, self) if rec.session.driver == "civ6_mcp" else None
            )
            rec.brain.attach_driver()
            return rec.session
        return self.create(game, driver, config, session_id=sid or None)

    def delete(self, session_id: str) -> None:
        rec = self._sessions.get(session_id)
        if rec is None:
            raise KeyError(session_id)
        rec.brain.shutdown_now()
        if rec.companion is not None:
            rec.companion.shutdown_now()
        self._sessions.pop(session_id, None)

    async def probe(self, session_id: str) -> ProbeResult:
        return await self.get(session_id).driver.probe()

    async def connect(self, session_id: str) -> Observation:
        rec = self.get(session_id)
        obs = await rec.driver.connect()
        rec.last_observation = obs
        rec.session.connected = obs.connected
        rec.brain.start()
        if rec.companion is not None:
            rec.companion.start()
        return obs

    async def disconnect(self, session_id: str) -> Observation:
        rec = self.get(session_id)
        rec.brain.shutdown_now()
        if rec.companion is not None:
            rec.companion.shutdown_now()
        obs = await rec.driver.disconnect()
        rec.last_observation = obs
        rec.session.connected = obs.connected
        return obs

    async def observe(self, session_id: str) -> Observation:
        rec = self.get(session_id)
        obs = await rec.driver.observe()
        rec.last_observation = obs
        rec.session.connected = obs.connected
        return obs

    async def act(self, session_id: str, request: ActionRequest) -> ActionResult:
        rec = self.get(session_id)
        obs = rec.last_observation or await rec.driver.observe()
        blocked = gate_action(obs, request)
        if blocked is not None:
            return blocked
        result = await rec.driver.act(request)
        if result.observation is not None:
            rec.last_observation = result.observation
            rec.session.connected = result.observation.connected
        return result

    async def events(self, session_id: str) -> List[Dict[str, Any]]:
        rec = self.get(session_id)
        return await rec.driver.stream_events()


manager = SessionManager()
