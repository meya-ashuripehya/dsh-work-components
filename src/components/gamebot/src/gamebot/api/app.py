"""GameBot REST body（仅 API；设置页由 dsh-workbench 工作组件提供，已移除自带前端）。"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from gamebot.api.routes import router

app = FastAPI(title="GameBot (dsh-work-components)", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


def main() -> None:
    import uvicorn

    from gamebot.config import settings

    uvicorn.run("gamebot.api.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
