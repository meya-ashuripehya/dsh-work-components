"""顺序执行决策动作，支持取消当前序列。"""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, List, Optional

from gamebot.brain.models import Decision, PlannedAction
from gamebot.contracts.models import ActionRequest, ActionResult

ActFn = Callable[[ActionRequest], Awaitable[ActionResult]]


class ActionRunner:
    def __init__(self, act: ActFn) -> None:
        self._act = act
        self._task: Optional[asyncio.Task] = None
        self._cancel = asyncio.Event()
        self._busy = False

    @property
    def busy(self) -> bool:
        return self._busy and self._task is not None and not self._task.done()

    async def cancel(self) -> bool:
        had = self.busy
        self._cancel.set()
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        self._task = None
        self._busy = False
        return had

    async def run(
        self,
        actions: List[PlannedAction],
        *,
        interrupt: bool = True,
        say: Optional[str] = None,
    ) -> List[ActionResult]:
        if interrupt:
            await self.cancel()
        elif self.busy:
            raise RuntimeError("action runner is busy")
        self._cancel.clear()
        sequence = list(actions)
        if say:
            sequence = [PlannedAction(action="say", params={"text": say})] + sequence

        async def _loop() -> List[ActionResult]:
            results: List[ActionResult] = []
            self._busy = True
            try:
                for planned in sequence:
                    if self._cancel.is_set():
                        break
                    request = ActionRequest(action=planned.action, params=dict(planned.params or {}))
                    result = await self._act(request)
                    results.append(result)
                return results
            finally:
                self._busy = False

        self._task = asyncio.create_task(_loop())
        try:
            return await self._task
        except asyncio.CancelledError:
            return []
        finally:
            if self._task is not None and self._task.done():
                self._task = None

    async def run_decision(self, decision: Decision, *, interrupt: Optional[bool] = None) -> List[ActionResult]:
        should_interrupt = decision.stop_current if interrupt is None else interrupt
        if decision.skip and not decision.actions and not decision.say:
            if should_interrupt:
                await self.cancel()
            return []
        if not decision.actions and not decision.say:
            return []
        return await self.run(
            decision.actions,
            interrupt=should_interrupt and bool(decision.actions or decision.stop_current),
            say=decision.say,
        )
