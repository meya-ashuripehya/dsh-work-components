"""会话级大脑：观察 → LLM 决策 → 经 SessionManager.act 执行。"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, TYPE_CHECKING

from gamebot.adapters.civilization.dsh_link import DshTranscript, resolve_dsh_token
from gamebot.adapters.minecraft.protocol import parse_incoming_chat
from gamebot.brain.client import LLMClient, LLMError
from gamebot.brain.decision import DecisionParseError, parse_decision
from gamebot.brain.models import BrainStatus, BrainTaskResult, Decision
from gamebot.brain.goal import action_fingerprint, skip_completed
from gamebot.brain.prompt import build_messages, resolve_persona
from gamebot.brain.runner import ActionRunner
from gamebot.brain.settings import LLMSettings, chat_settings, decision_settings
from gamebot.brain.work_mode import canonical_mode, work_brief
from gamebot.contracts.models import ActionRequest, ActionResult, Observation
from gamebot.memory.extract import classify_chat
from gamebot.memory.service import MemoryService
from gamebot.memory.store import safe_namespace

if TYPE_CHECKING:
    from gamebot.session import SessionManager

ChatKey = Tuple[str, str, str]
DSH_PENDING_LIMIT = 40
DSH_INCOMING_CHARS = 1800
DSH_OUTGOING_CHARS = 3500


def dsh_outbox_path() -> Path:
    return Path.cwd() / "data" / "mc-dsh-outbox.json"


def _load_outbox(session_id: str) -> List[Dict[str, str]]:
    path = dsh_outbox_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get(session_id) if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and item.get("user") and item.get("assistant")]


def _save_outbox(session_id: str, items: List[Dict[str, str]]) -> None:
    path = dsh_outbox_path()
    data: Dict[str, Any] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            data = {}
    if items:
        data[session_id] = items[-DSH_PENDING_LIMIT:]
    else:
        data.pop(session_id, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _clip(text: str, limit: int) -> str:
    body = str(text or "").strip()
    if len(body) <= limit:
        return body
    return body[: limit - 1] + "…"


def _pack_brain_exchange(
    *,
    player: Optional[str],
    message: Optional[str],
    decision: Decision,
) -> Optional[Tuple[str, str]]:
    """DSH 只保留双方说出口的话。理由、目标和动作不是发言。"""
    say = (decision.say or "").strip()
    spoken = (message or "").strip()
    if not say or not (player and spoken):
        return None
    user = _clip(f"[User] {player}: {spoken}", DSH_INCOMING_CHARS)
    assistant = _clip(f"[ASSISTANT] {_clip(say, 800)}", DSH_OUTGOING_CHARS)
    return user, assistant


def _truthy(raw: Any, default: bool = True) -> bool:
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")


class BrainService:
    def __init__(self, session_id: str, manager: "SessionManager") -> None:
        self.session_id = session_id
        self._manager = manager
        self._client = LLMClient()
        self.runner = ActionRunner(self._act)
        self._poll_task: Optional[asyncio.Task] = None
        self._goal_task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._running = False
        self._seen_chat: Set[ChatKey] = set()
        self._chat_busy = False
        self._goal_busy = False
        self._last_chat_at = 0.0
        self._skip_once: Optional[str] = None
        self._bound_agent_id: Optional[str] = None
        self.last_error: Optional[str] = None
        self.last_reason: Optional[str] = None
        self.last_source: Optional[str] = None
        self.current_goal: Optional[str] = None
        self.work_mode = "rest"
        self._rest_after_directed = False
        self._planning_work = False
        self.last_chat_directive: Optional[str] = None
        self._mem: Optional[MemoryService] = None
        self._dsh_link: Optional[DshTranscript] = None
        self._dsh_token = ""
        self._dsh_pending: List[Dict[str, str]] = _load_outbox(session_id)
        self._dsh_retry_at = 0.0
        self._dsh_hydrated = False

    def settings(self) -> LLMSettings:
        return decision_settings(self._config())

    def chat_model(self) -> LLMSettings:
        return chat_settings(self._config())

    def _memory_on(self) -> bool:
        return _truthy(self._config().get("MEMORY_ENABLED"), True)

    def memory(self) -> Optional[MemoryService]:
        if not self._memory_on():
            return None
        namespace = str(self._config().get("MC_ARCHIVE") or self.session_id)
        try:
            block_size = int(self._config().get("MEMORY_BLOCK_SIZE") or 6)
        except (TypeError, ValueError):
            block_size = 6
        if self._mem is None or self._mem.namespace != safe_namespace(namespace):
            if self._mem is not None:
                self._mem.store.close()
            self._mem = MemoryService(namespace, block_size=block_size)
            self._dsh_hydrated = False
        self._hydrate_dsh(self._mem)
        return self._mem

    def _config(self) -> Dict[str, Any]:
        return dict(self._manager.get(self.session_id).session.config or {})

    def _bot_name(self) -> str:
        binding = self._actor_binding()
        if binding.get("actor_type") == "server_npc" and binding.get("username"):
            return str(binding["username"])
        return str(self._config().get("MC_USERNAME") or self._config().get("username") or "").strip()

    def _actor_binding(self) -> Dict[str, Any]:
        try:
            rec = self._manager.get(self.session_id)
        except KeyError:
            return {}
        binder = getattr(rec.driver, "actor_binding", None)
        if not callable(binder):
            return {}
        binding = binder()
        return binding if isinstance(binding, dict) else {}

    def _sync_agent(self) -> None:
        binding = self._actor_binding()
        agent_id = binding.get("agent_id")
        if agent_id and agent_id != self._bound_agent_id:
            self._bound_agent_id = str(agent_id)
            self._skip_once = None
        try:
            rec = self._manager.get(self.session_id)
        except KeyError:
            return
        setter = getattr(rec.driver, "set_actor_goal", None)
        if callable(setter):
            setter(self.current_goal)

    def _npc_mode(self) -> bool:
        return self._actor_binding().get("actor_type") == "server_npc"

    def _goal_interval(self) -> float:
        try:
            seconds = float(self._config().get("GOAL_INTERVAL_SEC") or 8)
        except (TypeError, ValueError):
            seconds = 8.0
        return max(2.0, seconds)

    def _persona(self, role: str) -> str:
        return resolve_persona(self._config(), role)

    async def _act(self, request: ActionRequest) -> ActionResult:
        return await self._manager.act(self.session_id, request)

    async def _observe(self) -> Observation:
        return await self._manager.observe(self.session_id)

    def shutdown_now(self) -> None:
        self._running = False
        self._wake.set()
        for task in (self._poll_task, self._goal_task):
            if task is not None and not task.done():
                task.cancel()
        self._poll_task = None
        self._goal_task = None
        task = self.runner._task
        if task is not None and not task.done():
            task.cancel()
        if self._mem is not None:
            self._mem.store.close()
            self._mem = None
        self._flush_dsh()
        try:
            rec = self._manager.get(self.session_id)
        except KeyError:
            return
        setter = getattr(rec.driver, "set_chat_handler", None)
        if callable(setter):
            setter(None)

    async def shutdown(self) -> None:
        self.shutdown_now()
        await self.runner.cancel()

    def attach_driver(self) -> None:
        rec = self._manager.get(self.session_id)
        setter = getattr(rec.driver, "set_chat_handler", None)
        if callable(setter):
            setter(self._on_driver_chat)

    def start(self) -> None:
        self.attach_driver()
        self._running = True
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_loop())
        if self._goal_task is None or self._goal_task.done():
            self._goal_task = asyncio.create_task(self._goal_loop())

    def _on_driver_chat(self, player: str, message: str):
        return self.handle_chat(player, message, source="driver")

    def _chat_key(self, player: str, message: str, at: Any = None) -> ChatKey:
        stamp = str(at if at is not None else round(time.time(), 1))
        return (player, message, stamp)

    def _remember_existing_events(self, events: list) -> None:
        bot = self._bot_name()
        for event in events:
            chat = _event_to_chat(event, bot)
            if chat:
                player, message, at = chat
                self._seen_chat.add(self._chat_key(player, message, at))

    async def _poll_loop(self) -> None:
        primed = False
        while self._running:
            try:
                events = await self._manager.events(self.session_id)
                if not primed:
                    self._remember_existing_events(events)
                    primed = True
                else:
                    await self._ingest_events(events)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            self._flush_dsh()
            await asyncio.sleep(1.0)

    async def _goal_loop(self) -> None:
        while self._running:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._goal_interval())
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                raise
            self._wake.clear()
            if not self._running or not self._should_plan():
                continue
            self._goal_busy = True
            try:
                if self.current_goal:
                    await self.run_task(self.current_goal, interrupt=False)
                elif self.work_mode != "rest":
                    await self._tick_work()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            finally:
                self._goal_busy = False
            await asyncio.sleep(1.0)

    def _should_plan(self) -> bool:
        if not self._npc_mode():
            return False
        if self.runner.busy or self._chat_busy or self._goal_busy:
            return False
        if not self.settings().enabled:
            return False
        return bool(self.current_goal) or self.work_mode != "rest"

    async def _ingest_events(self, events: list) -> None:
        bot = self._bot_name()
        for event in events:
            chat = _event_to_chat(event, bot)
            if not chat:
                continue
            player, message, at = chat
            key = self._chat_key(player, message, at)
            if key in self._seen_chat:
                continue
            self._seen_chat.add(key)
            if len(self._seen_chat) > 80:
                extra = list(self._seen_chat)[:20]
                for item in extra:
                    self._seen_chat.discard(item)
            asyncio.create_task(self.handle_chat(player, message, source="poll"))

    def _chat_allowed(self, player: str, message: str) -> bool:
        cfg = self._config()
        if not _truthy(cfg.get("MC_CHAT_FORWARD"), True):
            return False
        bot = self._bot_name()
        if not player or not message or (bot and player == bot):
            return False
        prefix = str(cfg.get("MC_CHAT_PREFIX") or "").strip()
        if prefix and prefix not in message:
            return False
        try:
            cooldown = int(cfg.get("MC_CHAT_COOLDOWN_MS") or 3000)
        except (TypeError, ValueError):
            cooldown = 3000
        now = time.time()
        if self._chat_busy or (now - self._last_chat_at) * 1000 < cooldown:
            return False
        return True

    async def decide(
        self,
        *,
        goal: Optional[str] = None,
        player: Optional[str] = None,
        message: Optional[str] = None,
        max_steps: Optional[int] = None,
        role: str = "decision",
    ) -> Decision:
        settings = self.chat_model() if role == "chat" else self.settings()
        missing = settings.missing_reason()
        if missing:
            raise LLMError(missing)
        obs = await self._observe()
        query = " ".join(part for part in (message, goal, self.current_goal) if part)
        recalled = {"text": "", "evidence_ok": True, "events": []}
        mem = self.memory()
        if mem is not None:
            recalled = mem.context(query)
        messages = build_messages(
            obs,
            goal=goal,
            player=player,
            message=message,
            current_goal=self.current_goal,
            work_mode=self.work_mode,
            last_chat_directive=self.last_chat_directive if role == "decision" else None,
            memory_text=str(recalled.get("text") or ""),
            dialogue_text=self._dialogue_text(),
            evidence_ok=bool(recalled.get("evidence_ok", True)),
            role=role,
            persona=self._persona(role),
        )
        raw = await self._client.complete(settings, messages)
        decision = parse_decision(raw, max_steps=max_steps or settings.max_steps)
        if mem is not None and decision.memory_used:
            mem.adopt(decision.memory_used)
        if role == "chat":
            self._apply_chat_influence(player, message, decision)
        elif decision.goal and not self._planning_work:
            self.current_goal = decision.goal[:200]
        self.last_error = None
        self.last_reason = decision.reason or None
        self._record_dsh(player=player, message=message, decision=decision)
        return decision

    def _apply_chat_influence(self, player: Optional[str], message: Optional[str], decision: Decision) -> None:
        text = (message or "").strip()
        name = (player or "").strip()
        if not text:
            if decision.goal:
                self.current_goal = decision.goal[:200]
            return
        kind = classify_chat(text)
        if decision.goal:
            self.current_goal = decision.goal[:200]
        elif kind == "plan":
            self.current_goal = text[:200]
        if decision.goal or kind in ("plan", "preference"):
            suffix = ""
            if self.current_goal and self.current_goal != text:
                suffix = f" => {self.current_goal}"
            self.last_chat_directive = f"{name}: {text}{suffix}" if name else f"{text}{suffix}"
        self._apply_work_mode(decision, kind)

    def _apply_work_mode(self, decision: Decision, kind: str) -> None:
        """模式切换留下继续干的日程。带动作、又没指定新模式的一句，是打断，做完回休息。"""
        chosen = canonical_mode(decision.mode)
        directed = bool(decision.actions)
        self._rest_after_directed = False
        if chosen and chosen != "rest":
            self.work_mode = chosen
            if not decision.goal:
                self.current_goal = None
            self._wake.set()
            return
        if chosen == "rest" and not directed:
            self.work_mode = "rest"
            return
        if directed and self.work_mode != "rest":
            self._rest_after_directed = True

    def _finish_directed_interrupt(self, decision: Decision) -> None:
        if not self._rest_after_directed:
            return
        if not decision.actions:
            self._rest_after_directed = False
            return
        self.work_mode = "rest"
        self._rest_after_directed = False

    async def _tick_work(self) -> None:
        brief = work_brief(self.work_mode)
        if not brief:
            return
        started = self.work_mode
        self.last_source = "work"
        self._planning_work = True
        try:
            decision = await self.decide(goal=brief, role="decision")
        except (LLMError, DecisionParseError) as exc:
            self.last_error = str(exc)
            return
        finally:
            self._planning_work = False
        if self._chat_busy or self._rest_after_directed or self.work_mode != started:
            return
        chosen = canonical_mode(decision.mode)
        decision = self._without_repeated(decision)
        if decision.actions and not decision.skip and not decision.wait:
            results = await self.runner.run_decision(decision, interrupt=False)
            self._note_completed(decision, results)
        elif decision.say:
            await self._act(ActionRequest(action="say", params={"text": decision.say}))
        if (
            chosen
            and self.work_mode == started
            and not self._chat_busy
            and not self._rest_after_directed
        ):
            self.work_mode = chosen

    async def run_task(
        self,
        goal: str,
        *,
        max_steps: Optional[int] = None,
        interrupt: bool = True,
        execute: bool = True,
    ) -> BrainTaskResult:
        self.current_goal = (goal or "").strip() or None
        self.last_source = "task"
        self._sync_agent()
        try:
            decision = await self.decide(goal=self.current_goal, max_steps=max_steps, role="decision")
        except (LLMError, DecisionParseError) as e:
            self.last_error = str(e)
            return BrainTaskResult(ok=False, error=str(e), source="task")
        decision = self._without_repeated(decision)
        if not execute:
            return BrainTaskResult(ok=True, decision=decision, executed=False, source="task")
        interrupted = False
        if interrupt or decision.stop_current:
            interrupted = await self.runner.cancel()
        results = await self.runner.run_decision(decision, interrupt=False)
        self._note_completed(decision, results)
        self._poke_goal(decision, from_chat=False)
        mem = self.memory()
        if mem is not None:
            mem.remember_interaction(
                reason=decision.reason,
                say=decision.say or "",
                goal=self.current_goal or "",
                source="task",
            )
        return BrainTaskResult(
            ok=True,
            decision=decision,
            results=results,
            interrupted=interrupted,
            executed=True,
            source="task",
        )

    async def handle_chat(
        self,
        player: str,
        message: str,
        *,
        source: str = "chat",
        force: bool = False,
    ) -> BrainTaskResult:
        text = (message or "").strip()
        name = (player or "").strip()
        if not force and not self._chat_allowed(name, text):
            return BrainTaskResult(ok=True, error=None, source="chat_ignored")
        settings = self.chat_model()
        if not settings.enabled:
            return BrainTaskResult(ok=True, error=None, source="chat_disabled")
        self._chat_busy = True
        self._last_chat_at = time.time()
        self.last_source = source
        self._sync_agent()
        try:
            try:
                decision = await self.decide(player=name, message=text, role="chat")
            except (LLMError, DecisionParseError) as e:
                self.last_error = str(e)
                await self._fail_say("我现在没法好好想，稍后再试。")
                return BrainTaskResult(ok=False, error=str(e), source="chat")
            results = []
            interrupted = False
            decision = self._without_repeated(decision)
            if decision.actions:
                if decision.stop_current:
                    interrupted = await self.runner.cancel()
                results = await self.runner.run_decision(decision, interrupt=False)
                self._note_completed(decision, results)
                self._finish_directed_interrupt(decision)
            elif decision.say:
                self._rest_after_directed = False
                results = [await self._act(ActionRequest(action="say", params={"text": decision.say}))]
            else:
                self._rest_after_directed = False
            self._poke_goal(decision, from_chat=True)
            mem = self.memory()
            if mem is not None:
                mem.remember_interaction(
                    player=name,
                    message=text,
                    say=decision.say or "",
                    reason=decision.reason,
                    goal=self.current_goal or "",
                    source="chat",
                )
            return BrainTaskResult(
                ok=True,
                decision=decision,
                results=results,
                interrupted=interrupted,
                executed=True,
                source="chat",
            )
        finally:
            self._chat_busy = False

    def _without_repeated(self, decision: Decision) -> Decision:
        kept, self._skip_once = skip_completed(decision.actions, self._skip_once)
        decision.actions = kept
        return decision

    def _note_completed(self, decision: Decision, results: list) -> None:
        last = None
        for planned, result in zip(decision.actions, results):
            if getattr(result, "ok", False):
                last = action_fingerprint(planned.action, dict(planned.params or {}))
        if last:
            self._skip_once = last

    def _poke_goal(self, decision: Decision, *, from_chat: bool) -> None:
        if not self._npc_mode():
            return
        if decision.skip or decision.wait:
            return
        if not self.current_goal and self.work_mode == "rest":
            return
        if decision.actions or from_chat or self.work_mode != "rest":
            self._wake.set()

    async def _fail_say(self, text: str) -> None:
        try:
            await self._act(ActionRequest(action="say", params={"text": text}))
        except Exception:
            pass

    def status(self) -> BrainStatus:
        settings = self.settings()
        chat = self.chat_model()
        mem = self.memory()
        counts = mem.store.counts() if mem is not None else {}
        return BrainStatus(
            session_id=self.session_id,
            enabled=settings.enabled or chat.enabled,
            running=self._running,
            busy=self.runner.busy or self._chat_busy,
            provider=settings.provider,
            protocol=settings.protocol,
            model=settings.model,
            base_url=settings.base_url,
            last_error=self.last_error,
            last_reason=self.last_reason,
            last_source=self.last_source,
            current_goal=self.current_goal,
            work_mode=self.work_mode,
            last_chat_directive=self.last_chat_directive,
            chat_provider=chat.provider,
            chat_protocol=chat.protocol,
            chat_model=chat.model,
            memory_enabled=self._memory_on(),
            memory_namespace="" if mem is None else mem.namespace,
            memory_turns=int(counts.get("turns") or 0),
            memory_events=int(counts.get("events") or 0),
        )


    def _dsh(self) -> Optional[DshTranscript]:
        token = resolve_dsh_token(self._config())
        if not token:
            return None
        if self._dsh_link is None or self._dsh_token != token:
            self._dsh_token = token
            self._dsh_link = DshTranscript(token)
            self._dsh_hydrated = False
        return self._dsh_link

    def _dialogue_text(self) -> str:
        link = self._dsh()
        if link is None:
            return ""
        try:
            rows = link.recent(12)
        except Exception:
            return ""
        lines = []
        for row in rows:
            speaker = "我" if row.get("role") == "assistant" else "玩家"
            text = str(row.get("text") or "").strip()
            if text:
                lines.append(f"{speaker}：{text[:800]}")
        return "\n".join(lines)

    def _hydrate_dsh(self, mem: MemoryService) -> None:
        if self._dsh_hydrated:
            return
        link = self._dsh()
        if link is None:
            return
        self._dsh_hydrated = True
        if int(mem.store.counts().get("turns") or 0) > 0:
            return
        try:
            rows = link.recent(40)
        except Exception:
            return
        for row in rows:
            text = str(row.get("text") or "").strip()
            if not text:
                continue
            role = "assistant" if row.get("role") == "assistant" else "user"
            mem.record_turn(role, text, actor="dsh", source="dsh")

    def _record_dsh(
        self,
        *,
        player: Optional[str],
        message: Optional[str],
        decision: Decision,
    ) -> None:
        link = self._dsh()
        if link is None:
            return
        packed = _pack_brain_exchange(player=player, message=message, decision=decision)
        if packed is None:
            return
        user, assistant = packed
        settings = self.chat_model() if player and message else self.settings()
        self._dsh_pending.append(
            {
                "user": user,
                "assistant": assistant,
                "provider": settings.provider or "gamebot",
                "model": settings.model or "brain",
            }
        )
        self._dsh_pending = self._dsh_pending[-DSH_PENDING_LIMIT:]
        self._store_outbox()
        self._dsh_retry_at = 0.0
        self._flush_dsh()

    def _store_outbox(self) -> None:
        try:
            _save_outbox(self.session_id, self._dsh_pending)
        except OSError as exc:
            self.last_error = f"交流没有写进 DSH 会话：{exc}"

    def _flush_dsh(self) -> None:
        if time.time() < self._dsh_retry_at:
            return
        link = self._dsh()
        if link is None or not self._dsh_pending:
            return
        kept: List[Dict[str, str]] = []
        failed = False
        for item in self._dsh_pending:
            if failed:
                kept.append(item)
                continue
            try:
                link.append_exchange(item["user"], item["assistant"], item["provider"], item["model"])
            except Exception as exc:
                failed = True
                kept.append(item)
                self._dsh_retry_at = time.time() + 5
                self.last_error = f"交流没有写进 DSH 会话：{exc}"
        self._dsh_pending = kept[-DSH_PENDING_LIMIT:]
        self._store_outbox()
        if not failed and not self._dsh_pending and str(self.last_error or "").startswith("交流没有写进"):
            self.last_error = None


def _event_to_chat(event: Any, bot_name: str) -> Optional[Tuple[str, str, Any]]:
    if not isinstance(event, dict):
        return None
    inner = event.get("data") if isinstance(event.get("data"), dict) else event
    parsed = parse_incoming_chat(inner, bot_name) or parse_incoming_chat(event, bot_name)
    if not parsed:
        return None
    player, message = parsed
    at = event.get("at")
    if at is None and isinstance(event.get("data"), dict):
        at = event["data"].get("at")
    return player, message, at
