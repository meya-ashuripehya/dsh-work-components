"""Read and continue one DSH session transcript.

New lines go through the in-host bridge so the live session keeps its own sequence
numbers. Reading the log file is only the fallback when that session is not open.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional


_SCRIPT = Path(__file__).with_name("dsh_session_io.mjs")
_DSH_EXE = Path(os.environ.get("DSH_DESKTOP_EXE") or r"C:\Program Files\DSH Desktop\DSH Desktop.exe")
_BRIDGE = os.environ.get("CIV_DSH_BRIDGE") or os.environ.get("GAMEBOT_DSH_BRIDGE") or "http://127.0.0.1:8771"


def resolve_dsh_token(
    config: Optional[Mapping[str, Any]] = None,
    *,
    keys: tuple[str, ...] = ("DSH_SESSION", "MC_DSH_SESSION", "CIV_DSH_SESSION"),
) -> str:
    data = dict(config or {})
    for key in keys:
        token = str(data.get(key) or "").strip()
        if token:
            return token
    return ""


def dsh_root() -> Path:
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))


def encode_cwd(cwd: str) -> str:
    text = cwd.replace("/", "\\").replace(":", "")
    return "--" + text.replace("\\", "-") + "--"


def _runtime() -> List[str]:
    if _DSH_EXE.is_file():
        return [str(_DSH_EXE)]
    return ["node"]


def _run(args: List[str], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    env = os.environ.copy()
    if Path(args[0]).name.lower().startswith("dsh"):
        env["ELECTRON_RUN_AS_NODE"] = "1"
    completed = subprocess.run(
        args,
        input=None if payload is None else json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        env=env,
        timeout=40,
        check=False,
    )
    raw = (completed.stdout or "").strip()
    if not raw:
        raise RuntimeError((completed.stderr or "DSH session tool produced no output").strip()[:300])
    parsed = json.loads(raw.splitlines()[-1])
    if not parsed.get("ok"):
        raise RuntimeError(str(parsed.get("error") or "DSH session tool failed")[:300])
    return parsed


def find_session_file(token: str, root: Optional[Path] = None) -> Optional[Path]:
    text = str(token or "").strip()
    if not text:
        return None
    base = root or dsh_root()
    direct = Path(text)
    if direct.is_file():
        return direct
    if direct.is_dir() and (direct / "session.v3.jsonl.zstd").is_file():
        return direct / "session.v3.jsonl.zstd"
    sessions = base / "sessions"
    if sessions.is_dir():
        exact = list(sessions.glob(f"**/{text}/session.v3.jsonl.zstd"))
        if len(exact) == 1:
            return exact[0]
    cache = base / "storages" / "session_projcache" / "sessions"
    if not cache.is_dir():
        return None
    needle = text.lower()
    for path in cache.glob("*.json"):
        head = path.read_text(encoding="utf-8", errors="ignore")[:12000]
        if needle not in head.lower():
            continue
        match = re.search(r'"cwd"\s*:\s*"([^"]+)"', head)
        if not match:
            continue
        candidate = sessions / encode_cwd(match.group(1).replace("\\\\", "\\")) / path.stem / "session.v3.jsonl.zstd"
        if candidate.is_file():
            return candidate
    return None


def _bridge(method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        _BRIDGE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            message = str(json.loads(raw).get("error") or raw)
        except json.JSONDecodeError:
            message = raw
        raise RuntimeError(message[:300] or f"DSH 陪玩桥返回 {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("DSH 陪玩桥没有启动") from exc
    if not parsed.get("ok"):
        raise RuntimeError(str(parsed.get("error") or "DSH 陪玩桥失败")[:300])
    return parsed


class DshTranscript:
    def __init__(self, token: str, root: Optional[Path] = None) -> None:
        self.token = str(token or "").strip()
        self.root = root
        self._cache_key: Optional[tuple] = None
        self._cache_rows: List[Dict[str, str]] = []

    def path(self) -> Optional[Path]:
        return find_session_file(self.token, self.root)

    def recent(self, limit: int = 8) -> List[Dict[str, str]]:
        try:
            parsed = _bridge("GET", "/recent?token=" + urllib.parse.quote(self.token) + f"&limit={limit}")
            rows = _rows(parsed.get("messages") or [])
            self._cache_key = ("bridge", self.token, limit, len(rows))
            self._cache_rows = rows
            return list(rows)
        except RuntimeError:
            pass
        path = self.path()
        if path is None:
            return []
        stat = path.stat()
        key = (stat.st_mtime_ns, stat.st_size, limit)
        if key == self._cache_key:
            return list(self._cache_rows)
        parsed = _run([*_runtime(), str(_SCRIPT), "tail", str(path), str(limit)])
        rows = _rows(parsed.get("messages") or [])
        self._cache_key = key
        self._cache_rows = rows
        return list(rows)

    def append_exchange(self, user: str, assistant: str, provider: str, model: str) -> None:
        _bridge(
            "POST",
            "/exchange",
            {"token": self.token, "user": user, "assistant": assistant, "provider": provider, "model": model},
        )
        self._cache_key = None


def _rows(items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    return [
        {"role": "assistant" if item.get("role") == "assistant" else "user", "text": str(item.get("text") or "")}
        for item in items
        if str(item.get("text") or "").strip()
    ]
