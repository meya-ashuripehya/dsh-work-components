"""HTTP 路由层：配置、会话、能力、观察、动作。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from gamebot.bridge_process import start as start_bridge
from gamebot.bridge_process import status as bridge_status
from gamebot.bridge_process import stop as stop_bridge
from gamebot.mod_setup import describe_mod, install_for_game
from gamebot.brain.civilization_models import (
    CompanionChatRequest,
    CompanionProposalRequest,
    CompanionStatus,
    CompanionTurnResult,
)
from gamebot.brain.models import (
    BrainChatRequest,
    BrainDecideRequest,
    BrainStatus,
    BrainTaskRequest,
    BrainTaskResult,
    MemorySearchRequest,
    MemorySnapshot,
)
from gamebot.brain.generation import ui_schema as llm_generation_schema
from gamebot.brain.client import LLMError
from gamebot.brain.decision import DecisionParseError
from gamebot.config_store import GameConfig, ensure_provider_keys, get_game_config, list_games, save_game_config
from gamebot.contracts.models import (
    ActionRequest,
    ActionResult,
    CapabilitiesResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    EventsResponse,
    Observation,
    ProbeResult,
    SessionListResponse,
)
from gamebot.session import manager

router = APIRouter()


class HealthResponse(BaseModel):
    ok: bool = True
    service: str = "gamebot"
    sessions: int = 0


class GameListResponse(BaseModel):
    ok: bool = True
    games: List[GameConfig]
    provider_keys: Dict[str, str] = {}


class GameConfigResponse(BaseModel):
    ok: bool = True
    game: GameConfig
    provider_keys: Dict[str, str] = {}


class UpdateGameConfigRequest(BaseModel):
    driver: Optional[str] = None
    config: Dict[str, Any] = {}
    provider_keys: Optional[Dict[str, str]] = None


class ModInstallRequest(BaseModel):
    mods_dir: str = ""




@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(sessions=len(manager.list_sessions()))


@router.get("/v1/llm/generation")
async def llm_generation() -> Dict[str, Any]:
    return {"ok": True, **llm_generation_schema()}


@router.get("/v1/games", response_model=GameListResponse)
async def games() -> GameListResponse:
    return GameListResponse(games=list_games(), provider_keys=ensure_provider_keys())


@router.get("/v1/games/{game}", response_model=GameConfigResponse)
async def game_config(game: str) -> GameConfigResponse:
    try:
        cfg = get_game_config(game)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    return GameConfigResponse(game=cfg, provider_keys=ensure_provider_keys())


@router.patch("/v1/games/{game}", response_model=GameConfigResponse)
async def update_game_config(game: str, body: UpdateGameConfigRequest) -> GameConfigResponse:
    try:
        cfg = save_game_config(game, body.driver, body.config, body.provider_keys)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    return GameConfigResponse(game=cfg, provider_keys=ensure_provider_keys())


def _session_config(config: Dict[str, Any]) -> Dict[str, Any]:
    copied = dict(config)
    for field in ("LLM_API_KEY", "CHAT_API_KEY", "LLM_API_KEY_REF", "CHAT_API_KEY_REF"):
        if field in copied:
            copied[field] = ""
    return copied


@router.post("/v1/games/{game}/session", response_model=CreateSessionResponse)
async def create_game_session(game: str) -> CreateSessionResponse:
    try:
        cfg = get_game_config(game)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    session = manager.upsert(cfg.game, cfg.driver, _session_config(cfg.config), session_id=f"default-{cfg.game}")
    return CreateSessionResponse(session=session)


@router.get("/v1/games/{game}/bridge")
async def game_bridge_status(game: str) -> Dict[str, Any]:
    try:
        cfg = get_game_config(game)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    if cfg.game != "minecraft":
        raise HTTPException(status_code=400, detail="only minecraft has a node bridge")
    return bridge_status(cfg.config)


@router.post("/v1/games/{game}/bridge/start")
async def game_bridge_start(game: str) -> Dict[str, Any]:
    try:
        cfg = get_game_config(game)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    if cfg.game != "minecraft":
        raise HTTPException(status_code=400, detail="only minecraft has a node bridge")
    return start_bridge(cfg.config)


@router.post("/v1/games/{game}/bridge/stop")
async def game_bridge_stop(game: str) -> Dict[str, Any]:
    try:
        cfg = get_game_config(game)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="game not found") from e
    if cfg.game != "minecraft":
        raise HTTPException(status_code=400, detail="only minecraft has a node bridge")
    return stop_bridge(cfg.config)


@router.post("/v1/sessions", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    try:
        session = manager.upsert(body.game, body.driver, body.config, session_id=body.session_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return CreateSessionResponse(session=session)


@router.get("/v1/sessions", response_model=SessionListResponse)
async def list_sessions() -> SessionListResponse:
    return SessionListResponse(sessions=manager.list_sessions())


@router.get("/v1/sessions/{session_id}")
async def get_session(session_id: str) -> Dict[str, Any]:
    try:
        rec = manager.get(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    return {"ok": True, "session": rec.session.model_dump()}


class PatchSessionRequest(BaseModel):
    game: Optional[str] = None
    driver: Optional[str] = None
    config: Optional[Dict[str, Any]] = None


@router.patch("/v1/sessions/{session_id}")
async def patch_session(session_id: str, body: PatchSessionRequest) -> CreateSessionResponse:
    try:
        rec = manager.get(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    session = manager.upsert(
        body.game or rec.session.game,
        body.driver or rec.session.driver,
        body.config if body.config is not None else rec.session.config,
        session_id=session_id,
    )
    return CreateSessionResponse(session=session)


@router.delete("/v1/sessions/{session_id}")
async def delete_session(session_id: str) -> Dict[str, Any]:
    try:
        rec = manager.get(session_id)
        try:
            await rec.driver.disconnect()
        except Exception:
            pass
        manager.delete(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    return {"ok": True}


@router.post("/v1/sessions/{session_id}/probe", response_model=ProbeResult)
async def probe_session(session_id: str) -> ProbeResult:
    try:
        return await manager.probe(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e


@router.post("/v1/sessions/{session_id}/connect", response_model=Observation)
async def connect_session(session_id: str) -> Observation:
    try:
        return await manager.connect(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.post("/v1/sessions/{session_id}/disconnect", response_model=Observation)
async def disconnect_session(session_id: str) -> Observation:
    try:
        return await manager.disconnect(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e


@router.get("/v1/sessions/{session_id}/observe", response_model=Observation)
async def observe_session(session_id: str) -> Observation:
    try:
        return await manager.observe(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e


@router.get("/v1/sessions/{session_id}/capabilities", response_model=CapabilitiesResponse)
async def session_capabilities(session_id: str) -> CapabilitiesResponse:
    try:
        obs = await manager.observe(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    return CapabilitiesResponse(
        session_id=session_id,
        capabilities=obs.capabilities,
        version=obs.version,
        loader=obs.loader,
        mods=obs.mods,
    )


@router.post("/v1/sessions/{session_id}/actions", response_model=ActionResult)
async def run_action(session_id: str, body: ActionRequest) -> ActionResult:
    try:
        return await manager.act(session_id, body)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.get("/v1/sessions/{session_id}/events", response_model=EventsResponse)
async def session_events(session_id: str) -> EventsResponse:
    try:
        events = await manager.events(session_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e
    return EventsResponse(events=events)


def _brain(session_id: str):
    try:
        return manager.get(session_id).brain
    except KeyError as e:
        raise HTTPException(status_code=404, detail="session not found") from e


@router.get("/v1/sessions/{session_id}/brain", response_model=BrainStatus)
async def brain_status(session_id: str) -> BrainStatus:
    return _brain(session_id).status()


@router.post("/v1/sessions/{session_id}/brain/decide", response_model=BrainTaskResult)
async def brain_decide(session_id: str, body: BrainDecideRequest) -> BrainTaskResult:
    brain = _brain(session_id)
    role = "chat" if (body.player and body.message) else "decision"
    try:
        decision = await brain.decide(
            goal=body.goal,
            player=body.player,
            message=body.message,
            role=role,
        )
    except (LLMError, DecisionParseError) as e:
        brain.last_error = str(e)
        return BrainTaskResult(ok=False, error=str(e), source="decide")
    return BrainTaskResult(ok=True, decision=decision, executed=False, source="decide")


@router.post("/v1/sessions/{session_id}/brain/tasks", response_model=BrainTaskResult)
async def brain_task(session_id: str, body: BrainTaskRequest) -> BrainTaskResult:
    if not (body.goal or "").strip():
        raise HTTPException(status_code=400, detail="goal is required")
    return await _brain(session_id).run_task(
        body.goal,
        max_steps=body.max_steps,
        interrupt=body.interrupt,
        execute=body.execute,
    )


@router.post("/v1/sessions/{session_id}/brain/chat", response_model=BrainTaskResult)
async def brain_chat(session_id: str, body: BrainChatRequest) -> BrainTaskResult:
    if not (body.player or "").strip() or not (body.message or "").strip():
        raise HTTPException(status_code=400, detail="player and message are required")
    return await _brain(session_id).handle_chat(body.player, body.message, source="api", force=True)


@router.post("/v1/sessions/{session_id}/brain/cancel")
async def brain_cancel(session_id: str) -> Dict[str, Any]:
    interrupted = await _brain(session_id).runner.cancel()
    return {"ok": True, "interrupted": interrupted}


@router.get("/v1/sessions/{session_id}/memory", response_model=MemorySnapshot)
async def memory_snapshot(session_id: str) -> MemorySnapshot:
    mem = _brain(session_id).memory()
    if mem is None:
        return MemorySnapshot(ok=True, namespace="", counts={})
    snap = mem.snapshot()
    return MemorySnapshot(ok=True, **snap)


@router.post("/v1/sessions/{session_id}/memory/search", response_model=MemorySnapshot)
async def memory_search(session_id: str, body: MemorySearchRequest) -> MemorySnapshot:
    mem = _brain(session_id).memory()
    if mem is None:
        return MemorySnapshot(ok=True, namespace="", text="", evidence_ok=False, missing=["memory disabled"])
    found = mem.search(body.query or "")
    return MemorySnapshot(ok=True, **found)


def _companion(session_id: str):
    try:
        rec = manager.get(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
    if rec.companion is None:
        raise HTTPException(status_code=400, detail="session has no civilization companion")
    return rec.companion


@router.get("/v1/games/{game}/mod")
async def game_mod_status(game: str) -> Dict[str, Any]:
    try:
        return describe_mod(game)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="game not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/v1/games/{game}/mod/install")
async def game_mod_install(game: str, body: ModInstallRequest) -> Dict[str, Any]:
    try:
        return install_for_game(game, body.mods_dir)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="game not found") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/v1/sessions/{session_id}/companion", response_model=CompanionStatus)
async def companion_status(session_id: str) -> CompanionStatus:
    return _companion(session_id).status()


@router.post("/v1/sessions/{session_id}/companion/chat", response_model=CompanionTurnResult)
async def companion_chat(session_id: str, body: CompanionChatRequest) -> CompanionTurnResult:
    if not (body.text or "").strip():
        raise HTTPException(status_code=400, detail="text is required")
    return await _companion(session_id).chat(body.text)


@router.post("/v1/sessions/{session_id}/companion/analyze", response_model=CompanionTurnResult)
async def companion_analyze(session_id: str) -> CompanionTurnResult:
    return await _companion(session_id).analyze(trigger="analyze")


@router.post("/v1/sessions/{session_id}/companion/approve", response_model=CompanionTurnResult)
async def companion_approve(session_id: str, body: CompanionProposalRequest) -> CompanionTurnResult:
    if not (body.proposal_id or "").strip():
        raise HTTPException(status_code=400, detail="proposal_id is required")
    return await _companion(session_id).approve(body.proposal_id)


@router.post("/v1/sessions/{session_id}/companion/reject", response_model=CompanionTurnResult)
async def companion_reject(session_id: str, body: CompanionProposalRequest) -> CompanionTurnResult:
    if not (body.proposal_id or "").strip():
        raise HTTPException(status_code=400, detail="proposal_id is required")
    return await _companion(session_id).reject(body.proposal_id)


@router.post("/v1/sessions/{session_id}/companion/pause", response_model=CompanionTurnResult)
async def companion_pause(session_id: str) -> CompanionTurnResult:
    return await _companion(session_id).pause()


@router.post("/v1/sessions/{session_id}/companion/resume", response_model=CompanionTurnResult)
async def companion_resume(session_id: str) -> CompanionTurnResult:
    return await _companion(session_id).resume()
