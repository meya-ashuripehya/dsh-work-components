"""低频视觉/电脑操控兜底。不参与战斗/移动主循环；每次动作必须观察前后确认。"""
from __future__ import annotations

import hashlib
import os
import tempfile
import time
from typing import Any, Dict, Optional, Tuple

from gamebot.contracts import capabilities as cap_ids
from gamebot.contracts.models import ActionRequest, ActionResult, Capability, Evidence, Observation, ProbeResult
from gamebot.drivers.base import GameDriver

_VISION_CAPS = (
    cap_ids.STATE_QUERY,
    cap_ids.VISION_OBSERVE,
    cap_ids.VISION_CLICK,
    cap_ids.VISION_TYPE,
    cap_ids.VISION_CONFIRM,
)


def _deps() -> Tuple[bool, Optional[str]]:
    missing = []
    try:
        import mss  # noqa: F401
    except ImportError:
        missing.append("mss")
    try:
        import pyautogui  # noqa: F401
    except ImportError:
        missing.append("pyautogui")
    if missing:
        return False, "missing packages: " + ", ".join(missing) + "; pip install -e \".[vision]\""
    return True, None


def _checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class VisionDesktopAdapter(GameDriver):
    game = "vision"
    driver_id = "vision_desktop"

    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = dict(config or {})
        self._connected = False
        self._last_error: Optional[str] = None
        self._last_checksum: Optional[str] = None
        self._evidence_dir = str(self.config.get("evidence_dir") or tempfile.gettempdir())

    def _cap_list(self) -> list[Capability]:
        ok, reason = _deps()
        connected_ok = self._connected and ok
        out = []
        for cap_id in _VISION_CAPS:
            if cap_id == cap_ids.STATE_QUERY:
                out.append(Capability(id=cap_id, available=True))
                continue
            if not ok:
                out.append(Capability(id=cap_id, available=False, reason=reason))
            elif not self._connected:
                out.append(Capability(id=cap_id, available=False, reason="not connected"))
            else:
                out.append(Capability(id=cap_id, available=connected_ok))
        return out

    def _obs(self, evidence: Optional[Evidence] = None) -> Observation:
        ok, reason = _deps()
        return Observation(
            game=self.game,
            driver=self.driver_id,
            connected=self._connected and ok,
            username="desktop",
            capabilities=self._cap_list(),
            extras={"vision_ready": ok, "scope": "menu_launcher_settings_only"},
            last_error=self._last_error or (None if ok else reason),
            evidence=evidence,
        )

    def _capture(self, label: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        ok, reason = _deps()
        if not ok:
            return None, None, reason
        import mss
        from PIL import Image

        os.makedirs(self._evidence_dir, exist_ok=True)
        path = os.path.join(self._evidence_dir, f"gamebot-vision-{label}-{int(time.time() * 1000)}.png")
        with mss.mss() as sct:
            monitor = sct.monitors[int(self.config.get("monitor") or 1)]
            raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.rgb)
        max_px = int(self.config.get("max_px") or 1280)
        w, h = img.size
        if max(w, h) > max_px:
            scale = max_px / float(max(w, h))
            img = img.resize((int(w * scale), int(h * scale)))
        img.save(path)
        checksum = _checksum(img.tobytes())
        return path, checksum, None

    async def probe(self) -> ProbeResult:
        ok, reason = _deps()
        return ProbeResult(
            reachable=ok,
            driver=self.driver_id,
            game=self.game,
            capabilities=self._cap_list(),
            error=None if ok else reason,
        )

    async def connect(self) -> Observation:
        self._connected = True
        self._last_error = None
        return self._obs()

    async def disconnect(self) -> Observation:
        self._connected = False
        return self._obs()

    async def observe(self) -> Observation:
        path, checksum, err = self._capture("observe")
        if err:
            self._last_error = err
            return self._obs(Evidence(kind="screenshot", notes=err, changed=False))
        changed = self._last_checksum is not None and checksum != self._last_checksum
        self._last_checksum = checksum
        evidence = Evidence(
            kind="screenshot",
            path_after=path,
            checksum_after=checksum,
            changed=changed,
            notes="observe-only; not a combat/movement loop",
        )
        return self._obs(evidence)

    async def act(self, request: ActionRequest) -> ActionResult:
        action = request.action
        if action == "query_state":
            return ActionResult(ok=True, action=action, observation=self._obs())
        if action == "vision_observe":
            obs = await self.observe()
            return ActionResult(ok=obs.last_error is None, action=action, observation=obs, evidence=obs.evidence, error=obs.last_error)

        ok, reason = _deps()
        if not ok:
            return ActionResult(ok=False, action=action, error=reason, observation=self._obs(), degraded=True, degrade_reason=reason)
        if not self._connected:
            return ActionResult(ok=False, action=action, error="not connected", observation=self._obs())

        before_path, before_sum, err = self._capture("before")
        if err:
            return ActionResult(ok=False, action=action, error=err, observation=self._obs())

        params = request.params or {}
        exec_error: Optional[str] = None
        sent = action
        try:
            import pyautogui

            pyautogui.FAILSAFE = True
            if action == "vision_click":
                x = int(params.get("x"))
                y = int(params.get("y"))
                clicks = int(params.get("clicks") or 1)
                button = str(params.get("button") or "left")
                pyautogui.click(x=x, y=y, clicks=clicks, button=button)
                sent = f"click {x},{y}"
            elif action == "vision_type":
                text = str(params.get("text") or "")
                if not text:
                    return ActionResult(ok=False, action=action, error="text is required", observation=self._obs())
                pyautogui.typewrite(text, interval=float(params.get("interval") or 0.02))
                sent = "typed"
            else:
                return ActionResult(ok=False, action=action, error=f"unknown vision action {action}", observation=self._obs())
        except Exception as e:
            exec_error = str(e)

        time.sleep(float(params.get("settle_s") or 0.15))
        after_path, after_sum, after_err = self._capture("after")
        changed = bool(before_sum and after_sum and before_sum != after_sum)
        evidence = Evidence(
            kind="screenshot",
            path_before=before_path,
            path_after=after_path,
            checksum_before=before_sum,
            checksum_after=after_sum,
            changed=changed,
            notes=exec_error or after_err or ("visual change confirmed" if changed else "no visual change; do not assume success"),
        )
        if exec_error:
            return ActionResult(ok=False, action=action, error=exec_error, evidence=evidence, observation=self._obs(evidence))
        if after_err:
            return ActionResult(ok=False, action=action, error=after_err, evidence=evidence, observation=self._obs(evidence))
        if not changed:
            return ActionResult(
                ok=False,
                action=action,
                sent=sent,
                error="observation confirm failed: screenshot checksum unchanged",
                evidence=evidence,
                observation=self._obs(evidence),
                degraded=True,
                degrade_reason="click/type produced no visible change",
            )
        return ActionResult(ok=True, action=action, sent=sent, evidence=evidence, observation=self._obs(evidence))
