import asyncio
from typing import Any, Optional

import httpx
import pytest

from gamebot.api.app import app
from gamebot.session import manager


class SyncASGIClient:
    """httpx 0.28 不再支持 Starlette TestClient 的 app= 参数，用 ASGITransport 包一层同步调用。"""

    def __init__(self, asgi_app: Any) -> None:
        self.app = asgi_app

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        async def _go() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, url, **kwargs)

        return asyncio.run(_go())

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, json: Optional[dict] = None, **kwargs: Any) -> httpx.Response:
        return self._request("POST", url, json=json, **kwargs)

    def patch(self, url: str, json: Optional[dict] = None, **kwargs: Any) -> httpx.Response:
        return self._request("PATCH", url, json=json, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("DELETE", url, **kwargs)


@pytest.fixture(autouse=True)
def _isolate_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("GAMEBOT_MEMORY_DIR", str(tmp_path / "memory"))


@pytest.fixture
def client(tmp_path, monkeypatch):
    for rec in list(manager._sessions.values()):
        rec.brain.shutdown_now()
        companion = getattr(rec, "companion", None)
        if companion is not None:
            companion.shutdown_now()
    manager._sessions.clear()
    yield SyncASGIClient(app)
    for rec in list(manager._sessions.values()):
        rec.brain.shutdown_now()
        companion = getattr(rec, "companion", None)
        if companion is not None:
            companion.shutdown_now()
    manager._sessions.clear()
