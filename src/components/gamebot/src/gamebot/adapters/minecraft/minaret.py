"""NeoForge Minaret WebSocket 后端。"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import websockets
from websockets.client import WebSocketClientProtocol

from gamebot.adapters.minecraft.protocol import apply_presence_event, extract_handshake, parse_incoming_chat
from gamebot.adapters.minecraft.wire import (
    WireError,
    action_timeout_seconds,
    build_action_request,
    build_cancel,
    build_claim_revoke,
    build_hello,
    normalize_activity,
    normalize_snapshot,
    parse_action_result,
    say_id_of,
    validate_action_params,
    validate_say,
)
from gamebot.contracts.models import ActionRequest, ActionResult, NearbyPlayer, ProbeResult, Vec3

_WS_TIMEOUT = 3.0
_PROTECTED_EVENTS = {"action_result", "error", "auth_failed", "chat", "player_chat", "chat_message", "chat_out"}


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
        self._entity_uuid: Optional[str] = None
        self._agent_name: Optional[str] = None
        self._actor_goal: Optional[str] = None
        self._block_scan_known = False
        self._entity_nearby_known = False
        self._on_chat = None
        self._sequence = 0
        self._conn_gen = 0
        self._pending: Dict[str, Any] = {}
        self._unresolved: Set[str] = set()
        self._hello_waiter: Optional[tuple] = None
        self._say_waiter: Optional[tuple] = None
        self._hello_error: Optional[str] = None

    def _ws_url(self) -> str:
        return str(self.config.get("NEOFORGE_WS_URL") or self.config.get("ws_url") or "ws://127.0.0.1:8765").strip()

    def _bot_name(self) -> str:
        return str(self.config.get("MC_USERNAME") or self.config.get("username") or "Player").strip()

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

    def _slim_event(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        """Keep chat identifiable; strip bulky snapshot payloads so they cannot bury chat."""
        cleaned = _without_claim_key(entry)
        event_type = str(cleaned.get("type") or "")
        if event_type != "snapshot":
            return cleaned
        raw = cleaned.get("data") if isinstance(cleaned.get("data"), dict) else {}
        sequence = raw.get("sequence")
        if sequence is None:
            sequence = cleaned.get("sequence")
        return {
            "type": "snapshot",
            "at": cleaned.get("at"),
            "sequence": sequence,
        }

    def _push(self, entry: Dict[str, Any]) -> None:
        self._recent_events.append(self._slim_event(entry))
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

    def _recent_for_observe(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Prefer chat-bearing events so mirror/re-arm still see them under snapshot flood."""
        if limit <= 0:
            return []
        chat_types = {"chat", "player_chat", "chat_message", "chat_out"}
        chats = [item for item in self._recent_events if str(item.get("type") or "") in chat_types]
        if len(chats) >= limit:
            return list(chats[-limit:])
        picked = list(chats)
        picked_ids = {id(item) for item in picked}
        need = limit - len(picked)
        for item in reversed(self._recent_events):
            if id(item) in picked_ids:
                continue
            picked.append(item)
            picked_ids.add(id(item))
            need -= 1
            if need <= 0:
                break
        index = {id(item): i for i, item in enumerate(self._recent_events)}
        picked.sort(key=lambda item: index.get(id(item), 0))
        return picked

    def _configured_agent_id(self) -> Optional[str]:
        raw = str(self.config.get("MC_AGENT_ID") or "").strip()
        return raw or None

    def _fail_pending(self, code: str, message: str, generation: Optional[int] = None) -> None:
        failed = []
        kept: Dict[str, Any] = {}
        for request_id, item in self._pending.items():
            future, gen = item
            if generation is not None and gen != generation:
                kept[request_id] = item
                continue
            failed.append(future)
        self._pending = kept
        if generation is None:
            self._item_search = None
            self._item_search_pending = False
            self._last_action = None
            self._last_action_pending = False
        for future in failed:
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
        self._fail_hello(generation, message)
        self._fail_say(generation, message, code)

    def _fail_hello(self, generation: Optional[int], message: str) -> None:
        waiter = self._hello_waiter
        if waiter is None:
            return
        future, gen, _expected = waiter
        if generation is not None and gen != generation:
            return
        if not future.done():
            future.set_result({"ok": False, "error": message})

    def _fail_say(self, generation: Optional[int], message: str, code: str = "not_connected") -> None:
        waiter = self._say_waiter
        if waiter is None:
            return
        future, gen, say_id = waiter
        if generation is not None and gen != generation:
            return
        self._say_waiter = None
        if not future.done():
            future.set_result(
                {
                    "ok": False,
                    "say_id": say_id,
                    "message_id": say_id,
                    "error": message,
                    "error_code": code,
                    "sent": None,
                }
            )

    def _complete_say(self, data: Dict[str, Any], generation: int) -> None:
        waiter = self._say_waiter
        if waiter is None:
            return
        future, gen, say_id = waiter
        if gen != generation or future.done():
            return
        view = data.get("data") if isinstance(data.get("data"), dict) else data
        got = str((view or {}).get("say_id") or "")
        if got != say_id:
            return
        self._say_waiter = None
        future.set_result(dict(view or {}))

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
            "recent_events": self._recent_for_observe(10),
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
            "entity_uuid": self._entity_uuid,
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
            expected = self._configured_agent_id()
            if expected and new_id != expected:
                self._last_error = f"agent_id {new_id} does not match this session"
                return
            if not expected and self._agent_id and new_id != self._agent_id:
                self._last_action = None
                self._last_action_pending = False
            self._agent_id = new_id
        if view.get("entity_uuid"):
            self._entity_uuid = str(view.get("entity_uuid"))
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

    def _message_agent_id(self, data: Dict[str, Any]) -> str:
        inner = data.get("data") if isinstance(data.get("data"), dict) else {}
        agent = inner.get("agent_id") if isinstance(inner, dict) else None
        if not agent:
            agent = data.get("agent_id")
        return str(agent) if agent else ""

    @staticmethod
    def _is_shared_event(event: str) -> bool:
        # Chat is fan-out to every bound seat and carries the speaker's agent_id.
        # That id must not be treated as a seat-binding mismatch.
        return event in ("chat", "player_chat", "chat_message")

    def _reject_foreign_agent(self, data: Dict[str, Any]) -> bool:
        claimed = self._message_agent_id(data)
        if not claimed:
            return False
        expected = self._configured_agent_id() or self._agent_id
        if expected and claimed != expected:
            self._last_error = f"agent_mismatch: {claimed}"
            return True
        return False

    def _clear_stale_agent_mismatch(self) -> None:
        err = self._last_error or ""
        if err.startswith("agent_mismatch:"):
            self._last_error = None

    def _complete_hello(self, data: Dict[str, Any], generation: int) -> None:
        waiter = self._hello_waiter
        if waiter is None:
            return
        future, gen, expected = waiter
        if gen != generation or future.done():
            return
        view = data.get("data") if isinstance(data.get("data"), dict) else data
        got = str((view or {}).get("agent_id") or "")
        if got != expected:
            future.set_result({"ok": False, "error": f"hello agent_id {got or 'missing'} does not match {expected}"})
            return
        if isinstance(view, dict) and view.get("world_ready") is False:
            future.set_result({"ok": False, "error": "server npc is not ready"})
            return
        future.set_result({"ok": True, "agent_id": got})

    async def _handle_event(self, data: Dict[str, Any], generation: int) -> None:
        if generation != self._conn_gen:
            return
        event = str(data.get("event") or data.get("type") or "message").strip()
        if event == "chat_result":
            self._complete_say(data, generation)
            return
        if self._is_shared_event(event):
            # Shared broadcasts (agent say / player chat) are intentionally multi-seat.
            # Process chat for this seat without poisoning last_error on a foreign agent_id.
            self._push({"type": event, "data": data, "at": time.time()})
            apply_presence_event(data, self._online_players)
            chat = parse_incoming_chat(data, self._bot_name())
            if chat:
                asyncio.create_task(self._emit_chat(chat[0], chat[1]))
            return
        if self._reject_foreign_agent(data):
            if event == "hello":
                self._complete_hello(data, generation)
            return
        self._push({"type": event, "data": data, "at": time.time()})
        apply_presence_event(data, self._online_players)
        if event == "snapshot":
            self._apply_snapshot(data)
            self._clear_stale_agent_mismatch()
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
            item = self._pending.get(request_id)
            if item is None:
                return
            future, gen = item
            if gen != generation:
                return
            self._pending.pop(request_id, None)
            if not future.done():
                future.set_result(result)
        elif event == "error":
            message = data.get("data") if isinstance(data.get("data"), dict) else data
            self._last_error = str((message or {}).get("error") or (message or {}).get("message") or "bridge error")
            self._fail_hello(generation, self._last_error)
        else:
            self._capture_actor(data)
            self._apply_handshake(data)
            if event == "hello":
                self._complete_hello(data, generation)
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

    async def _listen_loop(self, ws: WebSocketClientProtocol, generation: int) -> None:
        try:
            async for raw in ws:
                if generation != self._conn_gen:
                    return
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
                    await self._handle_event(data, generation)
                elif isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            await self._handle_event(item, generation)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if generation == self._conn_gen:
                self._last_error = str(e)
                self._push({"type": "system", "text": f"listen ended: {e}", "at": time.time()})
        finally:
            self._fail_pending("not_connected", "Minaret WebSocket closed", generation)

    async def _connect_once(self) -> bool:
        async with self._lock:
            if self._hello_error:
                return False
            if self._ws is not None and not self._ws.closed:
                existing = self._hello_waiter
                waiter = existing[0] if existing is not None and not existing[0].done() else None
                opened = False
            else:
                url = self._ws_url()
                headers = self._headers()
                self._connecting = True
                self._last_error = None
                generation = self._conn_gen + 1
                try:
                    ws = await websockets.connect(
                        url,
                        extra_headers=headers,
                        ping_interval=20,
                        ping_timeout=20,
                        close_timeout=5,
                    )
                except Exception as e:
                    self._last_error = str(e)
                    self._ws = None
                    self._connecting = False
                    return False
                self._conn_gen = generation
                self._ws = ws
                agent_id = self._configured_agent_id()
                waiter = None
                if agent_id:
                    loop = asyncio.get_running_loop()
                    waiter = loop.create_future()
                    self._hello_waiter = (waiter, generation, agent_id)
                self._listen_task = asyncio.create_task(self._listen_loop(ws, generation))
                self._push({"type": "system", "text": f"Connected {url}", "at": time.time()})
                try:
                    hello = build_hello(
                        self._bot_name(),
                        self._next_sequence(),
                        agent_id=agent_id,
                        display_name=str(self.config.get("MC_AGENT_NAME") or self._bot_name()) if agent_id else None,
                        provision=bool(agent_id),
                        claim_key=self._claim_key(),
                    )
                    await ws.send(json.dumps(hello, ensure_ascii=False))
                except Exception as exc:
                    self._last_error = str(exc)
                    self._connecting = False
                    return False
                self._connecting = False
                opened = True
        if waiter is None:
            return True
        try:
            payload = await asyncio.wait_for(waiter, timeout=8)
        except asyncio.TimeoutError:
            if opened:
                self._last_error = "hello was not acknowledged"
                self._hello_error = self._last_error
                self._user_wants_connected = False
            return False
        if not payload.get("ok"):
            if opened:
                self._last_error = str(payload.get("error") or "hello was rejected")
                self._hello_error = self._last_error
                self._user_wants_connected = False
            return False
        return True

    async def _reconnect_loop(self) -> None:
        delay = 3.0
        while self._user_wants_connected and not self._hello_error:
            needs = self._user_wants_connected and (self._ws is None or self._ws.closed)
            ok = await self._connect_once() if needs else True
            if not self._user_wants_connected or self._hello_error:
                break
            if ok and self._ws is not None and not self._ws.closed:
                await asyncio.sleep(1.0)
                delay = 3.0
            else:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60.0)

    async def connect(self) -> None:
        async with self._lock:
            self._hello_error = None
            self._user_wants_connected = True
            needs = self._ws is None or self._ws.closed
            if self._reconnect_task is None or self._reconnect_task.done():
                self._reconnect_task = asyncio.create_task(self._reconnect_loop())
        if needs:
            ok = await self._connect_once()
            if self._configured_agent_id() and not ok:
                raise RuntimeError(self._last_error or "member hello failed")

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

    def _say_timeout(self) -> float:
        raw = self.config.get("MINARET_SAY_TIMEOUT")
        if raw not in (None, ""):
            try:
                return max(0.05, float(raw))
            except (TypeError, ValueError):
                pass
        return _WS_TIMEOUT

    async def send_say(
        self,
        text: str,
        *,
        audience: str = "public",
        target: str = "",
        emote: str = "",
        say_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        cleaned = validate_say({"text": text, "audience": audience, "target": target, "emote": emote})
        token = say_id_of(say_id)
        payload: Dict[str, Any] = {
            "message": cleaned["text"],
            "user": self._bot_name(),
            "audience": cleaned["audience"],
            "say_id": token,
        }
        if cleaned.get("target"):
            payload["target"] = cleaned["target"]
        if cleaned.get("emote"):
            payload["emote"] = cleaned["emote"]
        agent_id = self._configured_agent_id()
        if agent_id:
            payload["agent_id"] = agent_id
        self._fail_say(None, "superseded", "action_rejected")
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        generation = self._conn_gen
        self._say_waiter = (future, generation, token)
        try:
            await self._send_json(payload)
            view = await asyncio.wait_for(future, timeout=self._say_timeout())
        except asyncio.TimeoutError:
            if self._say_waiter and self._say_waiter[2] == token:
                self._say_waiter = None
            return {
                "ok": False,
                "say_id": token,
                "message_id": token,
                "audience": cleaned["audience"],
                "error": "chat result timed out",
                "error_code": "timeout",
                "sent": None,
            }
        except Exception as exc:
            if self._say_waiter and self._say_waiter[2] == token:
                self._say_waiter = None
            return {
                "ok": False,
                "say_id": token,
                "message_id": token,
                "audience": cleaned["audience"],
                "error": str(exc),
                "error_code": "not_connected",
                "sent": None,
            }
        if not isinstance(view, dict):
            view = {}
        view.setdefault("say_id", token)
        view.setdefault("message_id", view.get("say_id") or token)
        view.setdefault("audience", cleaned["audience"])
        if view.get("ok"):
            self._push({"type": "chat_out", "text": view.get("sent") or cleaned["text"], "at": time.time(), "say_id": token})
        return view

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
        item = self._pending.get(target_request_id)
        if item is None or item[1] != self._conn_gen:
            raise WireError("action_rejected", "no such request for this session")
        await self._send_json(
            build_cancel(target_request_id, self._next_sequence(), agent_id=self._configured_agent_id())
        )

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
            try:
                cleaned = validate_say(params)
            except WireError as exc:
                return ActionResult(ok=False, action=action, error=exc.message, degraded=True, degrade_reason=exc.code, extras={"error_code": exc.code})
            view = await self.send_say(
                cleaned["text"],
                audience=cleaned["audience"],
                target=str(cleaned.get("target") or ""),
                emote=str(cleaned.get("emote") or ""),
                say_id=str(params.get("say_id") or "") or None,
            )
            ok = bool(view.get("ok"))
            code = view.get("error_code")
            say_token = str(view.get("say_id") or "")
            return ActionResult(
                ok=ok,
                action=action,
                sent=view.get("sent"),
                error=None if ok else (view.get("error") or code or "chat was not delivered"),
                degraded=not ok,
                degrade_reason=None if ok else (code or view.get("error")),
                extras={
                    "effect": "confirmed" if ok else "failed",
                    "error_code": code,
                    "say_id": say_token,
                    "message_id": view.get("message_id") or say_token,
                    "audience": view.get("audience") or cleaned["audience"],
                    "target": view.get("target") or cleaned.get("target") or "",
                },
            )
        if action == "run_command":
            cmd = str(params.get("command") or params.get("text") or "")
            sent = await self.send_command(cmd)
            return ActionResult(ok=True, action=action, sent=sent)
        try:
            cleaned = validate_action_params(action, params)
        except WireError as exc:
            return ActionResult(ok=False, action=action, error=exc.message, degraded=True, degrade_reason=exc.code)
        claim = params.get("claim") if isinstance(params, dict) else None
        fingerprint = _fingerprint(action, cleaned) if action in {"place_block", "break_block"} else None
        if fingerprint and fingerprint in self._unresolved:
            return ActionResult(
                ok=False,
                action=action,
                error="previous world change is unresolved",
                degraded=True,
                degrade_reason="needs_reconciliation",
                extras={"effect": "unknown", "replay": False, "error_code": "needs_reconciliation"},
            )
        try:
            envelope = build_action_request(
                action,
                cleaned,
                self._next_sequence(),
                goal=self._actor_goal,
                claim=claim if isinstance(claim, dict) else None,
                agent_id=self._configured_agent_id(),
            )
        except WireError as exc:
            return ActionResult(ok=False, action=action, error=exc.message, degraded=True, degrade_reason=exc.code)
        request_id = str(envelope["request_id"])
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = (future, self._conn_gen)
        try:
            await self._send_json(envelope)
            payload = await asyncio.wait_for(future, timeout=self._action_timeout(action, cleaned))
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            await self._cancel_quietly(request_id)
            if fingerprint:
                self._unresolved.add(fingerprint)
                return ActionResult(
                    ok=False,
                    action=action,
                    error="world change result is unknown",
                    degraded=True,
                    degrade_reason="needs_reconciliation",
                    extras={"effect": "unknown", "replay": False, "error_code": "needs_reconciliation"},
                )
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

    def _action_timeout(self, action: str, params: Dict[str, Any]) -> float:
        raw = self.config.get("MINARET_ACTION_TIMEOUT")
        if raw not in (None, ""):
            try:
                return max(0.05, float(raw))
            except (TypeError, ValueError):
                pass
        return action_timeout_seconds(action, params)

    def _claim_key(self) -> Optional[str]:
        path = self.config.get("GAMEBOT_CLAIM_KEY_FILE") or os.environ.get("GAMEBOT_CLAIM_KEY_FILE")
        if not path:
            return None
        try:
            text = Path(str(path)).read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return text or None

    async def send_claim_revoke(self, pid: str, tid: str, gen: int, sig: str) -> None:
        agent_id = self._configured_agent_id()
        if not agent_id:
            raise WireError("invalid_params", "agent_id is required")
        await self._send_json(build_claim_revoke(agent_id, pid, tid, int(gen), sig, self._next_sequence()))


def _fingerprint(action: str, params: Dict[str, Any]) -> str:
    return action + "\n" + json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _without_claim_key(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_claim_key(item) for key, item in value.items() if key != "claim_key"}
    if isinstance(value, list):
        return [_without_claim_key(item) for item in value]
    return value
