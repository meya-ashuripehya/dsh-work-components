"""Minecraft 领域适配器：Minaret / Mineflayer 后端 + Provider 能力清单。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from gamebot.adapters.minecraft.minaret import MinaretBackend
from gamebot.adapters.minecraft.mineflayer import MineflayerBackend
from gamebot.adapters.minecraft.providers import ProviderBundle
from gamebot.contracts.models import ActionRequest, ActionResult, Observation, ProbeResult
from gamebot.drivers.base import GameDriver


class MinecraftAdapter(GameDriver):
    game = "minecraft"

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = dict(config or {})
        backend = str(self.config.get("backend") or self.config.get("MC_DRIVER") or "minaret").strip().lower()
        if backend in ("neoforge", "neoforge_ws", "minaret", "ws"):
            self.driver_id = "minaret"
            self._minaret: Optional[MinaretBackend] = MinaretBackend(self.config)
            self._mineflayer: Optional[MineflayerBackend] = None
        else:
            self.driver_id = "mineflayer"
            self._minaret = None
            self._mineflayer = MineflayerBackend(self.config)
        self._last_obs: Optional[Observation] = None
        self._chat_handler = None

    def set_chat_handler(self, handler) -> None:
        self._chat_handler = handler
        if self._minaret is not None:
            self._minaret.set_chat_handler(handler)

    def _bundle_from_minaret(self, fields: Dict[str, Any]) -> ProviderBundle:
        return ProviderBundle(
            backend="minaret",
            connected=bool(fields.get("connected")),
            version=fields.get("version"),
            loader=fields.get("loader") or "neoforge",
            mods=fields.get("mods") or [],
            advertised=fields.get("advertised") or [],
            mineflayer_ready=False,
            position_known=fields.get("position") is not None,
            health_known=fields.get("health") is not None,
            inventory_known=bool(fields.get("minecraft")),
            block_scan_known=bool(fields.get("block_scan_known")),
            entity_nearby_known=bool(fields.get("entity_nearby_known")),
        )

    def _bundle_from_mf(self, fields: Dict[str, Any]) -> ProviderBundle:
        ready = bool(fields.get("connected")) and not fields.get("unavailable")
        return ProviderBundle(
            backend="mineflayer",
            connected=ready,
            version=fields.get("version"),
            loader=fields.get("loader") or "vanilla",
            mods=fields.get("mods") or [],
            advertised=fields.get("advertised") or [],
            mineflayer_ready=ready,
            position_known=fields.get("position") is not None,
            health_known=fields.get("health") is not None,
        )

    def actor_binding(self) -> Dict[str, Any]:
        if self._minaret is None:
            return {"actor_type": "local_player", "agent_id": None, "username": None}
        return self._minaret.actor_binding()

    def set_actor_goal(self, goal: Optional[str]) -> None:
        if self._minaret is not None:
            self._minaret.set_actor_goal(goal)

    def _obs_minaret(self) -> Observation:
        assert self._minaret is not None
        f = self._minaret.snapshot_fields()
        bundle = self._bundle_from_minaret(f)
        extras = {
            "legacy": {
                "ok": True,
                "driver": "neoforge_ws",
                "connected": f["connected"],
                "connecting": f["connecting"],
                "userWantsConnected": f["user_wants_connected"],
                "serviceRunning": f["connected"],
                "wsUrl": f["ws_url"],
                "username": f["username"],
                "host": f["ws_url"],
                "onlinePlayers": f["online_players"],
                "recentEvents": f["recent_events"],
                "lastError": f["last_error"],
            },
            "inventory": f.get("inventory") or {},
        }
        if f.get("item_search"):
            extras["item_search"] = f["item_search"]
        if f.get("last_action"):
            extras["last_action"] = f["last_action"]
        if f.get("actor_type"):
            extras["actor_type"] = f["actor_type"]
        if f.get("agent_id"):
            extras["agent_id"] = f["agent_id"]
        if f.get("minecraft"):
            extras["minecraft"] = f["minecraft"]
        return Observation(
            game=self.game,
            driver=self.driver_id,
            connected=bool(f["connected"]),
            connecting=bool(f["connecting"]),
            username=f.get("username"),
            position=f.get("position"),
            health=f.get("health"),
            food=f.get("food"),
            version=f.get("version"),
            loader=f.get("loader"),
            mods=list(f.get("mods") or []),
            online_players=list(f.get("online_players") or []),
            nearby_players=list(f.get("nearby_players") or []),
            recent_events=list(f.get("recent_events") or []),
            capabilities=bundle.capabilities(),
            extras=extras,
            last_error=f.get("last_error"),
        )

    def _obs_mf(self, fields: Dict[str, Any]) -> Observation:
        bundle = self._bundle_from_mf(fields)
        raw = fields.get("raw") or {}
        extras = {
            "legacy": {
                "ok": not fields.get("unavailable"),
                "driver": "mineflayer",
                "connected": fields.get("connected"),
                "connecting": fields.get("connecting"),
                "serviceRunning": fields.get("service_running"),
                "username": fields.get("username"),
                "position": fields["position"].model_dump() if fields.get("position") else None,
                "health": fields.get("health"),
                "food": fields.get("food"),
                "onlinePlayers": fields.get("online_players"),
                "nearbyPlayers": [p.model_dump() for p in fields.get("nearby_players") or []],
                "lastKickReason": raw.get("lastKickReason"),
                "lastError": fields.get("last_error"),
                "error": fields.get("last_error"),
                "version": fields.get("version"),
            },
            "inventory": fields.get("inventory") or {},
            "bridge_unavailable": bool(fields.get("unavailable")),
        }
        return Observation(
            game=self.game,
            driver=self.driver_id,
            connected=bool(fields.get("connected")) and not fields.get("unavailable"),
            connecting=bool(fields.get("connecting")),
            username=fields.get("username"),
            position=fields.get("position"),
            health=fields.get("health"),
            food=fields.get("food"),
            version=fields.get("version"),
            loader=fields.get("loader") or "vanilla",
            mods=list(fields.get("mods") or []),
            online_players=list(fields.get("online_players") or []),
            nearby_players=list(fields.get("nearby_players") or []),
            recent_events=list(fields.get("recent_events") or []),
            capabilities=bundle.capabilities(),
            extras=extras,
            last_error=fields.get("last_error"),
        )

    async def probe(self) -> ProbeResult:
        if self._minaret is not None:
            return await self._minaret.probe()
        assert self._mineflayer is not None
        return await self._mineflayer.probe()

    async def connect(self) -> Observation:
        if self._minaret is not None:
            await self._minaret.connect()
            obs = self._obs_minaret()
            self._last_obs = obs
            return obs
        assert self._mineflayer is not None
        fields = await self._mineflayer.connect()
        obs = self._obs_mf(fields)
        self._last_obs = obs
        return obs

    async def disconnect(self) -> Observation:
        if self._minaret is not None:
            await self._minaret.disconnect()
            obs = self._obs_minaret()
            self._last_obs = obs
            return obs
        assert self._mineflayer is not None
        fields = await self._mineflayer.disconnect()
        obs = self._obs_mf(fields)
        self._last_obs = obs
        return obs

    async def observe(self) -> Observation:
        if self._minaret is not None:
            obs = self._obs_minaret()
            self._last_obs = obs
            return obs
        assert self._mineflayer is not None
        fields = await self._mineflayer.status()
        obs = self._obs_mf(fields)
        self._last_obs = obs
        return obs

    async def act(self, request: ActionRequest) -> ActionResult:
        if request.action == "query_state":
            obs = await self.observe()
            return ActionResult(ok=True, action=request.action, observation=obs)
        if self._minaret is not None:
            result = await self._minaret.act(request)
            result.observation = self._obs_minaret()
            return result
        assert self._mineflayer is not None
        result = await self._mineflayer.act(request)
        fields = await self._mineflayer.status()
        result.observation = self._obs_mf(fields)
        return result

    async def stream_events(self) -> List[Dict[str, Any]]:
        obs = await self.observe()
        return list(obs.recent_events)
