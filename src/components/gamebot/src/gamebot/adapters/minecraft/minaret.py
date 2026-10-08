"""NeoForge Minaret WebSocket 后端。"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Dict, List, Optional, Set

import websockets
from websockets.client import WebSocketClientProtocol

from gamebot.adapters.minecraft.protocol import apply_presence_event, extract_handshake, parse_incoming_chat
from gamebot.adapters.minecraft.wire import (
    WireError,
    action_timeout_seconds,
    build_action_request,
    build_cancel,
    build_hello,
    normalize_activity,
    normalize_snapshot,
    parse_action_result,
    validate_action_params,
)
from gamebot.contracts.models import ActionRequest, ActionResult, NearbyPlayer, ProbeResult, Vec3

_WS_TIMEOUT = 3.0
_PROTECTED_EVENTS = {"action_result", "error", "auth_failed"}


class MinaretBackend:
    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self._lock = asyncio.Lock()
        self._ws: Optional[WebSocketClientProtocol] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._user_wants_connected = False
        self._connecting = False
        self._last_error: Optional[str] = None
        self._online_players: Set[str] = set()
        self._recent_events: List[Dict[str, Any]] = []
        self._version: Optional[str] = None
        self._loader: Optional[str] = "neoforge"
        self._mods: List[str] = []
        self._advertised: List[str] = []
        self._position: Optional[Vec3] = None
        self._health: Optional[float] = None
        self._food: Optional[float] = None
        self._inventory: Dict[str, int] = {}
        self._nearby_players: List[NearbyPlayer] = []
        self._minecraft: Dict[str, Any] = {}
        self._item_search: Optional[Dict[str, Any]] = None
        self._item_search_pending = False
        self._last_action: Optional[Dict[str, Any]] = None
        self._last_action_pending = False
        self._actor_type = "local_player"
        self._agent_id: Optional[str] = None
        self._agent_name: Optional[str] = None
        self._actor_goal: Optional[str] = None
        self._block_scan_known = False
        self._entity_nearby_known = False
        self._on_chat = None
        self._sequence = 0
        self._pending: Dict[str, asyncio.Future] = {}

    def _ws_url(self) -> str:
        return str(self.config.get("NEOFORGE_WS_URL") or self.config.get("ws_url") or "ws://127.0.0.1:8765").strip()

    def _bot_name(self) -> str:
        return str(self.config.get("MC_USERNAME") or self.config.get("username") or "Shiro").strip()

    def _headers(self) -> Optional[Dict[str, str]]:
        user = str(self.config.get("NEOFORGE_WS_AUTH_USER") or self.config.get("ws_user") or "").strip()
        password = str(self.config.get("NEOFORGE_WS_AUTH_PASS") or self.config.get("ws_pass") or "").strip()
        if not user:
            return None
        token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}"}

    def _next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    def _push(self, entry: Dict[str, Any]) -> None:
        self._recent_events.append(entry)
        while len(self._recent_events) > 50:
            drop_at = next(
                (
                    index
                    for index, item in enumerate(self._recent_events)
                    if str(item.get("type") or "") not in _PROTECTED_EVENTS
                ),
                None,
            )
            if drop_at is None:
                break
            del self._recent_events[drop_at]

    def _fail_pending(self, code: str, message: str) -> None:
        pending = list(self._pending.items())
        self._pending.clear()
        self._item_search = None
        self._item_search_pending = False
        self._last_action = None
        self._last_action_pending = False
        for _request_id, future in pending:
            if not future.done():
                future.set_result(
                    {
                        "ok": False,
                        "action": "",
                        "effect": "failed",
                        "error": message,
                        "error_code": code,
                        "sent": None,
                        "evidence": {},
                    }
                )

    def set_chat_handler(self, handler) -> None:
        self._on_chat = handler

    def set_actor_goal(self, goal: Optional[str]) -> None:
        text = (goal or "").strip()
        self._actor_goal = text[:200] if text else None

    def actor_binding(self) -> Dict[str, Any]:
        return {
            "actor_type": self._actor_type,
            "agent_id": self._agent_id,
            "username": self._agent_name or self._bot_name(),
        }

    def snapshot_fields(self) -> Dict[str, Any]:
        connected = self._ws is not None and not self._ws.closed
        username = self._agent_name if self._actor_type == "server_npc" and self._agent_name else self._bot_name()
        return {
            "connected": connected,
            "connecting": self._connecting,
            "username": username,
            "online_players": sorted(self._online_players),
            "nearby_players": list(self._nearby_players),
            "recent_events": list(self._recent_events[-10:]),
            "last_error": self._last_error,
            "version": self._version or str(self.config.get("MC_VERSION") or "") or None,
            "loader": self._loader,
            "mods": list(self._mods),
            "advertised": list(self._advertised),
            "position": self._position,
            "health": self._health,
            "food": self._food,
            "inventory": dict(self._inventory),
            "minecraft": dict(self._minecraft),
            "item_search": self._take_item_search(),
            "last_action": self._take_last_action(),
            "actor_type": self._actor_type,
            "agent_id": self._agent_id,
            "block_scan_known": self._block_scan_known,
            "entity_nearby_known": self._entity_nearby_known,
            "ws_url": self._ws_url(),
            "user_wants_connected": self._user_wants_connected,
        }

    def _take_item_search(self) -> Optional[Dict[str, Any]]:
        if not self._item_search_pending or self._item_search is None:
            return None
        self._item_search_pending = False
        return dict(self._item_search)

    def _take_last_action(self) -> Optional[Dict[str, Any]]:
        if not self._last_action_pending or self._last_action is None:
            return None
        self._last_action_pending = False
        return dict(self._last_action)

    def _capture_actor(self, payload: Dict[str, Any]) -> None:
        view = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        if not isinstance(view, dict):
            return
        if view.get("actor_type"):
            self._actor_type = str(view.get("actor_type"))
        agent_id = view.get("agent_id")
        if agent_id:
            new_id = str(agent_id)
            if self._agent_id and new_id != self._agent_id:
                self._last_action = None
                self._last_action_pending = False
            self._agent_id = new_id
        if self._actor_type == "server_npc" and view.get("username"):
            self._agent_name = str(view.get("username"))

    async def probe(self) -> ProbeResult:
        url = self._ws_url()
        headers = self._headers()
        try:
            ws = await asyncio.wait_for(
                websockets.connect(
                    url,
                    extra_headers=headers,
                    ping_interval=None,
                    close_timeout=2,
                    open_timeout=_WS_TIMEOUT,
                ),
                timeout=_WS_TIMEOUT,
            )
            await ws.close()
            return ProbeResult(
                reachable=True,
                driver="minaret",
                game="minecraft",
                version=self._version,
                loader=self._loader,
                mods=list(self._mods),
            )
        except Exception as e:
            return ProbeResult(
                reachable=False,
                driver="minaret",
                game="minecraft",
                loader=self._loader,
                error=str(e),
            )

    def _apply_handshake(self, data: Dict[str, Any]) -> None:
        hs = extract_handshake(data)
        if hs.get("version"):
            self._version = str(hs["version"])
        if hs.get("loader"):
            self._loader = str(hs["loader"])
        if hs.get("mods"):
            self._mods = list(hs["mods"])
        if hs.get("raw_capabilities"):
            self._advertised = list(hs["raw_capabilities"])
        if hs.get("position"):
            point = hs["position"]
            self._position = Vec3(x=point["x"], y=point["y"], z=point["z"])
        if hs.get("health") is not None:
            self._health = float(hs["health"])

    def _apply_snapshot(self, data: Dict[str, Any]) -> None:
        try:
            snapshot = normalize_snapshot(data)
        except WireError as exc:
            self._last_error = exc.message
            return
        self._minecraft = snapshot
        self._block_scan_known = True
        self._entity_nearby_known = True
        player = snapshot["player"]
        point = player["position"]
        self._position = Vec3(x=point["x"], y=point["y"], z=point["z"])
        if player.get("health") is not None:
            self._health = float(player["health"])
        if player.get("food") is not None:
            self._food = float(player["food"])
        self._inventory = dict(snapshot["inventory"].get("counts") or {})
        self._nearby_players = [
            NearbyPlayer(name=item["name"], distance=float(item.get("distance") or 0))
            for item in snapshot["nearby_players"]
        ]
        for item in snapshot["nearby_players"]:
            if item.get("name"):
                self._online_players.add(str(item["name"]))
        self._capture_actor({"data": snapshot})

    async def _handle_event(self, data: Dict[str, Any]) -> None:
        event = str(data.get("event") or data.get("type") or "message").strip()
        self._push({"type": event, "data": data, "at": time.time()})
        apply_presence_event(data, self._online_players)
        if event == "snapshot":
            self._apply_snapshot(data)
        elif event == "player_activity":
            activity = normalize_activity(data)
            self._push({"type": "player_activity", "data": activity, "at": time.time()})
        elif event == "action_result":
            result = parse_action_result(data)
            if result.get("action") == "find_item" and result.get("ok"):
                evidence = result.get("evidence") if isinstance(result.get("evidence"), dict) else {}
                self._item_search = {
                    "item_id": evidence.get("item_id"),
                    "radius": evidence.get("radius"),
                    "source": evidence.get("source"),
                    "truncated": bool(evidence.get("truncated")),
                    "matches": evidence.get("matches") if isinstance(evidence.get("matches"), list) else [],
                }
                self._item_search_pending = True
            request_id = str(result.get("request_id") or "")
            self._last_action = {
                "request_id": request_id,
                "action": result.get("action"),
                "ok": bool(result.get("ok")),
                "effect": result.get("effect"),
                "error_code": result.get("error_code"),
            }
            self._last_action_pending = True
            future = self._pending.pop(request_id, None)
            if future is not None and not future.done():
                future.set_result(result)
        elif event == "error":
            message = data.get("data") if isinstance(data.get("data"), dict) else data
            self._last_error = str((message or {}).get("error") or (message or {}).get("message") or "bridge error")
        else:
            self._capture_actor(data)
            self._apply_handshake(data)
        chat = parse_incoming_chat(data, self._bot_name())
        if chat:
            asyncio.create_task(self._emit_chat(chat[0], chat[1]))

    async def _emit_chat(self, player: str, message: str) -> None:
        handler = self._on_chat
        if handler is None:
            return
        result = handler(player, message)
        if asyncio.iscoroutine(result):
            await result

    async def _listen_loop(self, ws: WebSocketClientProtocol) -> None:
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="ignore")
                text = (raw or "").strip()
                if not text:
                    continue
                if len(text) > 1_048_576:
                    self._last_error = "inbound message exceeds 1 MiB"
                    continue
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(data, dict):
                    await self._handle_event(data)
                elif isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            await self._handle_event(item)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._last_error = str(e)
            self._push({"type": "system", "text": f"listen ended: {e}", "at": time.time()})
        finally:
            self._fail_pending("not_connected", "Minaret WebSocket closed")

    async def _connect_once(self) -> bool:
        if self._ws is not None and not self._ws.closed:
            return True
        url = self._ws_url()
        headers = self._headers()
        self._connecting = True
        self._last_error = None
        try:
            ws = await websockets.connect(
                url,
                extra_headers=headers,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
            )
            self._ws = ws
            self._listen_task = asyncio.create_task(self._listen_loop(ws))
            self._push({"type": "system", "text": f"Connected {url}", "at": time.time()})
            try:
                await ws.send(json.dumps(build_hello(self._bot_name(), self._next_sequence()), ensure_ascii=False))
            except Exception:
                pass
            return True
        except Exception as e:
            self._last_error = str(e)
            self._ws = None
            return False
        finally:
            self._connecting = False

    async def _reconnect_loop(self) -> None:
        delay = 3.0
        while self._user_wants_connected:
            async with self._lock:
                needs = self._user_wants_connected and (self._ws is None or self._ws.closed)
                ok = await self._connect_once() if needs else True
            if not self._user_wants_connected:
                break
            if ok and self._ws is not None and not self._ws.closed:
                await asyncio.sleep(1.0)
                delay = 3.0
            else:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60.0)

    async def connect(self) -> None:
        async with self._lock:
            self._user_wants_connected = True
            if self._reconnect_task is None or self._reconnect_task.done():
                self._reconnect_task = asyncio.create_task(self._reconnect_loop())
            if self._ws is None or self._ws.closed:
                await self._connect_once()

    async def disconnect(self) -> None:
        async with self._lock:
            self._user_wants_connected = False
            if self._reconnect_task and not self._reconnect_task.done():
                self._reconnect_task.cancel()
                try:
                    await self._reconnect_task
                except asyncio.CancelledError:
                    pass
            self._reconnect_task = None
            if self._listen_task and not self._listen_task.done():
                self._listen_task.cancel()
                try:
                    await self._listen_task
                except asyncio.CancelledError:
                    pass
            self._listen_task = None
            if self._ws is not None:
                try:
                    await self._ws.close()
                except Exception:
                    pass
            self._ws = None
            self._fail_pending("not_connected", "Minaret WebSocket disconnected")
            self._push({"type": "system", "text": "Disconnected", "at": time.time()})

    async def _send_json(self, payload: Dict[str, Any]) -> None:
        if self._ws is None or self._ws.closed:
            raise RuntimeError("Minaret WebSocket is not connected")
        encoded = json.dumps(payload, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 1_048_576:
            raise WireError("invalid_params", "outbound message exceeds 1 MiB")
        await self._ws.send(encoded)

    async def send_say(self, text: str) -> str:
        await self._send_json({"message": text, "user": self._bot_name()})
        self._push({"type": "chat_out", "text": text, "at": time.time()})
        return text

    async def send_command(self, command: str) -> str:
        cmd = (command or "").strip()
        if cmd.startswith("/"):
            cmd = cmd[1:]
        if not cmd:
            raise ValueError("command is empty")
        await self._send_json({"command": cmd})
        sent = f"/{cmd}"
        self._push({"type": "command", "text": sent, "at": time.time()})
        return sent

    async def cancel_action(self, target_request_id: str) -> None:
        await self._send_json(build_cancel(target_request_id, self._next_sequence()))

    def _result(self, action: str, payload: Dict[str, Any]) -> ActionResult:
        ok = bool(payload.get("ok"))
        code = payload.get("error_code")
        return ActionResult(
            ok=ok,
            action=action,
            sent=payload.get("sent"),
            error=None if ok else (payload.get("error") or code or "action failed"),
            degraded=not ok,
            degrade_reason=None if ok else (code or payload.get("error")),
            extras={"effect": payload.get("effect"), "evidence": payload.get("evidence") or {}, "error_code": code},
        )

    async def act(self, request: ActionRequest) -> ActionResult:
        action = request.action
        params = request.params or {}
        if action == "say":
            text = str(params.get("text") or "").strip()
            if not text:
                return ActionResult(ok=False, action=action, error="text is required")
            sent = await self.send_say(text)
            return ActionResult(ok=True, action=action, sent=sent)
        if action == "run_command":
            cmd = str(params.get("command") or params.get("text") or "")
            sent = await self.send_command(cmd)
            return ActionResult(ok=True, action=action, sent=sent)
        try:
            cleaned = validate_action_params(action, params)
        except WireError as exc:
            return ActionResult(ok=False, action=action, error=exc.message, degraded=True, degrade_reason=exc.code)
        envelope = build_action_request(action, cleaned, self._next_sequence(), goal=self._actor_goal)
        request_id = str(envelope["request_id"])
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = future
        try:
            await self._send_json(envelope)
            payload = await asyncio.wait_for(future, timeout=action_timeout_seconds(action, cleaned))
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            await self._cancel_quietly(request_id)
            return ActionResult(
                ok=False,
                action=action,
                error="action timed out",
                degraded=True,
                degrade_reason="timeout",
                extras={"error_code": "timeout", "effect": "failed"},
            )
        except WireError as exc:
            self._pending.pop(request_id, None)
            return ActionResult(ok=False, action=action, error=exc.message, degraded=True, degrade_reason=exc.code)
        except Exception as exc:
            self._pending.pop(request_id, None)
            return ActionResult(ok=False, action=action, error=str(exc), degraded=True, degrade_reason="not_connected")
        return self._result(action, payload)

    async def _cancel_quietly(self, request_id: str) -> None:
        try:
            await self.cancel_action(request_id)
        except Exception:
            return
