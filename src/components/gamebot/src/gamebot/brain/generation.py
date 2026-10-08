"""各服务商的采样与思考参数：配置解析、请求体映射、配置页目录。

字段名按厂商真实 API 组装，不假装大家共用一套。
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

from gamebot.brain.settings import (
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
    PROTOCOL_OPENAI_RESPONSES,
    LLMSettings,
)

OFF_EFFORTS = frozenset({"", "off", "none", "disabled", "disable", "false", "0"})
THINKING_PROVIDERS = frozenset({"openai", "anthropic", "deepseek", "xai", "ollama", "custom"})
SKIP_SAMPLING_WHEN_THINKING = frozenset({"openai", "deepseek", "xai"})

_EFFORT_ALIASES = {
    "关闭": "off",
    "默认": "",
    "disable": "off",
    "disabled": "off",
    "false": "off",
    "no": "off",
    "minimal": "minimal",
    "min": "minimal",
    "low": "low",
    "medium": "medium",
    "mid": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "x-high": "xhigh",
    "max": "max",
    "none": "none",
    "off": "off",
    "on": "high",
    "true": "high",
}

DEEPSEEK_EFFORT_MAP = {
    "minimal": "low",
    "medium": "high",
    "xhigh": "high",
    "off": "none",
    "disabled": "none",
}

XAI_EFFORT_MAP = {
    "none": "low",
    "off": "low",
    "disabled": "low",
    "minimal": "low",
    "max": "high",
}

EFFORT_OPTIONS: Dict[str, List[Dict[str, str]]] = {
    "openai": [
        {"value": "", "label": "默认"},
        {"value": "none", "label": "关闭"},
        {"value": "minimal", "label": "极低"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
        {"value": "xhigh", "label": "极高"},
        {"value": "max", "label": "最大"},
    ],
    "anthropic": [
        {"value": "", "label": "默认"},
        {"value": "off", "label": "关闭"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
        {"value": "xhigh", "label": "极高"},
        {"value": "max", "label": "最大"},
    ],
    "deepseek": [
        {"value": "", "label": "默认"},
        {"value": "none", "label": "关闭思考"},
        {"value": "low", "label": "低"},
        {"value": "high", "label": "高"},
        {"value": "max", "label": "最大"},
    ],
    "xai": [
        {"value": "", "label": "默认"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
        {"value": "xhigh", "label": "极高"},
    ],
    "ollama": [
        {"value": "", "label": "默认"},
        {"value": "off", "label": "关闭"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
    ],
    "custom": [
        {"value": "", "label": "默认"},
        {"value": "none", "label": "关闭"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
        {"value": "xhigh", "label": "极高"},
        {"value": "max", "label": "最大"},
    ],
}

GENERATION_CONFIG_KEYS = (
    "LLM_TEMPERATURE",
    "LLM_TOP_P",
    "LLM_MAX_TOKENS",
    "LLM_REASONING_EFFORT",
    "LLM_THINKING_BUDGET",
    "CHAT_TEMPERATURE",
    "CHAT_TOP_P",
    "CHAT_MAX_TOKENS",
    "CHAT_REASONING_EFFORT",
    "CHAT_THINKING_BUDGET",
)

DEFAULT_GENERATION_CONFIG = {key: "" for key in GENERATION_CONFIG_KEYS}
DEFAULT_GENERATION_CONFIG["LLM_TEMPERATURE"] = "0.2"


def ui_schema() -> Dict[str, Any]:
    return {
        "effort_options": EFFORT_OPTIONS,
        "fields": [
            {
                "suffix": "REASONING_EFFORT",
                "kind": "effort",
                "decision_label": "决策思考强度",
                "chat_label": "聊天思考强度",
                "hint": "各服务商字段不同：OpenAI reasoning.effort / reasoning_effort，Anthropic thinking + output_config.effort，DeepSeek thinking + reasoning_effort，xAI reasoning_effort，Ollama think。",
                "providers": list(THINKING_PROVIDERS),
            },
            {
                "suffix": "THINKING_BUDGET",
                "kind": "range",
                "decision_label": "决策思考预算",
                "chat_label": "聊天思考预算",
                "min": 1024,
                "max": 32000,
                "step": 1024,
                "hint": "仅 Anthropic 旧版 extended thinking 使用 budget_tokens；留空则走自适应思考。",
                "providers": ["anthropic"],
            },
            {
                "suffix": "TEMPERATURE",
                "kind": "range",
                "decision_label": "决策温度",
                "chat_label": "聊天温度",
                "min": 0,
                "max": 2,
                "step": 0.1,
                "hint": "OpenAI / DeepSeek / xAI 在思考开启时通常不生效或会报错，开启思考后会自动省略。",
                "providers": ["openai", "anthropic", "deepseek", "xai", "ollama", "custom"],
            },
            {
                "suffix": "TOP_P",
                "kind": "range",
                "decision_label": "决策 top_p",
                "chat_label": "聊天 top_p",
                "min": 0,
                "max": 1,
                "step": 0.05,
                "hint": "与温度二选一调节采样。留空不发送。",
                "providers": ["openai", "anthropic", "deepseek", "xai", "ollama", "custom"],
            },
            {
                "suffix": "MAX_TOKENS",
                "kind": "number",
                "decision_label": "决策最大输出",
                "chat_label": "聊天最大输出",
                "min": 256,
                "max": 128000,
                "step": 256,
                "hint": "Completions 用 max_tokens，Responses 用 max_output_tokens。思考开启时 Anthropic 会自动抬高下限。",
                "providers": ["openai", "anthropic", "deepseek", "xai", "ollama", "custom"],
            },
        ],
    }


def normalize_effort(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    return _EFFORT_ALIASES.get(value, value)


def thinking_enabled(effort: str) -> bool:
    return normalize_effort(effort) not in OFF_EFFORTS


def _optional_float(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _optional_int(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        value = int(float(text))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def parse_generation(
    config: Optional[Mapping[str, Any]],
    *,
    prefix: str = "LLM",
    inherit: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    data = dict(config or {})
    prefix = (prefix or "LLM").strip().upper() or "LLM"
    inherited = inherit or {}

    def pick(suffix: str, parser, inherit_key: str):
        key = f"{prefix}_{suffix}"
        raw = data.get(key)
        if raw is not None and str(raw).strip() != "":
            return parser(raw)
        return inherited.get(inherit_key)

    effort = pick("REASONING_EFFORT", normalize_effort, "reasoning_effort")
    return {
        "temperature": pick("TEMPERATURE", _optional_float, "temperature"),
        "top_p": pick("TOP_P", _optional_float, "top_p"),
        "max_tokens": pick("MAX_TOKENS", _optional_int, "max_tokens"),
        "reasoning_effort": effort or "",
        "thinking_budget": pick("THINKING_BUDGET", _optional_int, "thinking_budget"),
    }


def _set_max_tokens(body: Dict[str, Any], protocol: str, max_tokens: Optional[int], *, fallback: Optional[int] = None) -> None:
    size = max_tokens if max_tokens is not None else fallback
    if size is None:
        return
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        body["max_output_tokens"] = size
    else:
        body["max_tokens"] = size


def _apply_sampling(body: Dict[str, Any], settings: LLMSettings, *, skip: bool) -> None:
    if skip:
        return
    if settings.temperature is not None:
        body["temperature"] = settings.temperature
    if settings.top_p is not None:
        body["top_p"] = max(0.0, min(1.0, settings.top_p))


def apply_generation(settings: LLMSettings, body: Dict[str, Any]) -> Dict[str, Any]:
    """按服务商把思考强度和采样参数写进请求体。"""
    provider = (settings.provider or "custom").strip().lower()
    protocol = settings.protocol
    effort = normalize_effort(settings.reasoning_effort)
    thinking_on = thinking_enabled(effort)
    skip_sampling = thinking_on and provider in SKIP_SAMPLING_WHEN_THINKING

    default_max = None
    if protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        default_max = 8192 if thinking_on else 1024
    _set_max_tokens(body, protocol, settings.max_tokens, fallback=default_max)
    if protocol == PROTOCOL_OPENAI_COMPLETIONS and settings.temperature is None and not skip_sampling:
        body.setdefault("temperature", 0.2)
    _apply_sampling(body, settings, skip=skip_sampling)

    if not effort:
        return body

    if protocol == PROTOCOL_ANTHROPIC_MESSAGES or provider == "anthropic":
        _apply_anthropic_thinking(body, effort, settings.thinking_budget)
        return body
    if provider == "deepseek":
        _apply_deepseek_thinking(body, effort)
        return body
    if provider == "xai":
        _apply_xai_thinking(body, protocol, effort)
        return body
    if provider == "ollama":
        _apply_ollama_thinking(body, effort)
        return body
    _apply_openai_thinking(body, protocol, effort)
    return body


def _apply_openai_thinking(body: Dict[str, Any], protocol: str, effort: str) -> None:
    if effort in ("off", "disabled"):
        effort = "none"
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        body["reasoning"] = {"effort": effort}
    else:
        body["reasoning_effort"] = effort


def _apply_anthropic_thinking(body: Dict[str, Any], effort: str, budget: Optional[int]) -> None:
    if effort in ("off", "none", "disabled"):
        body["thinking"] = {"type": "disabled"}
        return
    if budget:
        budget = max(1024, int(budget))
        body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        current = int(body.get("max_tokens") or 1024)
        if current <= budget:
            body["max_tokens"] = budget + 1024
        if effort not in ("enabled", "on"):
            body.setdefault("output_config", {})["effort"] = effort
        return
    mapped = "medium" if effort in ("minimal",) else effort
    body["thinking"] = {"type": "adaptive"}
    body.setdefault("output_config", {})["effort"] = mapped


def _apply_deepseek_thinking(body: Dict[str, Any], effort: str) -> None:
    mapped = DEEPSEEK_EFFORT_MAP.get(effort, effort)
    if mapped in OFF_EFFORTS or mapped == "none":
        body["thinking"] = {"type": "disabled"}
        body["reasoning_effort"] = "none"
        return
    body["thinking"] = {"type": "enabled"}
    body["reasoning_effort"] = mapped


def _apply_xai_thinking(body: Dict[str, Any], protocol: str, effort: str) -> None:
    mapped = XAI_EFFORT_MAP.get(effort, effort)
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        body["reasoning"] = {"effort": mapped}
    else:
        body["reasoning_effort"] = mapped


def _apply_ollama_thinking(body: Dict[str, Any], effort: str) -> None:
    if effort in OFF_EFFORTS:
        body["think"] = False
        return
    if effort in ("low", "medium", "high"):
        body["think"] = effort
        return
    body["think"] = True


def effort_choices(provider: str) -> Sequence[Dict[str, str]]:
    return EFFORT_OPTIONS.get((provider or "custom").strip().lower(), EFFORT_OPTIONS["custom"])
