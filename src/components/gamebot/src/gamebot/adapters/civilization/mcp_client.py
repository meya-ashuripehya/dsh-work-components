"""GAMEBOT 侧的换行 JSON 客户端。真正的 MCP 会话在隔离工作进程里。"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional


class CivMcpError(RuntimeError):
    pass


def default_project_dir() -> Path:
    return Path(__file__).resolve().parents[5] / "civ6-mcp"


def worker_script() -> Path:
    return Path(__file__).resolve().with_name("mcp_worker.py")


def default_command(project_dir: str) -> List[str]:
    project = str(project_dir or default_project_dir())
    if not Path(project).exists():
        raise CivMcpError(f"civ6-mcp project not found: {project}")
    venv_python = Path(project) / ".venv" / "Scripts" / "python.exe"
    if venv_python.exists():
        return [str(venv_python), str(worker_script())]
    uv = shutil.which("uv")
    if not uv:
        raise CivMcpError("uv not found")
    return [uv, "run", "--project", project, "python", str(worker_script())]


class CivMcpClient:
    def __init__(self, command: List[str], *, cwd: Optional[str] = None) -> None:
        self.command = list(command)
        self.cwd = cwd
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._write_lock = asyncio.Lock()
        self._pending: Dict[str, asyncio.Future] = {}
        self._next_id = 0
        self.stderr_tail = ""

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["CIV_MCP_DISABLE_LUA"] = "1"
        self._pending = {}
        self._proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=env,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.returncode is None and proc.stdin is not None:
            try:
                await self.request("shutdown", {}, timeout=2)
            except Exception:
                pass
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        tasks = [task for task in (self._reader_task, self._stderr_task) if task is not None]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._fail_pending(CivMcpError("civ6 mcp worker closed"))
        self._reader_task = None
        self._stderr_task = None
        self._proc = None

    async def list_tools(self, timeout: float = 30) -> List[Dict[str, Any]]:
        result = await self.request("list_tools", {}, timeout=timeout)
        tools = result.get("tools") if isinstance(result, dict) else None
        return list(tools or [])

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None, timeout: float = 60) -> str:
        result = await self.request(
            "call_tool",
            {"name": name, "arguments": dict(arguments or {})},
            timeout=timeout,
        )
        if not isinstance(result, dict):
            return str(result)
        if result.get("is_error"):
            raise CivMcpError(str(result.get("text") or "tool error"))
        return str(result.get("text") or "")

    async def request(self, method: str, params: Dict[str, Any], timeout: float = 30) -> Dict[str, Any]:
        if not self.running or self._proc is None or self._proc.stdin is None or self._reader_task is None:
            raise CivMcpError("civ6 mcp worker is not running")
        self._next_id += 1
        request_id = str(self._next_id)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        payload = json.dumps(
            {"id": request_id, "method": method, "params": params},
            ensure_ascii=False,
        ).encode("utf-8") + b"\n"
        try:
            async with self._write_lock:
                if self._proc is None or self._proc.stdin is None:
                    raise CivMcpError("civ6 mcp worker is not running")
                self._proc.stdin.write(payload)
                await self._proc.stdin.drain()
            try:
                result = await asyncio.wait_for(future, timeout=timeout)
            except asyncio.TimeoutError as exc:
                raise CivMcpError(f"civ6 mcp worker timed out after {timeout}s") from exc
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
        return result if isinstance(result, dict) else {"value": result}

    def _fail_pending(self, exc: Exception) -> None:
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(CivMcpError(str(exc)))

    async def _read_stdout(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                self._fail_pending(CivMcpError(self.stderr_tail or "civ6 mcp worker closed"))
                return
            try:
                message = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                self._fail_pending(CivMcpError(f"invalid worker response: {raw[:180]!r}"))
                continue
            if not isinstance(message, dict):
                continue
            raw_id = message.get("id")
            request_id = "" if raw_id is None else str(raw_id)
            future = self._pending.get(request_id)
            if future is None or future.done():
                continue
            self._pending.pop(request_id, None)
            if not message.get("ok"):
                future.set_exception(CivMcpError(str(message.get("error") or "worker request failed")))
                continue
            result = message.get("result")
            future.set_result(result if isinstance(result, dict) else {"value": result})

    async def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                self.stderr_tail = (self.stderr_tail + "\n" + text)[-2000:]
