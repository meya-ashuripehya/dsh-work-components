"""把观察、能力、目标和聊天组装成决策提示。

人设（prefix）在前，输出约定在后。不要用人设对抗「你是机器人/agent」这类身份句。
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from gamebot.adapters.minecraft.wire import compact_nearby_blocks
from gamebot.brain.work_mode import WORK_MODES, work_brief
from gamebot.contracts.capabilities import ACTION_REQUIRED_CAPABILITY
from gamebot.contracts.models import Observation

PERSONA_MAX_CHARS = 12000

DEFAULT_IDENTITY = """以下是你的人设：
你正在 Minecraft 里行动。用“我”称呼自己。说话像活人，不要自称 AI、模型、程序或助手。
"""

MECHANICS_HEADER = "以下是本回合的输出约定，不是人设，也不改变你是谁。只约束返回格式。"

PERSONA_TAIL = "人设优先。JSON 只约束包装；say 必须符合人设口吻，不要用客服/助手腔覆盖上面的身份。"

DECISION_MECHANICS = """Reply with a single JSON object, no markdown, no extra text.
Schema:
{
  "reason": "short internal reason",
  "say": "optional in-game chat, or null",
  "goal": "optional standing goal, or null",
  "mode": "rest | follow | farm | feed | attack | torch | shears | milk, or null to leave it",
  "actions": [{"action": "move_to", "params": {"x": 1, "y": 64, "z": 1}}],
  "wait": false,
  "skip": false,
  "stop_current": true,
  "memory_used": ["12"]
}
Rules:
- Only use actions listed as available. Never invent action names or item numeric IDs.
- Prefer semantic actions (move_to, collect, craft, look_at, interact, say).
- If nothing should be done, set skip=true or wait=true and keep actions empty.
- Keep "say" short (under 200 characters) and in the player's language.
- Do not use run_command unless the goal explicitly requires a slash command.
- Item and block ids must be lowercase namespace:path values taken from the observation. Never invent numeric registry ids.
- use_item_on_block needs pos, face, and optionally item_id. select_item and drop_item only accept hotbar slots 0-8.
- find_item searches nearby containers for one item_id and returns only the containers that hold it. Container contents are not part of the normal state. Matches appear once as item_search; call it only when you need a location.
- When actor_type is server_npc, you are a separate mob in the same world as the human player. screen stays closed. Walk with move_to. Do not wait for a menu or for the game window to be in front.
- player_activity with inferred=true is a hypothesis, not confirmation that a player right-clicked that block.
- Honor [Chat directive] and [Current goal] from the chat model over idle exploration.
- Casual greetings in memory do not cancel a standing goal. Requests, preferences, and goals do.
- Continue a chat-set goal until it is done or a newer chat directive replaces it.
- mode is the standing work schedule, same idea as a maid task: rest (idle), follow, farm, feed, attack, torch, shears, milk.
- While [Work mode] is not rest, do only that mode's next step and leave goal null.
- A one-shot directed action is an explicit order with actions. It interrupts the schedule. After those actions finish, the schedule is rest and the previous mode does not resume.
- Do not set mode on a one-shot order. Set mode only when the work should keep going.
- Use memory only as evidence. If memory is insufficient, do not invent past facts.
- Put adopted memory event ids into memory_used. Do not list unused retrieved ids.
"""

CHAT_MECHANICS = """Reply with a single JSON object, no markdown, no extra text.
Schema:
{
  "reason": "short internal reason",
  "say": "in-game reply",
  "goal": "standing objective for later autonomous decisions, or null",
  "mode": "rest | follow | farm | feed | attack | torch | shears | milk, or null to leave it",
  "actions": [{"action": "look_at", "params": {"x": 1, "y": 64, "z": 1}}],
  "wait": false,
  "skip": false,
  "stop_current": true,
  "memory_used": ["12"]
}
Rules:
- Keep "say" under 200 characters and in the player's language.
- Idle small talk: only set "say"; leave actions empty, goal null, and mode null.
- If the player asks you to do something once, output semantic actions now and set stop_current=true. Leave mode null. Those actions interrupt the work schedule; when they finish, the schedule returns to rest.
- Set "mode" only when the player wants that work to continue: follow, farm, feed, attack, torch, shears, or milk. Use rest to stop. A mode change is not a one-shot.
- Also set "goal" when a one-shot request should continue after this turn. Do not set goal and a work mode together.
- Preferences ("remember", "never", "always") should be acknowledged in "say" and recorded via goal/reason; they later bind the decision model through memory.
- Only use available actions. Never invent facts that memory did not support.
- player_activity with inferred=true is a hypothesis, not confirmation of a right-click.
- find_item searches nearby containers for one item_id. Container contents are not in the normal state; call it only when you need a location.
- When actor_type is server_npc, you are a mob beside the player. screen stays closed. Use move_to to walk.
- Put adopted memory event ids into memory_used only when they actually support the reply.
"""

# 兼容旧测试名：无独立人设时的完整 system。
DECISION_SYSTEM_PROMPT = DECISION_MECHANICS
CHAT_SYSTEM_PROMPT = CHAT_MECHANICS


def clip_persona(raw: Optional[str]) -> str:
    text = (raw or "").strip()
    if len(text) > PERSONA_MAX_CHARS:
        return text[: PERSONA_MAX_CHARS - 1].rstrip() + "…"
    return text


def resolve_persona(config: Optional[Mapping[str, Any]], role: str = "decision") -> str:
    data = dict(config or {})
    decision = clip_persona(str(data.get("LLM_PERSONA") or data.get("PERSONA") or ""))
    chat = clip_persona(str(data.get("CHAT_PERSONA") or ""))
    if role == "chat":
        return chat or decision
    return decision


def compose_system(role: str = "decision", persona: Optional[str] = None) -> str:
    """人设 prefix 在前，决策/聊天约定附录在后，避免工具约定淹没身份。"""
    mechanics = CHAT_MECHANICS if role == "chat" else DECISION_MECHANICS
    identity = clip_persona(persona)
    if not identity:
        identity = DEFAULT_IDENTITY.strip()
    elif not identity.startswith("以下是你的人设"):
        identity = "以下是你的人设：\n" + identity
    return "\n\n".join(
        [
            identity,
            MECHANICS_HEADER,
            mechanics.strip(),
            PERSONA_TAIL,
        ]
    )


def available_actions(observation: Observation) -> List[str]:
    cap_map = observation.capability_map()
    out: List[str] = []
    for action, cap_id in ACTION_REQUIRED_CAPABILITY.items():
        cap = cap_map.get(cap_id)
        if action == "query_state" or (cap and cap.available):
            out.append(action)
    return out


def compact_observation(observation: Observation) -> Dict[str, Any]:
    inventory = {}
    extras = observation.extras or {}
    raw_inv = extras.get("inventory")
    if isinstance(raw_inv, dict):
        items = list(raw_inv.items())[:20]
        inventory = {str(k): v for k, v in items}
    events = []
    for event in (observation.recent_events or [])[-8:]:
        if isinstance(event, dict) and (_is_find_item_event(event) or _is_chat_event(event)):
            continue
        if isinstance(event, dict):
            events.append({k: event[k] for k in list(event.keys())[:6]})
    pos = None
    if observation.position:
        pos = {
            "x": round(observation.position.x, 1),
            "y": round(observation.position.y, 1),
            "z": round(observation.position.z, 1),
        }
    nearby = [
        {"name": p.name, "distance": p.distance}
        for p in (observation.nearby_players or [])[:8]
    ]
    state = {
        "game": observation.game,
        "driver": observation.driver,
        "connected": observation.connected,
        "username": observation.username,
        "position": pos,
        "health": observation.health,
        "food": observation.food,
        "version": observation.version,
        "loader": observation.loader,
        "online_players": list(observation.online_players or [])[:12],
        "nearby_players": nearby,
        "inventory": inventory,
        "recent_events": events,
        "last_error": observation.last_error,
        "available_actions": available_actions(observation),
    }
    minecraft = extras.get("minecraft")
    if isinstance(minecraft, dict):
        player = minecraft.get("player") if isinstance(minecraft.get("player"), dict) else {}
        main_hand = player.get("main_hand") if isinstance(player.get("main_hand"), dict) else None
        blocks = minecraft.get("nearby_blocks") if isinstance(minecraft.get("nearby_blocks"), list) else []
        activity = [
            event.get("data")
            for event in (observation.recent_events or [])
            if isinstance(event, dict) and event.get("type") == "player_activity" and isinstance(event.get("data"), dict)
        ]
        state["selected_item"] = main_hand
        state["nearby_blocks"] = compact_nearby_blocks(blocks)
        actor_type = str(minecraft.get("actor_type") or extras.get("actor_type") or "")
        if actor_type == "server_npc":
            state["actor_type"] = "server_npc"
            state["agent_id"] = minecraft.get("agent_id") or extras.get("agent_id")
            state["screen"] = {"id": None, "open": False}
        else:
            state["screen"] = minecraft.get("screen")
        state["recent_activity"] = activity[-4:]
    search = extras.get("item_search")
    if isinstance(search, dict):
        state["item_search"] = _compact_item_search(search)
    last_action = extras.get("last_action")
    if isinstance(last_action, dict):
        state["last_action"] = {
            "action": last_action.get("action"),
            "ok": bool(last_action.get("ok")),
            "effect": last_action.get("effect"),
            "error_code": last_action.get("error_code"),
        }
    return state


def _is_chat_event(event: Mapping[str, Any]) -> bool:
    kind = str(event.get("type") or "").strip().lower()
    if kind in ("chat", "player_chat", "chat_message"):
        return True
    data = event.get("data")
    if isinstance(data, dict):
        inner = str(data.get("event") or data.get("type") or "").strip().lower()
        if inner in ("chat", "player_chat", "chat_message"):
            return True
    return False


def _is_find_item_event(event: Mapping[str, Any]) -> bool:
    if event.get("type") != "action_result":
        return False
    data = event.get("data")
    if not isinstance(data, dict):
        return False
    inner = data.get("data") if isinstance(data.get("data"), dict) else data
    return inner.get("action") == "find_item"


def _compact_item_search(search: Mapping[str, Any]) -> Dict[str, Any]:
    matches = []
    raw_matches = search.get("matches") if isinstance(search.get("matches"), list) else []
    for match in raw_matches[:16]:
        if not isinstance(match, dict):
            continue
        slots = []
        for slot in (match.get("slots") or [])[:8]:
            if isinstance(slot, dict):
                slots.append({"slot": slot.get("slot"), "count": slot.get("count")})
        matches.append(
            {
                "block_id": match.get("block_id"),
                "name": match.get("name"),
                "pos": match.get("pos"),
                "distance": match.get("distance"),
                "count": match.get("count"),
                "slots": slots,
            }
        )
    return {
        "item_id": search.get("item_id"),
        "matches": matches,
    }


def build_messages(
    observation: Observation,
    *,
    goal: Optional[str] = None,
    player: Optional[str] = None,
    message: Optional[str] = None,
    current_goal: Optional[str] = None,
    work_mode: Optional[str] = None,
    last_chat_directive: Optional[str] = None,
    memory_text: str = "",
    dialogue_text: str = "",
    evidence_ok: bool = True,
    role: str = "decision",
    persona: Optional[str] = None,
) -> List[Dict[str, str]]:
    state = compact_observation(observation)
    lines = [
        f"[Game state] {state}",
    ]
    if dialogue_text:
        lines.append("[DSH conversation]")
        lines.append(dialogue_text)
    if memory_text:
        lines.append(memory_text)
        if not evidence_ok:
            lines.append("[Evidence gate] Retrieved memory may be insufficient. Do not invent missing details.")
    if last_chat_directive and role == "decision":
        lines.append(f"[Chat directive — honor this over idle plans] {last_chat_directive}")
    if current_goal:
        lines.append(f"[Current goal] {current_goal}")
    mode_name = work_mode if work_mode in WORK_MODES else "rest"
    lines.append(f"[Work mode] {mode_name}: {work_brief(mode_name)}")
    if player and message:
        lines.append(f"[Player chat] {player}: {message}")
        lines.append("Decide whether to reply, act now, and/or set a standing goal for the decision model.")
    elif goal:
        lines.append(f"[Task] {goal}")
        lines.append("Plan the next actions for this task.")
    else:
        lines.append("[Task] Observe and decide if any useful action is needed.")
    return [
        {"role": "system", "content": compose_system(role, persona)},
        {"role": "user", "content": "\n".join(lines)},
    ]
