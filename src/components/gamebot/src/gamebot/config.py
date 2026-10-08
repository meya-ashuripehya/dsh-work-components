"""服务配置（装配绑定，不含业务判断）。"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _truthy(raw: str, default: bool = True) -> bool:
    value = (raw or "").strip().lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8766
    evidence_dir: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        port_raw = _env("GAMEBOT_PORT", "8766")
        try:
            port = int(port_raw)
        except ValueError:
            port = 8766
        return cls(
            host=_env("GAMEBOT_HOST", "127.0.0.1") or "127.0.0.1",
            port=port,
            evidence_dir=_env("GAMEBOT_EVIDENCE_DIR", ""),
        )


settings = Settings.from_env()
