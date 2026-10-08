"""Mineflayer HTTP 后端：对接外部 minecraft-bridge（不随插件提供，见 bridge_process.py）。"""
from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from gamebot.contracts.models import ActionRequest, ActionResult, NearbyPlayer, ProbeResult, Vec3

_TIMEOUT = 12.0


class MineflayerBackend:
    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config

    def _base(self) -> str:
        url = str(self.config.get("MC_BRIDGE_URL") or "").strip()
        if url:
            return url.rstrip("/")
        port = str(self.config.get("MC_BRIDGE_PORT") or "3100").strip()
        return f"http://127.0.0.1:{port}"

    async def _request(self, method: str, path: str, json_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self._base()}{path}"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                if method.upper() == "GET":
                    r = await client.get(url)
                else:
                    r = await client.post(url, json=json_body or {})
            try:
                data = r.json()
            except Exception:
                data = {"ok": False, "error": (r.text or "")[:300]}
            if not isinstance(data, dict):
                return {"ok": r.status_code < 400, "data": data}
            if r.status_code >= 400 and "ok" not in data:
                data["ok"] = False
            return data
        except httpx.ConnectError:
            return {
                "ok": False,
                "connected": False,
                "serviceRunning": False,
                "error": "Mineflayer bridge is not running; start minecraft-bridge (npm install && node server.js)",
                "unavailable": True,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def probe(self) -> ProbeResult:
        data = await self._request("GET", "/health")
        reachable = bool(data.get("ok") or data.get("status") == "ok")
        if not reachable and not data.get("unavailable"):
            # some bridges only have /status
            st = await self._request("GET", "/status")
            reachable = "error" not in st or st.get("serviceRunning") is True or st.get("ok") is True
            data = st
        return ProbeResult(
            reachable=reachable,
            driver="mineflayer",
            game="minecraft",
            version=str(self.config.get("MC_VERSION") or data.get("version") or "") or None,
            loader="vanilla",
            error=None if reachable else str(data.get("error") or "bridge unreachable"),
            extras={"bridge": data},
        )

    def parse_status(self, data: Dict[str, Any]) -> Dict[str, Any]:
        pos_raw = data.get("position") or {}
        position = None
        if isinstance(pos_raw, dict) and pos_raw.get("x") is not None:
            position = Vec3(x=float(pos_raw["x"]), y=float(pos_raw.get("y") or 0), z=float(pos_raw.get("z") or 0))
        nearby = []
        for p in data.get("nearbyPlayers") or data.get("nearby_players") or []:
            if isinstance(p, dict) and p.get("name"):
                nearby.append(NearbyPlayer(name=str(p["name"]), distance=float(p.get("distance") or 0)))
        mods = data.get("mods") or []
        if isinstance(mods, str):
            mods = [m.strip() for m in mods.split(",") if m.strip()]
        advertised = data.get("capabilities") or data.get("capabilityIds") or []
        if advertised and isinstance(advertised[0], dict):
            advertised = [str(c.get("id")) for c in advertised if c.get("id")]
        return {
            "connected": bool(data.get("connected")),
            "connecting": bool(data.get("connecting")),
            "username": data.get("username"),
            "position": position,
            "health": float(data["health"]) if data.get("health") is not None else None,
            "food": float(data["food"]) if data.get("food") is not None else None,
            "online_players": list(data.get("onlinePlayers") or data.get("online_players") or []),
            "nearby_players": nearby,
            "recent_events": list(data.get("recentEvents") or data.get("recent_events") or []),
            "last_error": data.get("lastKickReason") or data.get("lastError") or data.get("error"),
            "version": data.get("version") or self.config.get("MC_VERSION"),
            "loader": data.get("loader") or "vanilla",
            "mods": list(mods),
            "advertised": [str(a) for a in advertised],
            "inventory": data.get("inventory") or {},
            "service_running": data.get("serviceRunning"),
            "unavailable": bool(data.get("unavailable")),
            "raw": data,
        }

    async def status(self) -> Dict[str, Any]:
        data = await self._request("GET", "/status")
        return self.parse_status(data)

    async def connect(self) -> Dict[str, Any]:
        body = {
            "host": self.config.get("MC_HOST") or "127.0.0.1",
            "port": int(self.config.get("MC_PORT") or 25565),
            "username": self.config.get("MC_USERNAME") or "Player",
            "version": self.config.get("MC_VERSION") or "1.21.1",
            "auth": self.config.get("MC_AUTH") or "offline",
        }
        data = await self._request("POST", "/connect", body)
        if data.get("unavailable"):
            return self.parse_status(data)
        return self.parse_status(data if data.get("connected") is not None else await self._request("GET", "/status"))

    async def disconnect(self) -> Dict[str, Any]:
        data = await self._request("POST", "/disconnect")
        merged = await self._request("GET", "/status")
        if merged.get("unavailable") and data:
            merged = data
        return self.parse_status(merged)

    async def act(self, request: ActionRequest) -> ActionResult:
        action = request.action
        params = dict(request.params or {})
        if action == "say":
            text = str(params.get("text") or "").strip()
            if not text:
                return ActionResult(ok=False, action=action, error="text is required")
            data = await self._request("POST", "/say", {"text": text})
            ok = bool(data.get("ok", True)) and not data.get("error")
            return ActionResult(ok=ok, action=action, sent=data.get("sent") or text, error=data.get("error"), extras=data)
        if action == "run_command":
            cmd = str(params.get("command") or params.get("text") or "").strip()
            data = await self._request("POST", "/command", {"command": cmd})
            ok = bool(data.get("ok", True)) and not data.get("error")
            sent = data.get("sent") or (cmd if cmd.startswith("/") else f"/{cmd}")
            return ActionResult(ok=ok, action=action, sent=sent, error=data.get("error"), extras=data)
        data = await self._request("POST", "/action", {"action": action, "params": params})
        if data.get("unavailable"):
            return ActionResult(
                ok=False,
                action=action,
                error=data.get("error") or "Mineflayer bridge is not running",
                degraded=True,
                degrade_reason="minecraft-bridge missing or not started",
            )
        ok = bool(data.get("ok", False))
        return ActionResult(
            ok=ok,
            action=action,
            sent=data.get("sent"),
            error=None if ok else (data.get("error") or "action failed"),
            extras=data,
        )
