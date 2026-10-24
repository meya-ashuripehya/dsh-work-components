"""GameBot REST body（仅 API；设置页由 dsh-workbench 工作组件提供，已移除自带前端）。"""
import json

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from gamebot.api.members import router as members_router
from gamebot.api.routes import router
from gamebot.members import is_member_session, require_member_token

app = FastAPI(title="GameBot (dsh-work-components)", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _replay(body: bytes):
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


def _json_object(body: bytes) -> dict:
    try:
        payload = json.loads(body or b"{}")
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


@app.middleware("http")
async def guard_member_sessions(request: Request, call_next):
    path = request.url.path
    method = request.method.upper()
    session_root = path == "/v1/sessions" or (
        path.startswith("/v1/sessions/") and path.count("/") == 3
    )
    if method in {"POST", "PATCH"} and session_root:
        body = await request.body()
        request = Request(request.scope, _replay(body))
        payload = _json_object(body)
        config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
        session_id = str(payload.get("session_id") or "")
        if path.startswith("/v1/sessions/"):
            session_id = path[len("/v1/sessions/") :]
        if is_member_session(session_id) or "MC_AGENT_ID" in config or "MC_MEMBER_MANAGED" in config:
            return JSONResponse(
                status_code=403,
                content={"detail": "minecraft member sessions cannot be created or changed through /v1/sessions"},
            )
        return await call_next(request)
    marker = "/v1/sessions/"
    if path.startswith(marker):
        session_id = path[len(marker) :].split("/", 1)[0]
        if is_member_session(session_id):
            if method == "DELETE":
                return JSONResponse(
                    status_code=403,
                    content={"detail": "minecraft member sessions cannot be changed through /v1/sessions"},
                )
            try:
                require_member_token(request.headers.get("x-gamebot-member-token"))
            except Exception as exc:
                status = getattr(exc, "status_code", 401)
                detail = getattr(exc, "detail", "member token was rejected")
                return JSONResponse(status_code=status, content={"detail": detail})
    return await call_next(request)


app.include_router(router)
app.include_router(members_router)


def main() -> None:
    import uvicorn

    from gamebot.config import settings

    uvicorn.run("gamebot.api.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
