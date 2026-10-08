"""通用游戏驱动接口。下层 IO 适配器实现本接口，上层不理解版本细节。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List

from gamebot.contracts.models import ActionRequest, ActionResult, Observation, ProbeResult


class GameDriver(ABC):
    game: str
    driver_id: str

    @abstractmethod
    async def probe(self) -> ProbeResult:
        raise NotImplementedError

    @abstractmethod
    async def connect(self) -> Observation:
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self) -> Observation:
        raise NotImplementedError

    @abstractmethod
    async def observe(self) -> Observation:
        raise NotImplementedError

    @abstractmethod
    async def act(self, request: ActionRequest) -> ActionResult:
        raise NotImplementedError

    async def stream_events(self) -> List[Dict[str, Any]]:
        """拉取最近事件（同步快照，不阻塞长连接）。"""
        obs = await self.observe()
        return list(obs.recent_events)
