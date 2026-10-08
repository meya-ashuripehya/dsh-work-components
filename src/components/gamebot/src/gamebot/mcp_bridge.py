"""Thin MCP stdio bridge over TRIX-GAMEBOT REST (no soft APIs).

Uses only httpx + stdlib so it stays compatible with GameBot's pinned
FastAPI/anyio stack (official `mcp` package needs anyio>=4.5).

Env:
  GAMEBOT_URL  base URL, default http://127.0.0.1:8766
  GAMEBOT_GAME optional game scope (minecraft / civilization / vision): only that
               game's sessions/configs are reachable; game args are fixed.

Protocol: MCP JSON-RPC over stdio with Content-Length framing
(compatible with common MCP clients / dsh-mcp-client).
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

DEFAULT_URL = "http://127.0.0.1:8766"
PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "gamebot"
SERVER_VERSION = "0.1.0"

ToolFn = Callable[..., str]


def _base_url() -> str:
    return (os.getenv("GAMEBOT_URL") or DEFAULT_URL).rstrip("/")


def _dump(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


def _req(method: str, path: str, *, json_body: Optional[Dict[str, Any]] = None) -> str:
    try:
        with httpx.Client(base_url=_base_url(), timeout=60.0) as client:
            res = client.request(method, path, json=json_body)
    except httpx.HTTPError as exc:
        return _dump({"ok": False, "error": f"HTTP error talking to GameBot {_base_url()}: {exc}"})
    try:
        body: Any = res.json()
    except Exception:
        body = {"raw": res.text}
    if res.is_error:
        return _dump({"ok": False, "status": res.status_code, "body": body})
    return _dump(body)


def _parse_obj(raw: str, label: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        return None, f"{label} must be JSON object: {exc}"
    if not isinstance(data, dict):
        return None, f"{label} must decode to an object"
    return data, None


# ── tools (1:1 with existing REST) ───────────────────────────────────────────

def tool_health() -> str:
    return _req("GET", "/health")


def tool_list_games() -> str:
    return _req("GET", "/v1/games")


def tool_get_game(game: str) -> str:
    return _req("GET", f"/v1/games/{game}")


def tool_list_sessions() -> str:
    return _req("GET", "/v1/sessions")


def tool_create_session_from_config(game: str) -> str:
    return _req("POST", f"/v1/games/{game}/session")


def tool_create_session(game: str, driver: str, config_json: str = "{}", session_id: str = "") -> str:
    config, err = _parse_obj(config_json, "config_json")
    if err:
        return _dump({"ok": False, "error": err})
    body: Dict[str, Any] = {"game": game, "driver": driver, "config": config}
    if (session_id or "").strip():
        body["session_id"] = session_id.strip()
    return _req("POST", "/v1/sessions", json_body=body)


def tool_connect(session_id: str) -> str:
    return _req("POST", f"/v1/sessions/{session_id}/connect")


def tool_disconnect(session_id: str) -> str:
    return _req("POST", f"/v1/sessions/{session_id}/disconnect")


def tool_probe(session_id: str) -> str:
    return _req("POST", f"/v1/sessions/{session_id}/probe")


def tool_observe(session_id: str) -> str:
    return _req("GET", f"/v1/sessions/{session_id}/observe")


def tool_capabilities(session_id: str) -> str:
    return _req("GET", f"/v1/sessions/{session_id}/capabilities")


def tool_action(session_id: str, action: str, params_json: str = "{}", require_confirm: bool = False) -> str:
    params, err = _parse_obj(params_json, "params_json")
    if err:
        return _dump({"ok": False, "error": err})
    return _req(
        "POST",
        f"/v1/sessions/{session_id}/actions",
        json_body={"action": action, "params": params, "require_confirm": bool(require_confirm)},
    )


def tool_events(session_id: str) -> str:
    return _req("GET", f"/v1/sessions/{session_id}/events")


def tool_brain_status(session_id: str) -> str:
    return _req("GET", f"/v1/sessions/{session_id}/brain")


def tool_brain_decide(session_id: str, goal: str = "", player: str = "", message: str = "") -> str:
    body: Dict[str, Any] = {}
    if (goal or "").strip():
        body["goal"] = goal
    if (player or "").strip():
        body["player"] = player
    if (message or "").strip():
        body["message"] = message
    return _req("POST", f"/v1/sessions/{session_id}/brain/decide", json_body=body)


def tool_brain_task(
    session_id: str,
    goal: str,
    max_steps: int = 0,
    interrupt: bool = True,
    execute: bool = True,
) -> str:
    body: Dict[str, Any] = {"goal": goal, "interrupt": bool(interrupt), "execute": bool(execute)}
    if max_steps and int(max_steps) > 0:
        body["max_steps"] = int(max_steps)
    return _req("POST", f"/v1/sessions/{session_id}/brain/tasks", json_body=body)


def tool_brain_chat(session_id: str, player: str, message: str) -> str:
    return _req(
        "POST",
        f"/v1/sessions/{session_id}/brain/chat",
        json_body={"player": player, "message": message},
    )


def tool_brain_cancel(session_id: str) -> str:
    return _req("POST", f"/v1/sessions/{session_id}/brain/cancel")


def tool_memory(session_id: str) -> str:
    return _req("GET", f"/v1/sessions/{session_id}/memory")


def tool_memory_search(session_id: str, query: str = "") -> str:
    return _req(
        "POST",
        f"/v1/sessions/{session_id}/memory/search",
        json_body={"query": query or ""},
    )


def _prop(type_: str, description: str, **extra: Any) -> Dict[str, Any]:
    out = {"type": type_, "description": description}
    out.update(extra)
    return out


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "gamebot_health",
        "description": "GET /health — GameBot service health and session count.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "handler": lambda **_: tool_health(),
    },
    {
        "name": "gamebot_list_games",
        "description": "GET /v1/games — list per-game configs.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "handler": lambda **_: tool_list_games(),
    },
    {
        "name": "gamebot_get_game",
        "description": "GET /v1/games/{game} — read one game config.",
        "inputSchema": {
            "type": "object",
            "properties": {"game": _prop("string", "Game id, e.g. minecraft / civilization")},
            "required": ["game"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_get_game(kw["game"]),
    },
    {
        "name": "gamebot_list_sessions",
        "description": "GET /v1/sessions — list active sessions.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "handler": lambda **_: tool_list_sessions(),
    },
    {
        "name": "gamebot_create_session_from_config",
        "description": "POST /v1/games/{game}/session — create/overwrite default-{game} from saved config.",
        "inputSchema": {
            "type": "object",
            "properties": {"game": _prop("string", "Game id")},
            "required": ["game"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_create_session_from_config(kw["game"]),
    },
    {
        "name": "gamebot_create_session",
        "description": "POST /v1/sessions — create/overwrite a session. config_json is a JSON object string.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "game": _prop("string", "Game id"),
                "driver": _prop("string", "Driver id"),
                "config_json": _prop("string", "JSON object string", default="{}"),
                "session_id": _prop("string", "Optional session id", default=""),
            },
            "required": ["game", "driver"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_create_session(
            kw["game"], kw["driver"], kw.get("config_json", "{}"), kw.get("session_id", "")
        ),
    },
    {
        "name": "gamebot_connect",
        "description": "POST /v1/sessions/{id}/connect — connect the session driver.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_connect(kw["session_id"]),
    },
    {
        "name": "gamebot_disconnect",
        "description": "POST /v1/sessions/{id}/disconnect — disconnect the session driver.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_disconnect(kw["session_id"]),
    },
    {
        "name": "gamebot_probe",
        "description": "POST /v1/sessions/{id}/probe — probe driver reachability / capabilities.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_probe(kw["session_id"]),
    },
    {
        "name": "gamebot_observe",
        "description": "GET /v1/sessions/{id}/observe — structured observation.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_observe(kw["session_id"]),
    },
    {
        "name": "gamebot_capabilities",
        "description": "GET /v1/sessions/{id}/capabilities — current capability list.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_capabilities(kw["session_id"]),
    },
    {
        "name": "gamebot_action",
        "description": "POST /v1/sessions/{id}/actions — run a semantic action. params_json is a JSON object string.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": _prop("string", "Session id"),
                "action": _prop("string", "Action name, e.g. say / move_to"),
                "params_json": _prop("string", "JSON object string", default="{}"),
                "require_confirm": _prop("boolean", "Require confirm flag", default=False),
            },
            "required": ["session_id", "action"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_action(
            kw["session_id"], kw["action"], kw.get("params_json", "{}"), kw.get("require_confirm", False)
        ),
    },
    {
        "name": "gamebot_events",
        "description": "GET /v1/sessions/{id}/events — recent session events.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_events(kw["session_id"]),
    },
    {
        "name": "gamebot_brain_status",
        "description": "GET /v1/sessions/{id}/brain — brain status (no API keys). Dual-brain caution applies.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_brain_status(kw["session_id"]),
    },
    {
        "name": "gamebot_brain_decide",
        "description": "POST /v1/sessions/{id}/brain/decide — decide only (no execute).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": _prop("string", "Session id"),
                "goal": _prop("string", "Optional goal", default=""),
                "player": _prop("string", "Optional player name", default=""),
                "message": _prop("string", "Optional chat message", default=""),
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_brain_decide(
            kw["session_id"], kw.get("goal", ""), kw.get("player", ""), kw.get("message", "")
        ),
    },
    {
        "name": "gamebot_brain_task",
        "description": "POST /v1/sessions/{id}/brain/tasks — LLM decide (+ optionally execute). Dual-brain caution applies.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": _prop("string", "Session id"),
                "goal": _prop("string", "Task goal"),
                "max_steps": _prop("integer", "Optional max steps; 0 = service default", default=0),
                "interrupt": _prop("boolean", "Interrupt current sequence", default=True),
                "execute": _prop("boolean", "Execute decided actions", default=True),
            },
            "required": ["session_id", "goal"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_brain_task(
            kw["session_id"],
            kw["goal"],
            kw.get("max_steps", 0),
            kw.get("interrupt", True),
            kw.get("execute", True),
        ),
    },
    {
        "name": "gamebot_brain_chat",
        "description": "POST /v1/sessions/{id}/brain/chat — inject player chat into brain.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": _prop("string", "Session id"),
                "player": _prop("string", "Player name"),
                "message": _prop("string", "Chat message"),
            },
            "required": ["session_id", "player", "message"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_brain_chat(kw["session_id"], kw["player"], kw["message"]),
    },
    {
        "name": "gamebot_brain_cancel",
        "description": "POST /v1/sessions/{id}/brain/cancel — interrupt current action sequence.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_brain_cancel(kw["session_id"]),
    },
    {
        "name": "gamebot_memory",
        "description": "GET /v1/sessions/{id}/memory — layered memory snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": _prop("string", "Session id")},
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_memory(kw["session_id"]),
    },
    {
        "name": "gamebot_memory_search",
        "description": "POST /v1/sessions/{id}/memory/search — search layered memory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": _prop("string", "Session id"),
                "query": _prop("string", "Search query", default=""),
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
        "handler": lambda **kw: tool_memory_search(kw["session_id"], kw.get("query", "")),
    },
]


# ── per-game scope (GAMEBOT_GAME) ────────────────────────────────────────────

_ALIASES = {
    "minecraft": "minecraft", "mc": "minecraft",
    "civilization": "civilization", "civ": "civilization", "civ6": "civilization",
    "civilization-vi": "civilization", "civilization_vi": "civilization",
    "vision": "vision", "desktop": "vision", "vision_desktop": "vision",
}


def _norm_game(g: Any) -> str:
    k = str(g or "").strip().lower()
    return _ALIASES.get(k, k)


GAME = _norm_game(os.getenv("GAMEBOT_GAME") or "")
if GAME:
    SERVER_NAME = f"gamebot-{GAME}"

_SECRET_KEY = re.compile(r"(API_KEY|_PASS|PASSWORD|TOKEN|SECRET)$", re.I)


def _redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            if str(k) == "provider_keys" and isinstance(v, dict):
                out[k] = {pk: ("***" if pv else "") for pk, pv in v.items()}
            elif isinstance(v, str) and v and _SECRET_KEY.search(str(k)):
                out[k] = "***"
            else:
                out[k] = _redact(v)
        return out
    if isinstance(obj, list):
        return [_redact(x) for x in obj]
    return obj


def _sessions() -> List[Dict[str, Any]]:
    try:
        data = json.loads(tool_list_sessions())
    except Exception:
        return []
    items = data.get("sessions") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


def _session_game(session_id: str) -> Optional[str]:
    for s in _sessions():
        if isinstance(s, dict) and s.get("id") == session_id:
            return _norm_game(s.get("game"))
    return None


def _guard(handler: ToolFn) -> ToolFn:
    def run(**kw: Any) -> str:
        sid = str(kw.get("session_id") or "").strip()
        if sid:
            g = _session_game(sid)
            if g is not None and g != GAME:
                return _dump({"ok": False, "error": f"session {sid} belongs to game {g!r}; this MCP server is scoped to {GAME!r}"})
        return handler(**kw)
    return run


def _scoped_list_sessions(**_: Any) -> str:
    return _dump({"ok": True, "sessions": [s for s in _sessions() if _norm_game(s.get("game")) == GAME]})


def _scoped_get_game(**_: Any) -> str:
    try:
        return _dump(_redact(json.loads(tool_get_game(GAME))))
    except Exception as exc:  # noqa: BLE001
        return _dump({"ok": False, "error": str(exc)})


def _scope_tools(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not GAME:
        return tools
    out: List[Dict[str, Any]] = []
    for tool in tools:
        name = tool["name"]
        if name == "gamebot_list_games":
            continue  # would expose other games' configs
        t = dict(tool)
        schema = json.loads(json.dumps(t.get("inputSchema") or {}))
        props = schema.get("properties") or {}
        handler = t["handler"]
        if "game" in props:
            props.pop("game")
            schema["required"] = [r for r in schema.get("required", []) if r != "game"]
            handler = (lambda h: lambda **kw: h(**{**kw, "game": GAME}))(handler)
        if "session_id" in props:
            handler = _guard(handler)
        if name == "gamebot_list_sessions":
            handler = _scoped_list_sessions
        elif name == "gamebot_get_game":
            handler = _scoped_get_game
        t["inputSchema"] = schema
        t["handler"] = handler
        t["description"] = f"[{GAME}] " + str(t.get("description") or "")
        out.append(t)
    return out


TOOLS = _scope_tools(TOOLS)
TOOL_BY_NAME = {t["name"]: t for t in TOOLS}


# ── MCP stdio framing ────────────────────────────────────────────────────────

_write_lock = threading.Lock()


def _write_message(msg: Dict[str, Any]) -> None:
    raw = json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii")
    with _write_lock:
        sys.stdout.buffer.write(header)
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()


def _read_message() -> Optional[Dict[str, Any]]:
    headers: Dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        try:
            text = line.decode("ascii", errors="replace").strip()
        except Exception:
            continue
        if ":" in text:
            k, v = text.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get("content-length") or "0")
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    if not body:
        return None
    return json.loads(body.decode("utf-8"))


def _tool_list_payload() -> List[Dict[str, Any]]:
    out = []
    for t in TOOLS:
        out.append(
            {
                "name": t["name"],
                "description": t["description"],
                "inputSchema": t["inputSchema"],
            }
        )
    return out


def _handle(msg: Dict[str, Any]) -> None:
    if "method" not in msg:
        return
    method = msg["method"]
    req_id = msg.get("id")
    params = msg.get("params") or {}

    def reply(result: Any = None, error: Optional[Dict[str, Any]] = None) -> None:
        if req_id is None:
            return
        if error is not None:
            _write_message({"jsonrpc": "2.0", "id": req_id, "error": error})
        else:
            _write_message({"jsonrpc": "2.0", "id": req_id, "result": result})

    if method == "initialize":
        reply(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "TRIX-GAMEBOT MCP bridge wrapping existing REST. "
                    f"GAMEBOT_URL={_base_url()}. Scope={GAME or 'all'}. Body is started by dsh-workbench. "
                    "Dual-brain caution: do not let DSH desktop brain and GameBot brain "
                    "drive the same game actions at once."
                ),
            }
        )
        return

    if method == "notifications/initialized" or method.startswith("notifications/"):
        return

    if method == "ping":
        reply({})
        return

    if method == "tools/list":
        reply({"tools": _tool_list_payload()})
        return

    if method == "tools/call":
        name = (params.get("name") or "").strip()
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        tool = TOOL_BY_NAME.get(name)
        if not tool:
            reply(error={"code": -32601, "message": f"Unknown tool: {name}"})
            return
        try:
            text = tool["handler"](**arguments)
            reply({"content": [{"type": "text", "text": text}], "isError": False})
        except TypeError as exc:
            reply({"content": [{"type": "text", "text": _dump({"ok": False, "error": str(exc)})}], "isError": True})
        except Exception as exc:  # noqa: BLE001
            reply({"content": [{"type": "text", "text": _dump({"ok": False, "error": str(exc)})}], "isError": True})
        return

    if req_id is not None:
        reply(error={"code": -32601, "message": f"Method not found: {method}"})


def main() -> None:
    # Keep stdout reserved for MCP framing; diagnostics go to stderr.
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    sys.stderr.write(
        f"gamebot.mcp_bridge listening on stdio; GAMEBOT_URL={_base_url()} game={GAME or '*'} tools={len(TOOLS)}\n"
    )
    sys.stderr.flush()
    while True:
        try:
            msg = _read_message()
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"mcp_bridge read error: {exc}\n")
            sys.stderr.flush()
            break
        if msg is None:
            break
        try:
            _handle(msg)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"mcp_bridge handle error: {exc}\n")
            sys.stderr.flush()
            req_id = msg.get("id") if isinstance(msg, dict) else None
            if req_id is not None:
                _write_message(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32603, "message": str(exc)},
                    }
                )


if __name__ == "__main__":
    main()
