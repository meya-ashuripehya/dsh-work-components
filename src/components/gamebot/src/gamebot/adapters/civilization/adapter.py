"""文明6驱动：拉起隔离 MCP 工作进程，并执行权限复检。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from gamebot.adapters.civilization.mcp_client import CivMcpClient, CivMcpError, default_command, default_project_dir
from gamebot.adapters.civilization.policy import FORBIDDEN_TOOLS, ActionClass, classify
from gamebot.contracts import capabilities as cap_ids
from gamebot.contracts.models import ActionRequest, ActionResult, Capability, Observation, ProbeResult
from gamebot.drivers.base import GameDriver


class CivilizationAdapter(GameDriver):
    game = "civilization"
    driver_id = "civ6_mcp"

    def __init__(self, config: Optional[Dict[str, Any]] = None, client: Optional[CivMcpClient] = None) -> None:
        self.config = dict(config or {})
        self._client = client
        self._owns_client = client is None
        self._connected = False
        self._last_error: Optional[str] = None
        self._tools: List[Dict[str, Any]] = []
        self._snapshot: Dict[str, Any] = {}
        self._recent: List[Dict[str, Any]] = []
        self._panel_ready = False
        self._fingerprint = ""

    def project_dir(self) -> str:
        raw = str(self.config.get("CIV6_MCP_PROJECT") or "").strip()
        return raw or str(default_project_dir())

    def tool_map(self) -> Dict[str, Dict[str, Any]]:
        return {str(tool.get("name")): tool for tool in self._tools}

    def _read_only(self, name: str) -> bool:
        annotations = (self.tool_map().get(name) or {}).get("annotations") or {}
        return bool(annotations.get("readOnlyHint"))

    async def probe(self) -> ProbeResult:
        try:
            command = self._client.command if self._client is not None else default_command(self.project_dir())
            error = None
            reachable = True
        except CivMcpError as exc:
            command = []
            error = str(exc)
            reachable = False
        return ProbeResult(
            reachable=reachable,
            driver=self.driver_id,
            game=self.game,
            error=error,
            capabilities=self._capabilities(),
            extras={"command": command, "project": self.project_dir()},
        )

    async def connect(self) -> Observation:
        try:
            if self._client is None:
                self._client = CivMcpClient(default_command(self.project_dir()))
                self._owns_client = True
            await self._client.start()
            self._tools = await self._client.list_tools(timeout=120)
            self._connected = True
            self._last_error = None
            try:
                overview = await self.call_tool("get_game_overview", {}, host=True)
                self._snapshot = {"overview": overview}
            except CivMcpError as exc:
                self._last_error = str(exc)
        except Exception as exc:
            self._connected = False
            self._last_error = str(exc)
            if self._client is not None and self._owns_client:
                await self._client.close()
            raise
        return self._obs()

    async def disconnect(self) -> Observation:
        if self._client is not None and self._owns_client:
            await self._client.close()
        self._connected = False
        return self._obs()

    async def observe(self) -> Observation:
        return self._obs()

    async def act(self, request: ActionRequest) -> ActionResult:
        action = (request.action or "").strip()
        if action == "query_state":
            try:
                overview = await self.call_tool("get_game_overview", {}, host=True)
                self._snapshot["overview"] = overview
                return ActionResult(ok=True, action=action, observation=self._obs(), extras={"text": overview})
            except Exception as exc:
                self._last_error = str(exc)
                return ActionResult(ok=False, action=action, error=str(exc), observation=self._obs())
        return ActionResult(
            ok=False,
            action=action,
            error="文明6动作由陪玩确认流程执行",
            observation=self._obs(),
        )

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None, *, host: bool = False) -> str:
        if not self._connected or self._client is None:
            raise CivMcpError("civilization mcp is not connected")
        args = dict(arguments or {})
        decision = classify(name, args, read_only=self._read_only(name))
        if decision == ActionClass.FORBIDDEN or name in FORBIDDEN_TOOLS:
            raise CivMcpError(f"forbidden tool {name}")
        if decision == ActionClass.HOST and not host:
            raise CivMcpError(f"host-only tool {name}")
        if not host and decision == ActionClass.CONFIRM:
            raise CivMcpError(f"confirmation required for {name}")
        if not host and decision == ActionClass.SAFE and not _truthy(self.config.get("CIV_SAFE_AUTO"), True):
            raise CivMcpError(f"confirmation required for {name}")
        text = await self._client.call_tool(name, args)
        self._recent.append({"name": name, "ok": not text.startswith("Error:"), "text": text[:240]})
        self._recent = self._recent[-8:]
        return text

    def note_snapshot(self, snapshot: Dict[str, Any], fingerprint: str, panel_ready: bool) -> None:
        self._snapshot = dict(snapshot)
        self._fingerprint = fingerprint
        self._panel_ready = panel_ready

    def _capabilities(self) -> List[Capability]:
        connected = self._connected
        reason = None if connected else (self._last_error or "not connected")
        return [
            Capability(id=cap_ids.STATE_QUERY, available=True),
            Capability(id=cap_ids.CIV_STATE_READ, available=connected, reason=reason),
            Capability(id=cap_ids.CIV_SAFE_ACTION, available=connected, reason=reason),
            Capability(id=cap_ids.CIV_CONFIRM_ACTION, available=connected, reason=reason),
            Capability(id=cap_ids.CIV_COMPANION_CHAT, available=connected and self._panel_ready, reason=None if self._panel_ready else "游戏内面板尚未握手"),
        ]

    def _obs(self) -> Observation:
        return Observation(
            game=self.game,
            driver=self.driver_id,
            connected=self._connected,
            username="companion",
            capabilities=self._capabilities(),
            recent_events=[{"type": "civ_tool", "data": item} for item in self._recent],
            extras={
                "project": self.project_dir(),
                "panel_ready": self._panel_ready,
                "fingerprint": self._fingerprint,
                "snapshot": self._snapshot,
                "tools": [tool.get("name") for tool in self._tools],
            },
            last_error=self._last_error,
        )


def _truthy(raw: Any, default: bool = True) -> bool:
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")
