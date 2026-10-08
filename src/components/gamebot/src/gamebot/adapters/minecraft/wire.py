"""Minaret WebSocket v1 编解码与字段校验。旧版 hello/聊天/命令仍可解析。"""
from __future__ import annotations

import math
import re
import time
import uuid
from typing import Any, Dict, List, Mapping, Optional, Tuple

PROTOCOL_VERSION = 1

ERROR_CODES = frozenset(
    {
        "invalid_params",
        "not_connected",
        "client_not_ready",
        "item_not_found",
        "block_unloaded",
        "out_of_reach",
        "line_of_sight_blocked",
        "unsupported",
        "unsupported_adapter",
        "rate_limited",
        "timeout",
        "action_rejected",
        "internal_error",
    }
)
FACES = frozenset({"down", "up", "north", "south", "west", "east"})
HANDS = frozenset({"main_hand", "off_hand"})
EFFECTS = frozenset({"confirmed", "observed", "unverified", "failed"})
USE_MODES = frozenset({"once", "until_finished"})
RESOURCE_ID = re.compile(r"^[a-z0-9_.-]+:[a-z0-9_./-]+$")
FACE_CENTER = {
    "down": (0.5, 0.0, 0.5),
    "up": (0.5, 1.0, 0.5),
    "north": (0.5, 0.5, 0.0),
    "south": (0.5, 0.5, 1.0),
    "west": (0.0, 0.5, 0.5),
    "east": (1.0, 0.5, 0.5),
}
MAX_INTERACT_DISTANCE = 6.0
CORE_ACTIONS = frozenset(
    {
        "look_at",
        "move_to",
        "interact",
        "select_item",
        "use_item_on_block",
        "attack_block",
        "attack_entity",
        "drop_item",
        "use_item",
        "find_item",
    }
)
UUID_TEXT = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class WireError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def now_ms() -> int:
    return int(time.time() * 1000)


def new_request_id() -> str:
    return str(uuid.uuid4())


def is_resource_id(value: Any) -> bool:
    return isinstance(value, str) and bool(RESOURCE_ID.fullmatch(value))


def require_resource_id(value: Any, field: str) -> str:
    if not is_resource_id(value):
        raise WireError("invalid_params", f"{field} must be a lowercase namespace:path id")
    return str(value)


def finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WireError("invalid_params", f"{field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise WireError("invalid_params", f"{field} must be a finite number")
    return number


def integer_coord(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise WireError("invalid_params", f"{field} must be an integer")
    return value


def block_pos(value: Any, field: str = "pos") -> Dict[str, int]:
    if not isinstance(value, Mapping):
        raise WireError("invalid_params", f"{field} must be an object")
    return {
        "x": integer_coord(value.get("x"), f"{field}.x"),
        "y": integer_coord(value.get("y"), f"{field}.y"),
        "z": integer_coord(value.get("z"), f"{field}.z"),
    }


def hit_offset(value: Any) -> Dict[str, float]:
    if not isinstance(value, Mapping):
        raise WireError("invalid_params", "hit_offset must be an object")
    out = {}
    for axis in ("x", "y", "z"):
        number = finite_number(value.get(axis), f"hit_offset.{axis}")
        if number < 0 or number > 1:
            raise WireError("invalid_params", f"hit_offset.{axis} must be between 0 and 1")
        out[axis] = number
    return out


def face_center(face: str) -> Dict[str, float]:
    center = FACE_CENTER[face]
    return {"x": center[0], "y": center[1], "z": center[2]}


def build_envelope(
    event: str,
    data: Mapping[str, Any],
    sequence: int,
    request_id: Optional[str] = None,
    timestamp_ms: Optional[int] = None,
    extra: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "protocol_version": PROTOCOL_VERSION,
        "event": event,
        "sequence": int(sequence),
        "timestamp_ms": now_ms() if timestamp_ms is None else int(timestamp_ms),
        "data": dict(data),
    }
    if request_id:
        payload["request_id"] = request_id
    if extra:
        payload.update(dict(extra))
    return payload


def build_hello(user: str, sequence: int) -> Dict[str, Any]:
    envelope = build_envelope("hello", {"user": user, "client": "dsh-gamebot"}, sequence)
    envelope["user"] = user
    return envelope


def build_action_request(
    action: str,
    params: Mapping[str, Any],
    sequence: int,
    request_id: Optional[str] = None,
    goal: Optional[str] = None,
) -> Dict[str, Any]:
    cleaned = validate_action_params(action, params)
    data: Dict[str, Any] = {"action": action, "params": cleaned}
    if goal:
        data["goal"] = str(goal)[:200]
    return build_envelope(
        "action_request",
        data,
        sequence,
        request_id=request_id or new_request_id(),
    )


def build_cancel(target_request_id: str, sequence: int) -> Dict[str, Any]:
    if not target_request_id:
        raise WireError("invalid_params", "target_request_id is required")
    return build_envelope(
        "cancel_action",
        {"target_request_id": target_request_id},
        sequence,
        request_id=new_request_id(),
    )


def merged_view(message: Mapping[str, Any]) -> Dict[str, Any]:
    view = dict(message)
    inner = message.get("data")
    if message.get("protocol_version") == PROTOCOL_VERSION and isinstance(inner, Mapping):
        for key, value in inner.items():
            if key not in view or key == "data":
                continue
            if key not in message:
                view[key] = value
        view.update({k: v for k, v in inner.items() if k not in ("event",)})
        player = inner.get("player")
        if isinstance(player, Mapping):
            if isinstance(player.get("position"), Mapping):
                view["position"] = player["position"]
            if player.get("health") is not None:
                view["health"] = player["health"]
            if player.get("food") is not None:
                view["food"] = player["food"]
    return view


def validate_action_params(action: str, params: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    raw = dict(params or {})
    if action not in CORE_ACTIONS:
        return raw
    if action in ("look_at", "move_to"):
        return {
            "x": finite_number(raw.get("x"), "x"),
            "y": finite_number(raw.get("y"), "y"),
            "z": finite_number(raw.get("z"), "z"),
        }
    if action == "attack_entity":
        out: Dict[str, Any] = {}
        if raw.get("uuid") is not None:
            uuid = str(raw.get("uuid"))
            if not UUID_TEXT.fullmatch(uuid):
                raise WireError("invalid_params", "uuid is invalid")
            out["uuid"] = uuid
        return out
    if action == "select_item":
        item_id = raw.get("item_id") or raw.get("item")
        slot = raw.get("slot")
        if item_id is None and slot is None:
            raise WireError("invalid_params", "select_item requires item_id or slot")
        out: Dict[str, Any] = {}
        if item_id is not None:
            out["item_id"] = require_resource_id(item_id, "item_id")
        if slot is not None:
            slot_no = integer_coord(slot, "slot")
            if slot_no < 0 or slot_no > 8:
                raise WireError("unsupported", "only hotbar slots 0-8 can be selected")
            out["slot"] = slot_no
        return out
    if action in ("interact", "use_item_on_block", "attack_block"):
        out = {"pos": block_pos(raw.get("pos"))}
        face = str(raw.get("face") or "up")
        if face not in FACES:
            raise WireError("invalid_params", "face is invalid")
        out["face"] = face
        hand = str(raw.get("hand") or "main_hand")
        if hand not in HANDS:
            raise WireError("invalid_params", "hand is invalid")
        out["hand"] = hand
        if raw.get("hit_offset") is None:
            out["hit_offset"] = face_center(face)
        else:
            out["hit_offset"] = hit_offset(raw.get("hit_offset"))
        out["sneaking"] = bool(raw.get("sneaking") or False)
        distance = raw.get("max_distance", 4.5)
        max_distance = finite_number(distance, "max_distance")
        if max_distance <= 0 or max_distance > MAX_INTERACT_DISTANCE:
            raise WireError("invalid_params", "max_distance must be within (0, 6]")
        out["max_distance"] = max_distance
        item_id = raw.get("item_id") or raw.get("item")
        if item_id is not None:
            out["item_id"] = require_resource_id(item_id, "item_id")
        return out
    if action == "drop_item":
        item_id = raw.get("item_id") or raw.get("item")
        slot = raw.get("slot")
        if item_id is None and slot is None:
            raise WireError("invalid_params", "drop_item requires item_id or slot")
        count = integer_coord(raw.get("count", 1), "count")
        if count <= 0:
            raise WireError("invalid_params", "count must be positive")
        out = {"count": count}
        if item_id is not None:
            out["item_id"] = require_resource_id(item_id, "item_id")
        if slot is not None:
            slot_no = integer_coord(slot, "slot")
            if slot_no < 0 or slot_no > 8:
                raise WireError("unsupported", "only hotbar slots 0-8 can be dropped in this version")
            out["slot"] = slot_no
        return out
    if action == "use_item":
        mode = str(raw.get("mode") or "once")
        if mode not in USE_MODES:
            raise WireError("invalid_params", "mode must be once or until_finished")
        hand = str(raw.get("hand") or "main_hand")
        if hand not in HANDS:
            raise WireError("invalid_params", "hand is invalid")
        out = {"mode": mode, "hand": hand}
        item_id = raw.get("item_id") or raw.get("item")
        if item_id is not None:
            out["item_id"] = require_resource_id(item_id, "item_id")
        return out
    if action == "find_item":
        out = {"item_id": require_resource_id(raw.get("item_id"), "item_id")}
        if raw.get("radius") is not None:
            radius = integer_coord(raw.get("radius"), "radius")
            if radius < 1 or radius > 16:
                raise WireError("invalid_params", "radius must be from 1 to 16")
            out["radius"] = radius
        return out
    return raw


def parse_action_result(message: Mapping[str, Any]) -> Dict[str, Any]:
    view = merged_view(message)
    effect = str(view.get("effect") or "failed")
    if effect not in EFFECTS:
        effect = "failed"
    code = view.get("error_code")
    if code is not None:
        code = str(code)
        if code not in ERROR_CODES:
            code = "internal_error"
    return {
        "request_id": message.get("request_id") or view.get("request_id"),
        "ok": bool(view.get("ok")),
        "action": str(view.get("action") or ""),
        "effect": effect,
        "error": None if view.get("error") is None else str(view.get("error")),
        "error_code": code,
        "sent": None if view.get("sent") is None else str(view.get("sent")),
        "evidence": view.get("evidence") if isinstance(view.get("evidence"), Mapping) else {},
    }


def _item_view(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, Mapping) or not is_resource_id(value.get("item_id")):
        return None
    count = value.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return None
    return {
        "item_id": str(value["item_id"]),
        "count": count,
        "display_name": None if value.get("display_name") is None else str(value.get("display_name")),
        "damage": int(value.get("damage") or 0) if not isinstance(value.get("damage"), bool) else 0,
        "max_damage": int(value.get("max_damage") or 0) if not isinstance(value.get("max_damage"), bool) else 0,
    }


def normalize_snapshot(message: Mapping[str, Any]) -> Dict[str, Any]:
    view = merged_view(message)
    player = view.get("player")
    if not isinstance(player, Mapping) or not isinstance(player.get("position"), Mapping):
        raise WireError("invalid_params", "snapshot player.position is required")
    position = {
        "x": finite_number(player["position"].get("x"), "player.position.x"),
        "y": finite_number(player["position"].get("y"), "player.position.y"),
        "z": finite_number(player["position"].get("z"), "player.position.z"),
    }
    blocks_in = view.get("nearby_blocks") if isinstance(view.get("nearby_blocks"), list) else []
    blocks: List[Dict[str, Any]] = []
    for item in blocks_in:
        if not isinstance(item, Mapping) or not is_resource_id(item.get("block_id")):
            continue
        pos = item.get("pos")
        if not isinstance(pos, Mapping):
            continue
        try:
            parsed = block_pos(pos, "nearby_blocks.pos")
            distance = finite_number(item.get("distance", 0), "distance")
        except WireError:
            continue
        state = item.get("state") if isinstance(item.get("state"), Mapping) else {}
        entity_type = item.get("block_entity_type")
        blocks.append(
            {
                "block_id": str(item["block_id"]),
                "pos": parsed,
                "state": {str(k): str(v) for k, v in state.items()},
                "block_entity_type": str(entity_type) if is_resource_id(entity_type) else None,
                "distance": distance,
            }
        )
    players_in = view.get("nearby_players") if isinstance(view.get("nearby_players"), list) else []
    players = []
    for item in players_in:
        if not isinstance(item, Mapping) or not item.get("name"):
            continue
        pos = item.get("position") if isinstance(item.get("position"), Mapping) else None
        position_out = None
        if pos is not None:
            try:
                position_out = {
                    "x": finite_number(pos.get("x"), "x"),
                    "y": finite_number(pos.get("y"), "y"),
                    "z": finite_number(pos.get("z"), "z"),
                }
            except WireError:
                position_out = None
        players.append(
            {
                "uuid": None if item.get("uuid") is None else str(item.get("uuid")),
                "name": str(item.get("name")),
                "position": position_out,
                "distance": finite_number(item.get("distance", 0), "distance") if _is_number(item.get("distance", 0)) else 0.0,
                "pose": None if item.get("pose") is None else str(item.get("pose")),
                "main_hand": _item_view(item.get("main_hand")),
            }
        )
    inventory = view.get("inventory") if isinstance(view.get("inventory"), Mapping) else {}
    counts = inventory.get("counts") if isinstance(inventory.get("counts"), Mapping) else {}
    clean_counts = {str(k): int(v) for k, v in counts.items() if is_resource_id(k) and isinstance(v, int) and not isinstance(v, bool)}
    slots = []
    for slot in inventory.get("slots") or []:
        if not isinstance(slot, Mapping):
            continue
        item = _item_view(slot)
        if item is None or isinstance(slot.get("slot"), bool) or not isinstance(slot.get("slot"), int):
            continue
        slots.append({"slot": int(slot["slot"]), **item})
    screen = view.get("screen") if isinstance(view.get("screen"), Mapping) else {}
    screen_id = screen.get("id")
    return {
        "player": {
            "position": position,
            "yaw": finite_number(player.get("yaw", 0), "yaw") if _is_number(player.get("yaw", 0)) else 0.0,
            "pitch": finite_number(player.get("pitch", 0), "pitch") if _is_number(player.get("pitch", 0)) else 0.0,
            "health": finite_number(player.get("health"), "health") if _is_number(player.get("health")) else None,
            "food": finite_number(player.get("food"), "food") if _is_number(player.get("food")) else None,
            "dimension": str(player.get("dimension")) if is_resource_id(player.get("dimension")) else None,
            "game_mode": None if player.get("game_mode") is None else str(player.get("game_mode")),
            "sneaking": bool(player.get("sneaking") or False),
            "sprinting": bool(player.get("sprinting") or False),
            "selected_slot": int(player.get("selected_slot") or 0) if isinstance(player.get("selected_slot"), int) else 0,
            "main_hand": _item_view(player.get("main_hand")),
            "off_hand": _item_view(player.get("off_hand")),
        },
        "inventory": {"slots": slots, "counts": clean_counts},
        "nearby_blocks": blocks,
        "nearby_players": players,
        "screen": {"id": str(screen_id) if is_resource_id(screen_id) else None, "open": bool(screen.get("open") or False)},
        "actor_type": str(view.get("actor_type") or "local_player"),
        "agent_id": None if not view.get("agent_id") else str(view.get("agent_id")),
    }


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def compact_nearby_blocks(blocks: List[Mapping[str, Any]], group_limit: int = 48, coords_per_group: int = 3) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Mapping[str, Any]]] = {}
    for block in blocks:
        block_id = str(block.get("block_id") or "")
        if not block_id:
            continue
        grouped.setdefault(block_id, []).append(block)
    ranked = []
    for block_id, items in grouped.items():
        ordered = sorted(items, key=lambda item: (float(item.get("distance") or 0), item.get("pos", {}).get("y", 0), item.get("pos", {}).get("x", 0), item.get("pos", {}).get("z", 0)))
        nearest = ordered[0]
        ranked.append((float(nearest.get("distance") or 0), block_id, ordered))
    ranked.sort(key=lambda item: (item[0], item[1]))
    out = []
    for _distance, block_id, ordered in ranked[:group_limit]:
        out.append(
            {
                "block_id": block_id,
                "count": len(ordered),
                "nearest": [
                    {"pos": item.get("pos"), "distance": item.get("distance")}
                    for item in ordered[:coords_per_group]
                ],
            }
        )
    return out


def normalize_activity(message: Mapping[str, Any]) -> Dict[str, Any]:
    view = merged_view(message)
    kind = str(view.get("kind") or "player_activity")
    inferred = bool(view.get("inferred") or False)
    confidence = view.get("confidence")
    if not _is_number(confidence):
        confidence = 1.0 if not inferred else 0.0
    confidence = max(0.0, min(1.0, float(confidence)))
    pos = view.get("pos") if isinstance(view.get("pos"), Mapping) else None
    return {
        "kind": kind,
        "player": None if view.get("player") is None else str(view.get("player")),
        "player_uuid": None if view.get("player_uuid") is None else str(view.get("player_uuid")),
        "inferred": inferred,
        "confidence": confidence,
        "evidence": [str(item) for item in view.get("evidence") or [] if isinstance(view.get("evidence"), list)],
        "block_id": str(view.get("block_id")) if is_resource_id(view.get("block_id")) else None,
        "pos": None
        if pos is None
        else {"x": pos.get("x"), "y": pos.get("y"), "z": pos.get("z")},
    }


def action_timeout_seconds(action: str, params: Mapping[str, Any]) -> float:
    if action in ("move_to", "attack_block"):
        return 30.0
    if action == "use_item" and str(params.get("mode") or "") == "until_finished":
        return 30.0
    return 5.0


def result_tuple(result: Mapping[str, Any]) -> Tuple[bool, str]:
    return bool(result.get("ok")), str(result.get("error_code") or "")
