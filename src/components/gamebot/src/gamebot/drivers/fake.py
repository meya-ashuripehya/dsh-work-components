"""契约测试用假驱动：内存状态，不连接真实游戏。"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional, Set

from gamebot.contracts import capabilities as caps
from gamebot.contracts.models import (
    ActionRequest,
    ActionResult,
    Capability,
    NearbyPlayer,
    Observation,
    ProbeResult,
    Vec3,
)
from gamebot.drivers.base import GameDriver

_ALL_FAKE_CAPS = [
    caps.STATE_QUERY,
    caps.CHAT_SAY,
    caps.SERVER_COMMAND,
    caps.POSITION_READ,
    caps.HEALTH_READ,
    caps.INVENTORY_READ,
    caps.BLOCK_SCAN,
    caps.RECIPE_QUERY,
    caps.ENTITY_NEARBY,
    caps.MOVE_TO,
    caps.LOOK_AT,
    caps.COLLECT,
    caps.CRAFT,
    caps.PLACE_BLOCK,
    caps.INTERACT,
    caps.OPEN_CONTAINER,
    caps.TRANSFER_ITEM,
]


class FakeDriver(GameDriver):
    game = "fake"
    driver_id = "fake"

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or {}
        enabled = self.config.get("capabilities")
        if enabled is None:
            self._enabled: Set[str] = set(_ALL_FAKE_CAPS)
        else:
            self._enabled = set(enabled)
        self._connected = False
        self._connecting = False
        self._username = str(self.config.get("username") or "FakeBot")
        self._position = Vec3(x=0, y=64, z=0)
        self._health = 20.0
        self._inventory: Dict[str, int] = {"oak_log": 4, "stick": 2}
        self._events: List[Dict[str, Any]] = []
        self._last_error: Optional[str] = None
        self._looking_at: Optional[Vec3] = None

    def _cap_list(self, connected: bool) -> List[Capability]:
        out: List[Capability] = []
        for cap_id in _ALL_FAKE_CAPS:
            available = cap_id in self._enabled
            reason = None
            if not available:
                reason = f"capability {cap_id} disabled in fake config"
            elif cap_id != caps.STATE_QUERY and not connected:
                available = False
                reason = "not connected"
            out.append(Capability(id=cap_id, available=available, reason=reason))
        return out

    def _obs(self) -> Observation:
        return Observation(
            game=self.game,
            driver=self.driver_id,
            connected=self._connected,
            connecting=self._connecting,
            username=self._username,
            position=self._position if self._connected else None,
            health=self._health if self._connected else None,
            food=20.0 if self._connected else None,
            version=str(self.config.get("version") or "fake-1.0"),
            loader=str(self.config.get("loader") or "fake"),
            mods=list(self.config.get("mods") or []),
            online_players=[self._username] if self._connected else [],
            nearby_players=[NearbyPlayer(name="Steve", distance=3.0)] if self._connected else [],
            recent_events=list(self._events[-10:]),
            capabilities=self._cap_list(self._connected),
            extras={"inventory": dict(self._inventory)} if self._connected else {},
            last_error=self._last_error,
        )

    def _push(self, event_type: str, **data: Any) -> None:
        entry = {"type": event_type, "at": time.time(), **data}
        self._events.append(entry)
        if len(self._events) > 50:
            del self._events[: len(self._events) - 50]

    async def probe(self) -> ProbeResult:
        return ProbeResult(
            reachable=True,
            driver=self.driver_id,
            game=self.game,
            version=str(self.config.get("version") or "fake-1.0"),
            loader="fake",
            mods=list(self.config.get("mods") or []),
            capabilities=self._cap_list(connected=False),
        )

    async def connect(self) -> Observation:
        self._connecting = True
        self._connected = True
        self._connecting = False
        self._last_error = None
        self._push("system", text="connected")
        return self._obs()

    async def disconnect(self) -> Observation:
        self._connected = False
        self._connecting = False
        self._push("system", text="disconnected")
        return self._obs()

    async def observe(self) -> Observation:
        return self._obs()

    async def act(self, request: ActionRequest) -> ActionResult:
        action = (request.action or "").strip()
        params = request.params or {}
        if action == "query_state":
            return ActionResult(ok=True, action=action, observation=self._obs())
        if not self._connected:
            return ActionResult(ok=False, action=action, error="not connected", observation=self._obs())

        delay = 0.0
        try:
            delay = float(self.config.get("action_delay_s") or 0)
        except (TypeError, ValueError):
            delay = 0.0
        if delay > 0:
            await asyncio.sleep(delay)

        if action == "say":
            text = str(params.get("text") or "").strip()
            if not text:
                return ActionResult(ok=False, action=action, error="text is required")
            self._push("chat_out", text=text)
            return ActionResult(ok=True, action=action, sent=text, observation=self._obs())

        if action == "run_command":
            cmd = str(params.get("command") or params.get("text") or "").strip()
            if cmd.startswith("/"):
                cmd = cmd[1:]
            if not cmd:
                return ActionResult(ok=False, action=action, error="command is empty")
            sent = f"/{cmd}"
            self._push("command", text=sent)
            return ActionResult(ok=True, action=action, sent=sent, observation=self._obs())

        if action == "move_to":
            self._position = Vec3(
                x=float(params.get("x", self._position.x)),
                y=float(params.get("y", self._position.y)),
                z=float(params.get("z", self._position.z)),
            )
            self._push("move", position=self._position.model_dump())
            return ActionResult(ok=True, action=action, sent="moved", observation=self._obs())

        if action == "look_at":
            self._looking_at = Vec3(
                x=float(params.get("x", 0)),
                y=float(params.get("y", 0)),
                z=float(params.get("z", 0)),
            )
            return ActionResult(ok=True, action=action, sent="looked", observation=self._obs())

        if action == "collect":
            item = str(params.get("item_tag") or params.get("item") or "oak_log")
            count = int(params.get("count") or 1)
            key = "oak_log" if item in ("#minecraft:logs", "logs") else item.lstrip("#")
            self._inventory[key] = self._inventory.get(key, 0) + count
            return ActionResult(ok=True, action=action, sent=f"collected {count} {key}", observation=self._obs())

        if action == "craft":
            item_id = str(params.get("item_id") or params.get("item") or "")
            count = int(params.get("count") or 1)
            if not item_id:
                return ActionResult(ok=False, action=action, error="item_id is required")
            self._inventory[item_id] = self._inventory.get(item_id, 0) + count
            return ActionResult(ok=True, action=action, sent=f"crafted {count} {item_id}", observation=self._obs())

        if action == "place_block":
            block_id = str(params.get("block_id") or params.get("block") or "")
            if not block_id:
                return ActionResult(ok=False, action=action, error="block_id is required")
            return ActionResult(ok=True, action=action, sent=f"placed {block_id}", observation=self._obs())

        if action in ("interact", "open_container"):
            return ActionResult(ok=True, action=action, sent=action, observation=self._obs())

        if action == "transfer_item":
            item = str(params.get("item") or "")
            count = int(params.get("count") or 1)
            if not item:
                return ActionResult(ok=False, action=action, error="item is required")
            have = self._inventory.get(item, 0)
            if have < count:
                return ActionResult(ok=False, action=action, error="not enough items", observation=self._obs())
            self._inventory[item] = have - count
            return ActionResult(ok=True, action=action, sent=f"transferred {count} {item}", observation=self._obs())

        return ActionResult(ok=False, action=action, error=f"unknown action {action}", observation=self._obs())
