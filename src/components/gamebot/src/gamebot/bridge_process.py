"""Mineflayer Node 桥接进程管理。只做 IO，不做业务决策。"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

_proc: Optional[subprocess.Popen] = None


def _bridge_dir() -> Path:
    raw = (os.getenv("GAMEBOT_MINECRAFT_BRIDGE_DIR") or "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parents[2] / "minecraft-bridge"


def _bridge_port(config: Optional[Dict[str, Any]] = None) -> int:
    cfg = config or {}
    raw = str(cfg.get("MC_BRIDGE_PORT") or os.getenv("MC_BRIDGE_PORT") or "3100")
    try:
        return int(raw)
    except ValueError:
        return 3100


def _health_url(port: int) -> str:
    return f"http://127.0.0.1:{port}/health"


def _health_ok(port: int) -> bool:
    try:
        r = httpx.get(_health_url(port), timeout=1.5)
        return r.status_code == 200
    except Exception:
        return False


def status(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    port = _bridge_port(config)
    running = _proc is not None and _proc.poll() is None
    healthy = _health_ok(port)
    return {
        "ok": True,
        "serviceRunning": running or healthy,
        "healthOk": healthy,
        "pid": _proc.pid if running else None,
        "bridgePort": port,
        "bridgeDir": str(_bridge_dir()),
        "error": None if (running or healthy) else "bridge is not running",
    }


def start(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    global _proc
    port = _bridge_port(config)
    bridge_dir = _bridge_dir()
    server_js = bridge_dir / "server.js"
    node_modules = bridge_dir / "node_modules"
    if not server_js.exists():
        return {
            "ok": False,
            "serviceRunning": False,
            "healthOk": False,
            "bridgePort": port,
            "error": f"未找到桥接脚本: {server_js}",
        }
    if not node_modules.exists():
        return {
            "ok": False,
            "serviceRunning": False,
            "healthOk": False,
            "bridgePort": port,
            "error": f"请先在 {bridge_dir} 执行 npm install",
        }
    if _health_ok(port):
        return status(config)

    env = os.environ.copy()
    cfg = config or {}
    for key, fallback in (
        ("MC_HOST", "127.0.0.1"),
        ("MC_PORT", "25565"),
        ("MC_USERNAME", "YUKI"),
        ("MC_VERSION", "1.21.1"),
        ("MC_AUTH", "offline"),
        ("MC_BRIDGE_PORT", str(port)),
        ("MC_ARCHIVE", "shiro"),
        ("ATRI_BASE_URL", "http://127.0.0.1:8000"),
    ):
        env[key] = str(cfg.get(key) or env.get(key) or fallback)

    log_dir = bridge_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "bridge.log"
    log_file = open(log_path, "a", encoding="utf-8")
    _proc = subprocess.Popen(
        [env.get("ATRI_NODE") or env.get("GAMEBOT_NODE") or "node", "server.js"],
        cwd=str(bridge_dir),
        env=env,
        stdout=log_file,
        stderr=log_file,
        stdin=subprocess.DEVNULL,
    )
    for _ in range(20):
        if _health_ok(port):
            break
        time.sleep(0.25)
    result = status(config)
    if not result["healthOk"]:
        result["ok"] = False
        result["error"] = "桥接服务启动超时，请检查端口或日志"
    return result


def stop(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    global _proc
    if _proc and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None
    result = status(config)
    result["error"] = None
    return result
