"""在 civ6-mcp 的 Python 环境里把官方 MCP SDK 收成换行 JSON。

GAMEBOT 主进程不导入 mcp。本文件的标准输出只写 JSON 行，日志走标准错误。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from typing import Any


def _tool_payload(tool: Any) -> dict[str, Any]:
    annotations = getattr(tool, "annotations", None)
    read_only = bool(getattr(annotations, "readOnlyHint", False)) if annotations is not None else False
    destructive = bool(getattr(annotations, "destructiveHint", False)) if annotations is not None else False
    schema = getattr(tool, "inputSchema", None) or {"type": "object", "properties": {}}
    return {
        "name": tool.name,
        "description": str(getattr(tool, "description", "") or ""),
        "input_schema": schema,
        "annotations": {"readOnlyHint": read_only, "destructiveHint": destructive},
    }


def _tool_text(result: Any) -> dict[str, Any]:
    chunks = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            chunks.append(str(text))
    return {"text": "\n".join(chunks), "is_error": bool(getattr(result, "isError", False))}


def _emit(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()


async def _serve(session: Any) -> None:
    # 不能用 connect_read_pipe(stdin)。Windows 上它和子进程管道共用 Proactor 时
    # 会报 WinError 6，后面的工具列表就发不回来。
    loop = asyncio.get_running_loop()
    incoming: asyncio.Queue[bytes | None] = asyncio.Queue()

    def _read_stdin() -> None:
        try:
            while True:
                line = sys.stdin.buffer.readline()
                loop.call_soon_threadsafe(incoming.put_nowait, line or None)
                if not line:
                    break
        except Exception:
            loop.call_soon_threadsafe(incoming.put_nowait, None)

    threading.Thread(target=_read_stdin, daemon=True).start()
    while True:
        raw = await incoming.get()
        if not raw:
            break
        try:
            request = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            _emit({"id": None, "ok": False, "error": "invalid json"})
            continue
        request_id = request.get("id")
        method = str(request.get("method") or "")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        try:
            if method == "list_tools":
                listed = await session.list_tools()
                result = {"tools": [_tool_payload(tool) for tool in listed.tools]}
            elif method == "call_tool":
                name = str(params.get("name") or "")
                arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
                called = await session.call_tool(name, arguments)
                result = _tool_text(called)
            elif method == "shutdown":
                _emit({"id": request_id, "ok": True, "result": {"bye": True}})
                return
            else:
                _emit({"id": request_id, "ok": False, "error": f"unknown method {method}"})
                continue
        except Exception as exc:
            _emit({"id": request_id, "ok": False, "error": str(exc)})
            continue
        _emit({"id": request_id, "ok": True, "result": result})


async def main() -> None:
    os.environ["CIV_MCP_DISABLE_LUA"] = "1"
    os.environ["PYTHONUNBUFFERED"] = "1"
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except Exception as exc:
        _emit({"id": None, "ok": False, "error": f"mcp sdk unavailable: {exc}"})
        return
    # Windows 上把 sys.stderr 管道交给 asyncio 子进程会让 stdout 读取报 WinError 6。
    errlog = open(os.devnull, "w", encoding="utf-8")
    params = StdioServerParameters(
        command=sys.executable,
        args=["-u", "-m", "civ_mcp"],
        env=dict(os.environ),
    )
    async with stdio_client(params, errlog=errlog) as (read, write):
        async with ClientSession(read, write) as session:
            try:
                await session.initialize()
            except Exception as exc:
                _emit({"id": None, "ok": False, "error": f"mcp initialize failed: {exc}"})
                return
            await _serve(session)


if __name__ == "__main__":
    asyncio.run(main())
