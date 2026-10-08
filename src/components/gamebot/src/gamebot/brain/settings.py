"""从会话/游戏配置解析 LLM 连接参数。装配绑定，不含决策逻辑。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

PROTOCOL_OPENAI_COMPLETIONS = "openai-completions"
PROTOCOL_OPENAI_RESPONSES = "openai-responses"
PROTOCOL_ANTHROPIC_MESSAGES = "anthropic-messages"

SUPPORTED_PROTOCOLS = (
    PROTOCOL_OPENAI_COMPLETIONS,
    PROTOCOL_OPENAI_RESPONSES,
    PROTOCOL_ANTHROPIC_MESSAGES,
)

PROVIDER_DEFAULTS: Dict[str, Dict[str, str]] = {
    "openai": {
        "protocol": PROTOCOL_OPENAI_COMPLETIONS,
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
        "key_env": "OPENAI_API_KEY",
    },
    "deepseek": {
        "protocol": PROTOCOL_OPENAI_COMPLETIONS,
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "key_env": "DEEPSEEK_API_KEY",
    },
    "xai": {
        "protocol": PROTOCOL_OPENAI_COMPLETIONS,
        "base_url": "https://api.x.ai/v1",
        "model": "grok-4",
        "key_env": "XAI_API_KEY",
    },
    "anthropic": {
        "protocol": PROTOCOL_ANTHROPIC_MESSAGES,
        "base_url": "https://api.anthropic.com",
        "model": "claude-sonnet-4-6",
        "key_env": "ANTHROPIC_API_KEY",
    },
    "ollama": {
        "protocol": PROTOCOL_OPENAI_COMPLETIONS,
        "base_url": "http://127.0.0.1:11434/v1",
        "model": "llama3.2",
        "key_env": "",
    },
    "custom": {
        "protocol": PROTOCOL_OPENAI_COMPLETIONS,
        "base_url": "",
        "model": "",
        "key_env": "LLM_API_KEY",
    },
}

_PROTOCOL_ALIASES = {
    "openai": PROTOCOL_OPENAI_COMPLETIONS,
    "openai-chat": PROTOCOL_OPENAI_COMPLETIONS,
    "openai-chat-completions": PROTOCOL_OPENAI_COMPLETIONS,
    "chat-completions": PROTOCOL_OPENAI_COMPLETIONS,
    "chat_completions": PROTOCOL_OPENAI_COMPLETIONS,
    "completions": PROTOCOL_OPENAI_COMPLETIONS,
    PROTOCOL_OPENAI_COMPLETIONS: PROTOCOL_OPENAI_COMPLETIONS,
    "responses": PROTOCOL_OPENAI_RESPONSES,
    "openai-response": PROTOCOL_OPENAI_RESPONSES,
    PROTOCOL_OPENAI_RESPONSES: PROTOCOL_OPENAI_RESPONSES,
    "anthropic": PROTOCOL_ANTHROPIC_MESSAGES,
    "messages": PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_ANTHROPIC_MESSAGES: PROTOCOL_ANTHROPIC_MESSAGES,
}

LLM_CONFIG_KEYS = (
    "LLM_ENABLED",
    "LLM_PROVIDER",
    "LLM_PROTOCOL",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_API_KEY_REF",
    "LLM_DECISION_TIMEOUT_S",
    "LLM_MAX_STEPS",
    "LLM_TEMPERATURE",
    "LLM_TOP_P",
    "LLM_MAX_TOKENS",
    "LLM_REASONING_EFFORT",
    "LLM_THINKING_BUDGET",
    "LLM_PERSONA",
    "CHAT_ENABLED",
    "CHAT_PROVIDER",
    "CHAT_PROTOCOL",
    "CHAT_BASE_URL",
    "CHAT_MODEL",
    "CHAT_API_KEY",
    "CHAT_API_KEY_REF",
    "CHAT_TEMPERATURE",
    "CHAT_TOP_P",
    "CHAT_MAX_TOKENS",
    "CHAT_REASONING_EFFORT",
    "CHAT_THINKING_BUDGET",
    "CHAT_PERSONA",
    "MEMORY_ENABLED",
    "MEMORY_BLOCK_SIZE",
    "DSH_SESSION",
)

DEFAULT_LLM_CONFIG: Dict[str, str] = {
    "LLM_ENABLED": "0",
    "LLM_PROVIDER": "openai",
    "LLM_PROTOCOL": PROTOCOL_OPENAI_COMPLETIONS,
    "LLM_BASE_URL": "",
    "LLM_MODEL": "",
    "LLM_API_KEY": "",
    "LLM_API_KEY_REF": "",
    "LLM_DECISION_TIMEOUT_S": "60",
    "LLM_MAX_STEPS": "8",
    "LLM_TEMPERATURE": "0.2",
    "LLM_TOP_P": "",
    "LLM_MAX_TOKENS": "",
    "LLM_REASONING_EFFORT": "",
    "LLM_THINKING_BUDGET": "",
    "LLM_PERSONA": "",
    "CHAT_ENABLED": "",
    "CHAT_PROVIDER": "",
    "CHAT_PROTOCOL": "",
    "CHAT_BASE_URL": "",
    "CHAT_MODEL": "",
    "CHAT_API_KEY": "",
    "CHAT_API_KEY_REF": "",
    "CHAT_TEMPERATURE": "",
    "CHAT_TOP_P": "",
    "CHAT_MAX_TOKENS": "",
    "CHAT_REASONING_EFFORT": "",
    "CHAT_THINKING_BUDGET": "",
    "CHAT_PERSONA": "",
    "MEMORY_ENABLED": "1",
    "MEMORY_BLOCK_SIZE": "6",
    "DSH_SESSION": "",
}


def _truthy(raw: Any, default: bool = False) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    value = str(raw).strip().lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")


def normalize_protocol(raw: str, fallback: str = PROTOCOL_OPENAI_COMPLETIONS) -> str:
    key = (raw or "").strip().lower().replace("_", "-")
    return _PROTOCOL_ALIASES.get(key, fallback if key not in SUPPORTED_PROTOCOLS else key)


def normalize_provider(raw: str) -> str:
    name = (raw or "").strip().lower()
    aliases = {
        "gpt": "openai",
        "chatgpt": "openai",
        "claude": "anthropic",
        "grok": "xai",
        "x-ai": "xai",
        "local": "ollama",
    }
    return aliases.get(name, name or "custom")


def provider_defaults(provider: str) -> Dict[str, str]:
    return dict(PROVIDER_DEFAULTS.get(normalize_provider(provider), PROVIDER_DEFAULTS["custom"]))


def resolve_api_key(config: Mapping[str, Any], provider: str = "", prefix: str = "LLM") -> str:
    direct = str(config.get(f"{prefix}_API_KEY") or "").strip()
    if direct:
        return direct
    from gamebot.config_store import lookup_provider_key

    shared = lookup_provider_key(provider)
    if shared:
        return shared
    ref = str(config.get(f"{prefix}_API_KEY_REF") or "").strip()
    if ref:
        return (os.getenv(ref) or "").strip()
    defaults = provider_defaults(provider)
    env_name = defaults.get("key_env") or ""
    if env_name:
        found = (os.getenv(env_name) or "").strip()
        if found:
            return found
    fallback_names = ("LLM_API_KEY", "GAMEBOT_LLM_API_KEY")
    if prefix != "LLM":
        fallback_names = (f"{prefix}_API_KEY",) + fallback_names
    for name in fallback_names:
        found = (os.getenv(name) or "").strip()
        if found:
            return found
    return ""


def _int(raw: Any, default: int) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class LLMSettings:
    enabled: bool = False
    provider: str = "openai"
    protocol: str = PROTOCOL_OPENAI_COMPLETIONS
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    timeout_s: float = 60.0
    max_steps: int = 8
    role: str = "decision"
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    reasoning_effort: str = ""
    thinking_budget: Optional[int] = None

    @property
    def ready(self) -> bool:
        if not self.enabled:
            return False
        if not self.base_url or not self.model:
            return False
        if self.provider == "ollama":
            return True
        return bool(self.api_key)

    def missing_reason(self) -> Optional[str]:
        label = "CHAT" if self.role == "chat" else "LLM"
        if not self.enabled:
            return f"{label}_ENABLED is off"
        if not self.model:
            return f"{label}_MODEL is required"
        if not self.base_url:
            return f"{label}_BASE_URL is required"
        if self.provider != "ollama" and not self.api_key:
            return f"{label}_API_KEY is required"
        if self.protocol not in SUPPORTED_PROTOCOLS:
            return f"unsupported {label}_PROTOCOL {self.protocol}"
        return None

    def public_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "provider": self.provider,
            "protocol": self.protocol,
            "base_url": self.base_url,
            "model": self.model,
            "ready": self.ready,
            "timeout_s": self.timeout_s,
            "max_steps": self.max_steps,
            "role": self.role,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "max_tokens": self.max_tokens,
            "reasoning_effort": self.reasoning_effort,
            "thinking_budget": self.thinking_budget,
        }

    @classmethod
    def from_mapping(
        cls,
        config: Optional[Mapping[str, Any]] = None,
        *,
        prefix: str = "LLM",
        inherit: Optional["LLMSettings"] = None,
        role: str = "decision",
    ) -> "LLMSettings":
        data = dict(config or {})
        prefix = (prefix or "LLM").strip().upper() or "LLM"
        inherited = inherit
        provider_raw = str(data.get(f"{prefix}_PROVIDER") or "").strip()
        if not provider_raw and inherited:
            provider = inherited.provider
        else:
            provider = normalize_provider(provider_raw or "openai")
        defaults = provider_defaults(provider)
        protocol_raw = str(data.get(f"{prefix}_PROTOCOL") or "").strip()
        protocol = (
            inherited.protocol
            if not protocol_raw and inherited
            else normalize_protocol(protocol_raw, defaults["protocol"] if not inherited else inherited.protocol)
        )
        base_url = str(data.get(f"{prefix}_BASE_URL") or "").strip()
        if not base_url:
            base_url = inherited.base_url if inherited else defaults["base_url"]
        model = str(data.get(f"{prefix}_MODEL") or "").strip()
        if not model:
            model = inherited.model if inherited else defaults["model"]
        enabled_key = f"{prefix}_ENABLED"
        if enabled_key in data and str(data.get(enabled_key) or "").strip() != "":
            enabled = _truthy(data.get(enabled_key), False)
        elif inherited is not None:
            enabled = inherited.enabled
        else:
            enabled = _truthy(data.get("LLM_ENABLED"), False)
        timeout_s = float(_int(data.get("LLM_DECISION_TIMEOUT_S"), int(inherited.timeout_s) if inherited else 60))
        max_steps = _int(data.get("LLM_MAX_STEPS"), inherited.max_steps if inherited else 8)
        api_key = resolve_api_key(data, provider, prefix)
        if not api_key and inherited and inherited.provider == provider:
            api_key = inherited.api_key
        from gamebot.brain.generation import parse_generation

        inherited_gen = None
        if inherited is not None:
            inherited_gen = {
                "temperature": inherited.temperature,
                "top_p": inherited.top_p,
                "max_tokens": inherited.max_tokens,
                "reasoning_effort": inherited.reasoning_effort,
                "thinking_budget": inherited.thinking_budget,
            }
        gen = parse_generation(data, prefix=prefix, inherit=inherited_gen)
        return cls(
            enabled=enabled,
            provider=provider,
            protocol=protocol,
            base_url=base_url.rstrip("/"),
            model=model,
            api_key=api_key,
            timeout_s=timeout_s,
            max_steps=max(1, min(max_steps, 16)),
            role=role,
            temperature=gen["temperature"],
            top_p=gen["top_p"],
            max_tokens=gen["max_tokens"],
            reasoning_effort=str(gen.get("reasoning_effort") or ""),
            thinking_budget=gen["thinking_budget"],
        )


def decision_settings(config: Optional[Mapping[str, Any]] = None) -> LLMSettings:
    return LLMSettings.from_mapping(config, prefix="LLM", role="decision")


def chat_settings(config: Optional[Mapping[str, Any]] = None) -> LLMSettings:
    decision = decision_settings(config)
    return LLMSettings.from_mapping(config, prefix="CHAT", inherit=decision, role="chat")


def join_api_url(base_url: str, path: str) -> str:
    base = (base_url or "").rstrip("/")
    suffix = path if path.startswith("/") else f"/{path}"
    if base.endswith("/v1") and suffix.startswith("/v1/"):
        suffix = suffix[3:]
    return f"{base}{suffix}"


def endpoint_for(settings: LLMSettings) -> Tuple[str, str]:
    """返回 (url, protocol)。openai-completions 实际打 Chat Completions 端点。"""
    base = settings.base_url
    if settings.protocol in (PROTOCOL_OPENAI_COMPLETIONS, PROTOCOL_OPENAI_RESPONSES):
        if base and not base.rstrip("/").endswith("/v1") and "/v1/" not in base:
            base = base.rstrip("/") + "/v1"
    if settings.protocol == PROTOCOL_OPENAI_RESPONSES:
        return join_api_url(base, "/responses"), settings.protocol
    if settings.protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        return join_api_url(base, "/v1/messages"), settings.protocol
    return join_api_url(base, "/chat/completions"), PROTOCOL_OPENAI_COMPLETIONS
