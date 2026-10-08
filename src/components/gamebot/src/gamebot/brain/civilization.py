"""文明6陪玩循环：观察、评论、安全动作和确认。"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from gamebot.adapters.civilization.bus import fingerprint, parse_events, parse_status
from gamebot.adapters.civilization.dsh_link import DshTranscript, resolve_dsh_token
from gamebot.adapters.civilization.policy import (
    REPEAT_LIMIT,
    ActionClass,
    classify,
    compact_args,
    tool_fingerprint,
)
from gamebot.brain.civilization_models import CompanionMessage, CompanionProposal, CompanionStatus, CompanionTurnResult
from gamebot.brain.civilization_prompt import build_user_prompt, compose_civ_prompt
from gamebot.brain.client import LLMClient, LLMError, ToolCall, ToolSpec, TranscriptMessage
from gamebot.brain.prompt import resolve_persona
from gamebot.brain.settings import LLMSettings, decision_settings
from gamebot.memory.service import MemoryService
from gamebot.memory.store import safe_namespace


# 页面和写回队列的容量。要加大上下文，只改这里。
PAGE_MESSAGE_LIMIT = 80
DSH_PENDING_LIMIT = 40
KEPT_NOTE_CHARS = 500
KEPT_ASSISTANT_CHARS = 3000
DSH_INCOMING_CHARS = 1800
DSH_OUTGOING_CHARS = 3500
SNAPSHOT_PART_CHARS = 2000
SNAPSHOT_PART_TIMEOUT_S = 20.0

MESSAGE_TAGS = {
    "user": "[User]",
    "perception": "[感知]",
    "action": "[行动]",
    "assistant": "[ASSISTANT]",
}
_OPENING = {
    "connect": "进入存档，开始观察当前局面",
    "analyze": "请求分析当前局面",
    "activity": "局面有变化",
}


def dsh_outbox_path() -> Path:
    return Path.cwd() / "data" / "civ-dsh-outbox.json"


def _one_line(text: str, limit: int = 160) -> str:
    flat = " ".join(str(text or "").split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 1] + "…"


def _tagged(kind: str, text: str) -> str:
    return f"{MESSAGE_TAGS.get(kind, '[感知]')} {str(text or '').strip()}".strip()


def _pack_notes(notes: List[Dict[str, str]], limit: int = DSH_OUTGOING_CHARS) -> str:
    rows = [{"kind": item["kind"], "text": str(item.get("text") or "")} for item in notes if str(item.get("text") or "").strip()]

    def render() -> str:
        return "\n".join(_tagged(item["kind"], item["text"]) for item in rows)

    while rows and len(render()) > limit:
        perceptions = [index for index, item in enumerate(rows) if item["kind"] == "perception"]
        if len(perceptions) > 1 or (perceptions and len(rows) > 1):
            rows.pop(perceptions[-1])
            continue
        actions = [index for index, item in enumerate(rows) if item["kind"] == "action"]
        if len(actions) > 1:
            rows.pop(actions[-1])
            continue
        longest = max(range(len(rows)), key=lambda index: len(rows[index]["text"]))
        if len(rows[longest]["text"]) <= 80:
            rows[longest]["text"] = rows[longest]["text"][:limit]
            break
        rows[longest]["text"] = rows[longest]["text"][: max(40, len(rows[longest]["text"]) // 2)] + "…"
    return render()


def _split_exchange(notes: List[Dict[str, str]]) -> tuple[str, str]:
    incoming: List[Dict[str, str]] = []
    outgoing: List[Dict[str, str]] = []
    opened = False
    for note in notes:
        if not opened and note.get("kind") in ("user", "perception"):
            incoming.append(note)
            opened = True
            continue
        outgoing.append(note)
    if not incoming:
        incoming = [{"kind": "perception", "text": "文明6向导"}]
    user = _pack_notes(incoming, DSH_INCOMING_CHARS)
    assistant = _pack_notes(outgoing, DSH_OUTGOING_CHARS) if outgoing else "[ASSISTANT] （无回复）"
    return user, assistant


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


def _truthy(raw: Any, default: bool = True) -> bool:
    if raw is None:
        return default
    value = str(raw).strip().lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")


def _lock_on_running_loop(lock: Optional[asyncio.Lock]) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    bound = getattr(lock, "_loop", None) if lock is not None else None
    if lock is None or (bound is not None and bound is not loop):
        return asyncio.Lock()
    return lock


class CivilizationCompanion:
    def __init__(self, session_id: str, manager: Any, client: Optional[LLMClient] = None) -> None:
        self.session_id = session_id
        self._manager = manager
        self._client = client or LLMClient()
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._running = False
        self._busy = False
        self.paused = False
        self.panel_ready = False
        self._announced = False
        self._fingerprint = ""
        self._wake_reasons: List[str] = []
        self._suppress_safe_until = 0.0
        self._repeat_key = ""
        self._repeat_count = 0
        self.last_error: Optional[str] = None
        self.last_text: Optional[str] = None
        self.messages: List[Dict[str, str]] = []
        self.proposals: Dict[str, Dict[str, Any]] = {}
        self._mem: Optional[MemoryService] = None
        self._dsh_link: Optional[DshTranscript] = None
        self._dsh_token = ""
        self._dsh_panel_seeded = False
        self._dsh_pending: List[Dict[str, str]] = _load_outbox(session_id)
        self._dsh_retry_at = 0.0
        self._turn_token = 0
        self._snapshot_gate = asyncio.Lock()
        self._inflight: Optional[asyncio.Task] = None
        self._chat_hold = False
        self._inbox_task: Optional[asyncio.Task] = None
        self._spawned: set[asyncio.Task] = set()

    def settings(self) -> LLMSettings:
        return decision_settings(self._config())

    def _config(self) -> Dict[str, Any]:
        return dict(self._manager.get(self.session_id).session.config or {})

    def _driver(self) -> Any:
        return self._manager.get(self.session_id).driver

    def _memory_on(self) -> bool:
        return _truthy(self._config().get("MEMORY_ENABLED"), True)

    def memory(self) -> Optional[MemoryService]:
        if not self._memory_on():
            return None
        namespace = safe_namespace(str(self._config().get("CIV_MEMORY") or f"civ6-{self.session_id}"))
        try:
            block_size = int(self._config().get("MEMORY_BLOCK_SIZE") or 6)
        except (TypeError, ValueError):
            block_size = 6
        if self._mem is None or self._mem.namespace != namespace:
            if self._mem is not None:
                self._mem.store.close()
            self._mem = MemoryService(namespace, block_size=block_size)
        return self._mem

    def _interval(self) -> float:
        try:
            seconds = float(self._config().get("CIV_POLL_INTERVAL_S") or 1)
        except (TypeError, ValueError):
            seconds = 1.0
        return min(10.0, max(1.0, seconds))

    def _safe_auto(self) -> bool:
        return _truthy(self._config().get("CIV_SAFE_AUTO"), True)

    def start(self) -> None:
        self._running = True
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._watch_loop())
        if self._inbox_task is None or self._inbox_task.done():
            self._inbox_task = asyncio.create_task(self._inbox_loop())

    def shutdown_now(self) -> None:
        self._running = False
        self._turn_token += 1
        if self._inflight is not None and not self._inflight.done():
            self._inflight.cancel()
        for task in (self._task, self._inbox_task, *tuple(self._spawned)):
            if task is not None and not task.done():
                task.cancel()
        self._task = None
        self._inbox_task = None
        if self._mem is not None:
            self._mem.store.close()
            self._mem = None

    async def sync_panel(self) -> None:
        driver = self._driver()
        status = parse_status(await driver.call_tool("companion_panel_status", {}, host=True))
        if status.get("error"):
            self.panel_ready = False
            self.last_error = str(status["error"])
            return
        self.panel_ready = bool(status.get("ready"))
        if status.get("paused"):
            self.paused = True
        parsed = parse_events(await driver.call_tool("companion_poll_events", {}, host=True))
        if parsed.get("error"):
            self.last_error = str(parsed["error"])
            return
        self.panel_ready = bool(parsed.get("ready")) or self.panel_ready
        if parsed.get("paused"):
            self.paused = True
        for event in parsed.get("events") or []:
            await self._handle_panel_event(event)
        self._note()

    def _spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._spawned.add(task)
        task.add_done_callback(self._spawned.discard)
        return task

    def _supersede(self) -> int:
        self._turn_token += 1
        inflight = self._inflight
        if inflight is not None and not inflight.done():
            inflight.cancel()
        return self._turn_token

    def _stale(self, token: int) -> bool:
        return token != self._turn_token

    async def chat(self, text: str) -> CompanionTurnResult:
        content = (text or "").strip()
        if not content:
            return CompanionTurnResult(ok=False, error="text is required")
        self.messages.append({"role": "user", "text": content, "trigger": "chat"})
        self.messages = self.messages[-PAGE_MESSAGE_LIMIT:]
        self._chat_hold = True
        token = self._supersede()
        try:
            return await self.analyze(trigger="chat", user_text=content, token=token)
        finally:
            if self._turn_token == token:
                self._chat_hold = False

    async def analyze(
        self,
        trigger: str = "analyze",
        user_text: str = "",
        snapshot: Optional[Dict[str, Any]] = None,
        token: Optional[int] = None,
    ) -> CompanionTurnResult:
        if token is None:
            token = self._turn_token
        self._lock = _lock_on_running_loop(self._lock)
        async with self._lock:
            if self._stale(token):
                return CompanionTurnResult(ok=True, text="")
            self._busy = True
            try:
                return await self._analyze(trigger, user_text, snapshot, token)
            except asyncio.CancelledError:
                raise
            except LLMError as exc:
                self.last_error = f"模型调用失败：{exc}"
                return CompanionTurnResult(ok=False, error=self.last_error)
            except Exception as exc:
                self.last_error = f"陪玩内部错误：{exc}"
                return CompanionTurnResult(ok=False, error=self.last_error)
            finally:
                self._busy = False

    async def approve(self, proposal_id: str) -> CompanionTurnResult:
        self._lock = _lock_on_running_loop(self._lock)
        async with self._lock:
            proposal = self.proposals.get(proposal_id)
            if proposal is None:
                return CompanionTurnResult(ok=False, error="建议不存在")
            if proposal["status"] != "pending":
                return CompanionTurnResult(ok=False, error=f"建议状态为 {proposal['status']}")
            snap = await self._snapshot()
            current = fingerprint(snap)
            if current != proposal["fingerprint"]:
                proposal["status"] = "stale"
                await self._publish_update(proposal, "局面已变化，建议已失效。")
                return CompanionTurnResult(ok=False, error="局面已变化，建议已失效", proposals=self._proposal_models())
            decision = classify(
                proposal["tool"],
                proposal["arguments"],
                read_only=self._driver()._read_only(proposal["tool"]),
            )
            if decision in (ActionClass.FORBIDDEN, ActionClass.HOST):
                proposal["status"] = "rejected"
                await self._publish_update(proposal, "该操作被拒绝。")
                return CompanionTurnResult(ok=False, error="该操作被拒绝")
            result = await self._driver().call_tool(proposal["tool"], proposal["arguments"], host=True)
            proposal["status"] = "done"
            proposal["result"] = result[:500]
            self._suppress_safe_until = time.time() + 12
            await self._publish_update(proposal, result[:240])
            self._remember_action(proposal["tool"], proposal["arguments"], result)
            action = f"{proposal['tool']} {compact_args(proposal['arguments'], 180)} → {_one_line(result)}"
            self._commit_notes(
                [
                    {"kind": "user", "text": f"批准 {proposal['tool']}"},
                    {"kind": "action", "text": action},
                ],
                "approve",
            )
            return CompanionTurnResult(ok=True, text=result[:500], proposals=self._proposal_models())

    async def reject(self, proposal_id: str) -> CompanionTurnResult:
        proposal = self.proposals.get(proposal_id)
        if proposal is None:
            return CompanionTurnResult(ok=False, error="建议不存在")
        if proposal["status"] != "pending":
            return CompanionTurnResult(ok=False, error=f"建议状态为 {proposal['status']}")
        proposal["status"] = "rejected"
        await self._publish_update(proposal, "玩家拒绝了这个操作。")
        self._commit_notes(
            [
                {"kind": "user", "text": f"拒绝 {proposal['tool']}"},
                {"kind": "action", "text": f"未执行 {proposal['tool']}"},
            ],
            "reject",
        )
        return CompanionTurnResult(ok=True, text="已拒绝", proposals=self._proposal_models())

    async def pause(self) -> CompanionTurnResult:
        self.paused = True
        await self._publish("pause", text="已暂停自动观察。")
        return CompanionTurnResult(ok=True, text="已暂停自动观察。")

    async def resume(self) -> CompanionTurnResult:
        self.paused = False
        await self._publish("resume", text="已恢复自动观察。")
        return CompanionTurnResult(ok=True, text="已恢复自动观察。")

    def status(self) -> CompanionStatus:
        settings = self.settings()
        return CompanionStatus(
            session_id=self.session_id,
            running=self._running,
            busy=self._busy,
            paused=self.paused,
            panel_ready=self.panel_ready,
            enabled=settings.enabled,
            model=settings.model,
            fingerprint=self._fingerprint,
            last_error=self.last_error,
            last_text=self.last_text,
            messages=[CompanionMessage(**item) for item in self.messages],
            proposals=self._proposal_models(),
        )

    async def _watch_loop(self) -> None:
        first = True
        while self._running:
            try:
                self._flush_dsh()
                if not self.paused and not self._busy and not self._chat_hold:
                    await self.sync_panel()
                    if self.panel_ready and not self._announced:
                        await self._publish("message", text="游戏内面板已连接。我可以看局面、聊天，你操作之后我再开口。")
                        self._announced = True
                        await self._seed_dsh_panel()
                    if first:
                        first = False
                        self._wake_reasons.clear()
                        snap = await self._snapshot()
                        current = fingerprint(snap)
                        self._fingerprint = current
                        self._note(snap, current)
                        if self.settings().enabled and not self._chat_hold:
                            await self.analyze(trigger="connect", snapshot=snap)
                    elif self._wake_reasons and not self._chat_hold:
                        reasons = self._take_wake_reasons()
                        await asyncio.sleep(1.2)
                        if self._running and not self.paused and not self._chat_hold:
                            await self.sync_panel()
                            for item in self._take_wake_reasons():
                                if item not in reasons:
                                    reasons.append(item)
                            snap = await self._snapshot()
                            current = fingerprint(snap)
                            if current != self._fingerprint and not self._chat_hold:
                                self._expire_proposals(current)
                                await self.analyze(
                                    trigger="activity",
                                    user_text="、".join(reasons[:6]),
                                    snapshot=snap,
                                )
                            else:
                                self._fingerprint = current
                                self._note(snap, current)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            try:
                await asyncio.sleep(self._interval())
            except asyncio.CancelledError:
                raise

    async def _inbox_loop(self) -> None:
        while self._running:
            try:
                if not self.paused and (self._busy or self._chat_hold):
                    await self._poll_while_busy()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            try:
                await asyncio.sleep(self._interval())
            except asyncio.CancelledError:
                raise

    async def _poll_while_busy(self) -> None:
        driver = self._driver()
        if not getattr(driver, "_connected", False):
            return
        parsed = parse_events(await driver.call_tool("companion_poll_events", {}, host=True))
        if parsed.get("error"):
            return
        events = list(parsed.get("events") or [])
        for event in events:
            if str(event.get("kind") or "") == "chat" and event.get("text"):
                self._spawn(self.chat(str(event["text"])))
        for event in events:
            kind = str(event.get("kind") or "")
            if kind == "chat":
                continue
            if kind == "activity":
                text = str(event.get("text") or "玩家操作").strip() or "玩家操作"
                if text not in self._wake_reasons:
                    self._wake_reasons.append(text)
            else:
                self._spawn(self._handle_panel_event(event))

    def _take_wake_reasons(self) -> List[str]:
        reasons = list(self._wake_reasons)
        self._wake_reasons.clear()
        return reasons

    async def _handle_panel_event(self, event: Dict[str, Any]) -> None:
        kind = str(event.get("kind") or "")
        if kind == "chat" and event.get("text"):
            await self.chat(str(event["text"]))
        elif kind == "analyze":
            await self.analyze(trigger="analyze", user_text=str(event.get("text") or ""))
        elif kind == "approve":
            await self.approve(str(event.get("proposal_id") or ""))
        elif kind == "reject":
            await self.reject(str(event.get("proposal_id") or ""))
        elif kind == "activity":
            text = str(event.get("text") or "玩家操作").strip() or "玩家操作"
            if text not in self._wake_reasons:
                self._wake_reasons.append(text)
        elif kind == "pause":
            self.paused = True
        elif kind == "resume":
            self.paused = False

    async def _analyze(
        self,
        trigger: str,
        user_text: str,
        snapshot: Optional[Dict[str, Any]],
        token: int,
    ) -> CompanionTurnResult:
        settings = self.settings()
        missing = settings.missing_reason()
        if missing:
            self.last_error = missing
            return CompanionTurnResult(ok=False, error=missing)
        driver = self._driver()
        if not getattr(driver, "_connected", False):
            self.last_error = "文明6尚未连接"
            return CompanionTurnResult(ok=False, error=self.last_error)
        snap = snapshot or await self._snapshot()
        current = fingerprint(snap)
        self._expire_proposals(current)
        self._fingerprint = current
        self._note(snap, current)
        self._repeat_key = ""
        self._repeat_count = 0
        notes: List[Dict[str, str]] = [self._opening_note(trigger, user_text)]
        messages = [
            TranscriptMessage("system", compose_civ_prompt(resolve_persona(self._config(), "decision"))),
            TranscriptMessage("user", self._user_prompt(trigger, user_text, snap)),
        ]
        safe_used = False
        final = ""
        executed: List[Dict[str, Any]] = []
        tools = self._model_tools()
        for _step in range(settings.max_steps):
            if self._stale(token):
                return CompanionTurnResult(ok=True, text="")
            try:
                turn = await self._complete_turn(settings, messages, tools)
            except asyncio.CancelledError:
                if self._stale(token):
                    return CompanionTurnResult(ok=True, text="")
                raise
            if self._stale(token):
                return CompanionTurnResult(ok=True, text="")
            messages.append(TranscriptMessage("assistant", turn.text, list(turn.tool_calls)))
            if turn.text:
                final = turn.text
            if not turn.tool_calls:
                break
            # 同一个调用重复到上限后不再执行，只回一句「已停止」。
            # 这一批里其他不同的调用仍然执行。批处理完就结束本轮，不再向模型要下一步。
            repeat_halt = False
            for call in turn.tool_calls:
                if self._stale(token):
                    return CompanionTurnResult(ok=True, text="")
                if self._note_repeat(call) >= REPEAT_LIMIT:
                    repeat_halt = True
                    messages.append(TranscriptMessage("tool", "相同操作重复过多，已停止。", tool_call_id=call.id))
                    continue
                outcome = await self._dispatch_call(call, current, turn.text, safe_used)
                safe_used = safe_used or outcome.get("safe_used", False)
                if outcome.get("executed"):
                    executed.append(outcome["executed"])
                if outcome.get("log_kind") and outcome.get("log_text"):
                    notes.append({"kind": str(outcome["log_kind"]), "text": str(outcome["log_text"])})
                messages.append(TranscriptMessage("tool", outcome["text"], tool_call_id=call.id))
            if repeat_halt:
                break
        else:
            final = final or "这一步我查得太多了，先停下来等你。"
        if self._stale(token):
            return CompanionTurnResult(ok=True, text="")
        final = final or "我看过了，这一步先不动。"
        self.last_text = final
        self.last_error = None
        notes.append({"kind": "assistant", "text": final[:KEPT_ASSISTANT_CHARS]})
        self._commit_notes(notes, trigger)
        await self._publish("message", text=final)
        mem = self.memory()
        if mem is not None:
            mem.remember_interaction(
                player="玩家",
                message=user_text or trigger,
                say=final,
                reason=trigger,
                source="civ6",
            )
        return CompanionTurnResult(ok=True, text=final, proposals=self._proposal_models(), executed=executed)

    async def _complete_turn(
        self,
        settings: LLMSettings,
        messages: List[TranscriptMessage],
        tools: List[ToolSpec],
    ) -> Any:
        self._inflight = asyncio.create_task(self._client.complete_with_tools(settings, messages, tools))
        try:
            return await self._inflight
        finally:
            self._inflight = None

    async def _dispatch_call(self, call: ToolCall, current: str, commentary: str, safe_used: bool) -> Dict[str, Any]:
        driver = self._driver()
        decision = classify(call.name, call.arguments, read_only=driver._read_only(call.name))
        if decision == ActionClass.SAFE and (not self._safe_auto() or time.time() < self._suppress_safe_until):
            decision = ActionClass.CONFIRM
        args = compact_args(call.arguments, 120)
        if decision == ActionClass.READ:
            result = await driver.call_tool(call.name, call.arguments, host=False)
            return {
                "text": result[:4000],
                "log_kind": "perception",
                "log_text": _one_line(f"{call.name} {args} → {result}"),
            }
        if decision == ActionClass.SAFE and not safe_used:
            result = await driver.call_tool(call.name, call.arguments, host=False)
            self._suppress_safe_until = time.time() + 12
            self._remember_action(call.name, call.arguments, result)
            return {
                "text": result[:4000],
                "safe_used": True,
                "executed": {"name": call.name, "arguments": call.arguments, "result": result[:500]},
                "log_kind": "action",
                "log_text": _one_line(f"{call.name} {args} → {result}"),
            }
        if decision == ActionClass.SAFE:
            return {
                "text": "本轮已经自动执行过一个安全动作。",
                "log_kind": "action",
                "log_text": f"本轮未再自动执行 {call.name}",
            }
        if decision == ActionClass.CONFIRM:
            proposal = await self._queue_proposal(call, current, commentary)
            return {
                "text": f"已提交玩家确认，编号 {proposal['id']}，尚未执行。",
                "log_kind": "action",
                "log_text": _one_line(f"等待确认 {call.name} {args}"),
            }
        return {
            "text": f"已拒绝 {call.name}。不能结束回合、读档或运行任意代码。",
            "log_kind": "action",
            "log_text": f"已拒绝 {call.name}",
        }

    async def _queue_proposal(self, call: ToolCall, current: str, commentary: str) -> Dict[str, Any]:
        proposal_id = uuid.uuid4().hex[:12]
        impact = (commentary or "").strip() or "该操作会改变局面，确认后才会执行。"
        proposal = {
            "id": proposal_id,
            "tool": call.name,
            "arguments": dict(call.arguments),
            "impact": impact[:400],
            "fingerprint": current,
            "status": "pending",
            "result": "",
        }
        self.proposals[proposal_id] = proposal
        await self._publish(
            "proposal",
            text=proposal["impact"],
            proposal_id=proposal_id,
            tool_name=call.name,
            arguments_json=compact_args(call.arguments),
            impact=proposal["impact"],
            status="pending",
        )
        mem = self.memory()
        if mem is not None:
            mem.store.add_event(
                "civ_proposal",
                f"{call.name} {compact_args(call.arguments)}",
                actor="companion",
                weight=1.1,
            )
        return proposal

    async def _snapshot(self) -> Dict[str, Any]:
        driver = self._driver()
        self._snapshot_gate = _lock_on_running_loop(self._snapshot_gate)

        async def _part(name: str) -> str:
            # 调谐器是单连接，三条读取不能同时执行。一起排上，但要等前一条让出后再计时，
            # 这样正常的慢响应不会被兄弟调用的时限提前掐掉；某条挂死则到点记超时，继续下一条。
            async with self._snapshot_gate:
                try:
                    text = await asyncio.wait_for(
                        driver.call_tool(name, {}, host=True),
                        timeout=SNAPSHOT_PART_TIMEOUT_S,
                    )
                except asyncio.TimeoutError:
                    text = "（读取超时）"
                except Exception as exc:
                    text = f"（读取失败：{_one_line(str(exc), 120)}）"
            return str(text)[:SNAPSHOT_PART_CHARS]

        overview, units, cities = await asyncio.gather(
            _part("get_game_overview"),
            _part("get_units"),
            _part("get_cities"),
        )
        snap = {"overview": overview, "units": units, "cities": cities}
        self._note(snap, fingerprint(snap))
        return snap

    def _model_tools(self) -> List[ToolSpec]:
        specs: List[ToolSpec] = []
        for tool in getattr(self._driver(), "_tools", []) or []:
            name = str(tool.get("name") or "")
            read_only = bool((tool.get("annotations") or {}).get("readOnlyHint"))
            decision = classify(name, {}, read_only=read_only)
            if decision in (ActionClass.FORBIDDEN, ActionClass.HOST):
                continue
            specs.append(
                ToolSpec(
                    name=name,
                    description=str(tool.get("description") or "")[:800],
                    parameters=dict(tool.get("input_schema") or {}),
                )
            )
        if specs:
            return specs
        return [ToolSpec("get_game_overview", "读取当前文明6局面摘要。", {"type": "object", "properties": {}})]

    def _note_repeat(self, call: ToolCall) -> int:
        key = tool_fingerprint(call.name, call.arguments)
        if key == self._repeat_key:
            self._repeat_count += 1
        else:
            self._repeat_key = key
            self._repeat_count = 1
        return self._repeat_count

    def _expire_proposals(self, current: str) -> None:
        for proposal in self.proposals.values():
            if proposal["status"] == "pending" and proposal["fingerprint"] != current:
                proposal["status"] = "stale"

    def _note(self, snapshot: Optional[Dict[str, Any]] = None, current: str = "") -> None:
        driver = self._driver()
        note = getattr(driver, "note_snapshot", None)
        if not callable(note):
            return
        current_snapshot = snapshot if snapshot is not None else dict(getattr(driver, "_snapshot", {}) or {})
        note(current_snapshot, current or self._fingerprint, self.panel_ready)

    async def _publish(self, kind: str, **kwargs: Any) -> None:
        driver = self._driver()
        if not getattr(driver, "_connected", False):
            return
        try:
            await driver.call_tool("companion_publish", {"kind": kind, **kwargs}, host=True)
        except Exception as exc:
            self.last_error = str(exc)

    async def _publish_update(self, proposal: Dict[str, Any], text: str) -> None:
        await self._publish(
            "proposal_update",
            text=text,
            proposal_id=proposal["id"],
            tool_name=proposal["tool"],
            arguments_json=compact_args(proposal["arguments"]),
            impact=proposal["impact"],
            status=proposal["status"],
        )

    def _remember_action(self, name: str, arguments: Dict[str, Any], result: str) -> None:
        mem = self.memory()
        if mem is not None:
            mem.store.add_event("civ_action", f"{name} {compact_args(arguments)} -> {result[:300]}", actor="companion", weight=1.2)

    def _dsh(self) -> Optional[DshTranscript]:
        token = resolve_dsh_token(
            self._config(),
            keys=("CIV_DSH_SESSION", "DSH_SESSION", "MC_DSH_SESSION"),
        )
        if not token:
            return None
        if self._dsh_link is None or self._dsh_token != token:
            self._dsh_token = token
            self._dsh_link = DshTranscript(token)
            self._dsh_panel_seeded = False
        return self._dsh_link

    def _dialogue_text(self) -> str:
        link = self._dsh()
        if link is None:
            return ""
        try:
            rows = link.recent(8)
        except Exception:
            return ""
        lines = []
        for row in rows:
            speaker = "我" if row.get("role") == "assistant" else "玩家"
            text = str(row.get("text") or "").strip()
            if text:
                lines.append(f"{speaker}：{text[:800]}")
        return "\n".join(lines)

    async def _seed_dsh_panel(self) -> None:
        if self._dsh_panel_seeded:
            return
        link = self._dsh()
        if link is None or not getattr(self._driver(), "_connected", False):
            return
        self._dsh_panel_seeded = True
        await self._publish("message", text=f"交流正文接上 DSH 会话 {self._dsh_token}。新的对话会写回那条会话。")

    def _opening_note(self, trigger: str, user_text: str) -> Dict[str, str]:
        if trigger == "chat" and user_text.strip():
            return {"kind": "user", "text": user_text.strip()[:KEPT_NOTE_CHARS]}
        text = user_text.strip() or _OPENING.get(trigger, trigger)
        return {"kind": "perception", "text": text[:KEPT_NOTE_CHARS]}

    def _commit_notes(self, notes: List[Dict[str, str]], trigger: str) -> None:
        for note in notes:
            text = str(note.get("text") or "").strip()
            if not text:
                continue
            kind = str(note.get("kind") or "perception")
            if kind == "user" and any(item.get("role") == "user" and item.get("text") == text for item in self.messages[-5:]):
                continue
            self.messages.append({"role": kind, "text": text, "trigger": trigger})
        self.messages = self.messages[-PAGE_MESSAGE_LIMIT:]
        self._record_dsh(notes)

    def _record_dsh(self, notes: List[Dict[str, str]]) -> None:
        link = self._dsh()
        if link is None:
            return
        user, assistant = _split_exchange(notes)
        settings = self.settings()
        self._dsh_pending.append(
            {
                "user": user,
                "assistant": assistant,
                "provider": settings.provider or "civ6",
                "model": settings.model or "companion",
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

    def _user_prompt(self, trigger: str, user_text: str, snap: Dict[str, Any]) -> str:
        memory_text = ""
        mem = self.memory()
        if mem is not None:
            memory_text = str(mem.context(user_text or trigger).get("text") or "")
        return build_user_prompt(trigger, user_text, snap, memory_text, self._dialogue_text())

    def _proposal_models(self) -> List[CompanionProposal]:
        return [CompanionProposal(**item) for item in self.proposals.values()]
