"""LLM HTTP 客户端：按显式协议组装请求，不假设所有厂商共用一种 API。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from gamebot.brain.settings import (
    PROTOCOL_ANTHROPIC_MESSAGES,
    PROTOCOL_OPENAI_COMPLETIONS,
    PROTOCOL_OPENAI_RESPONSES,
    LLMSettings,
    endpoint_for,
)
from gamebot.brain.generation import apply_generation


class LLMError(RuntimeError):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TranscriptMessage:
    role: str
    content: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    tool_call_id: str = ""


@dataclass
class LLMToolTurn:
    text: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)


def _json_args(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}
        return parsed if isinstance(parsed, dict) else {"_raw": raw}
    return {}


def _schema(spec: ToolSpec) -> Dict[str, Any]:
    schema = dict(spec.parameters or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return schema


@dataclass
class LLMHttpRequest:
    method: str
    url: str
    headers: Dict[str, str]
    body: Dict[str, Any]
    protocol: str
    timeout_s: float = 60.0
    extra: Dict[str, Any] = field(default_factory=dict)


def _messages_to_text(messages: List[Dict[str, str]]) -> tuple[str, str]:
    system_parts: List[str] = []
    user_parts: List[str] = []
    for item in messages:
        role = str(item.get("role") or "user")
        content = str(item.get("content") or "")
        if role == "system":
            system_parts.append(content)
        else:
            user_parts.append(content)
    return "\n\n".join(system_parts).strip(), "\n\n".join(user_parts).strip()


def build_llm_request(settings: LLMSettings, messages: List[Dict[str, str]]) -> LLMHttpRequest:
    url, protocol = endpoint_for(settings)
    system_text, user_text = _messages_to_text(messages)
    headers = {"Content-Type": "application/json"}
    if protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        if settings.api_key:
            headers["x-api-key"] = settings.api_key
            headers["Authorization"] = f"Bearer {settings.api_key}"
        headers["anthropic-version"] = "2023-06-01"
        body: Dict[str, Any] = {
            "model": settings.model,
            "messages": [{"role": "user", "content": user_text or system_text}],
        }
        if system_text:
            body["system"] = system_text
        apply_generation(settings, body)
        return LLMHttpRequest(
            method="POST",
            url=url,
            headers=headers,
            body=body,
            protocol=protocol,
            timeout_s=settings.timeout_s,
        )
    if settings.api_key:
        headers["Authorization"] = f"Bearer {settings.api_key}"
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        body = {
            "model": settings.model,
            "input": user_text or system_text,
        }
        if system_text:
            body["instructions"] = system_text
        apply_generation(settings, body)
        return LLMHttpRequest(
            method="POST",
            url=url,
            headers=headers,
            body=body,
            protocol=protocol,
            timeout_s=settings.timeout_s,
        )
    body = {
        "model": settings.model,
        "messages": messages,
    }
    apply_generation(settings, body)
    return LLMHttpRequest(
        method="POST",
        url=url,
        headers=headers,
        body=body,
        protocol=PROTOCOL_OPENAI_COMPLETIONS,
        timeout_s=settings.timeout_s,
    )


def build_tool_request(
    settings: LLMSettings,
    messages: List[TranscriptMessage],
    tools: List[ToolSpec],
) -> LLMHttpRequest:
    url, protocol = endpoint_for(settings)
    headers = {"Content-Type": "application/json"}
    if protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        if settings.api_key:
            headers["x-api-key"] = settings.api_key
            headers["Authorization"] = f"Bearer {settings.api_key}"
        headers["anthropic-version"] = "2023-06-01"
        system_text, anthropic_messages = _anthropic_messages(messages)
        body = {
            "model": settings.model,
            "messages": anthropic_messages or [{"role": "user", "content": system_text or "继续"}],
            "tools": [
                {"name": tool.name, "description": tool.description, "input_schema": _schema(tool)}
                for tool in tools
            ],
            "tool_choice": {"type": "auto"},
        }
        if system_text:
            body["system"] = system_text
        apply_generation(settings, body)
        return LLMHttpRequest("POST", url, headers, body, protocol, settings.timeout_s)
    if settings.api_key:
        headers["Authorization"] = f"Bearer {settings.api_key}"
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        system_text, response_input = _responses_input(messages)
        body = {
            "model": settings.model,
            "input": response_input or system_text or "继续",
            "tools": [
                {
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": _schema(tool),
                }
                for tool in tools
            ],
            "tool_choice": "auto",
        }
        if system_text:
            body["instructions"] = system_text
        apply_generation(settings, body)
        return LLMHttpRequest("POST", url, headers, body, protocol, settings.timeout_s)
    body = {
        "model": settings.model,
        "messages": _completion_messages(messages),
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": _schema(tool),
                },
            }
            for tool in tools
        ],
        "tool_choice": "auto",
    }
    apply_generation(settings, body)
    return LLMHttpRequest("POST", url, headers, body, PROTOCOL_OPENAI_COMPLETIONS, settings.timeout_s)


def _completion_messages(messages: List[TranscriptMessage]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for message in messages:
        if message.role == "tool":
            out.append({"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content})
            continue
        if message.role == "assistant" and message.tool_calls:
            out.append(
                {
                    "role": "assistant",
                    "content": message.content or None,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                        for call in message.tool_calls
                    ],
                }
            )
            continue
        out.append({"role": message.role, "content": message.content})
    return out


def _responses_input(messages: List[TranscriptMessage]) -> tuple[str, List[Dict[str, Any]]]:
    system_parts: List[str] = []
    items: List[Dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            items.append({"type": "function_call_output", "call_id": message.tool_call_id, "output": message.content})
            continue
        if message.role == "assistant":
            if message.content:
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": message.content}]})
            for call in message.tool_calls:
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": json.dumps(call.arguments, ensure_ascii=False),
                    }
                )
            continue
        items.append({"role": "user", "content": [{"type": "input_text", "text": message.content}]})
    return "\n\n".join(part for part in system_parts if part).strip(), items


def _anthropic_messages(messages: List[TranscriptMessage]) -> tuple[str, List[Dict[str, Any]]]:
    system_parts: List[str] = []
    out: List[Dict[str, Any]] = []
    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue
        if message.role == "tool":
            block = {"type": "tool_result", "tool_use_id": message.tool_call_id, "content": message.content}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue
        if message.role == "assistant":
            blocks: List[Dict[str, Any]] = []
            if message.content:
                blocks.append({"type": "text", "text": message.content})
            for call in message.tool_calls:
                blocks.append({"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments})
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
            continue
        out.append({"role": "user", "content": message.content})
    return "\n\n".join(part for part in system_parts if part).strip(), out


def parse_tool_turn(protocol: str, payload: Any) -> LLMToolTurn:
    if not isinstance(payload, dict):
        return LLMToolTurn(text=str(payload or "").strip())
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        return _parse_responses_turn(payload)
    if protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        return _parse_anthropic_turn(payload)
    return _parse_completion_turn(payload)


def _parse_completion_turn(payload: Dict[str, Any]) -> LLMToolTurn:
    choices = payload.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return LLMToolTurn(text=extract_llm_text(PROTOCOL_OPENAI_COMPLETIONS, payload))
    message = choices[0].get("message") or {}
    calls = []
    for index, call in enumerate(message.get("tool_calls") or []):
        if not isinstance(call, dict):
            continue
        function = call.get("function") or {}
        calls.append(
            ToolCall(
                id=str(call.get("id") or f"call_{index}"),
                name=str(function.get("name") or ""),
                arguments=_json_args(function.get("arguments")),
            )
        )
    return LLMToolTurn(text=extract_llm_text(PROTOCOL_OPENAI_COMPLETIONS, payload), tool_calls=calls)


def _parse_responses_turn(payload: Dict[str, Any]) -> LLMToolTurn:
    texts: List[str] = []
    calls: List[ToolCall] = []
    for index, item in enumerate(payload.get("output") or []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "function_call":
            calls.append(
                ToolCall(
                    id=str(item.get("call_id") or item.get("id") or f"call_{index}"),
                    name=str(item.get("name") or ""),
                    arguments=_json_args(item.get("arguments")),
                )
            )
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("text"):
                texts.append(str(part.get("text")))
    text = "\n".join(texts).strip() or str(payload.get("output_text") or "").strip()
    return LLMToolTurn(text=text, tool_calls=calls)


def _parse_anthropic_turn(payload: Dict[str, Any]) -> LLMToolTurn:
    texts: List[str] = []
    calls: List[ToolCall] = []
    for index, part in enumerate(payload.get("content") or []):
        if isinstance(part, str):
            texts.append(part)
            continue
        if not isinstance(part, dict):
            continue
        if part.get("type") == "tool_use":
            calls.append(
                ToolCall(
                    id=str(part.get("id") or f"call_{index}"),
                    name=str(part.get("name") or ""),
                    arguments=_json_args(part.get("input")),
                )
            )
        elif part.get("text"):
            texts.append(str(part.get("text")))
    return LLMToolTurn(text="\n".join(texts).strip(), tool_calls=calls)


def extract_llm_text(protocol: str, payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""
    if protocol == PROTOCOL_OPENAI_RESPONSES:
        text = str(payload.get("output_text") or "").strip()
        if text:
            return text
        chunks: List[str] = []
        for item in payload.get("output") or []:
            if not isinstance(item, dict):
                continue
            for part in item.get("content") or []:
                if isinstance(part, dict):
                    value = part.get("text") or part.get("output_text")
                    if value:
                        chunks.append(str(value))
                elif isinstance(part, str):
                    chunks.append(part)
        return "\n".join(chunks).strip()
    if protocol == PROTOCOL_ANTHROPIC_MESSAGES:
        chunks = []
        for part in payload.get("content") or []:
            if isinstance(part, dict) and part.get("type", "text") in ("text", "output_text"):
                chunks.append(str(part.get("text") or ""))
            elif isinstance(part, str):
                chunks.append(part)
        return "\n".join(chunks).strip()
    choices = payload.get("choices") or []
    if choices and isinstance(choices[0], dict):
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            return "".join(str(p.get("text") if isinstance(p, dict) else p) for p in content).strip()
        if content:
            return str(content).strip()
        text = choices[0].get("text")
        if text:
            return str(text).strip()
    return str(payload.get("reply") or payload.get("text") or payload.get("content") or "").strip()


class LLMClient:
    async def complete(self, settings: LLMSettings, messages: List[Dict[str, str]]) -> str:
        missing = settings.missing_reason()
        if missing:
            raise LLMError(missing)
        request = build_llm_request(settings, messages)
        try:
            async with httpx.AsyncClient(timeout=request.timeout_s) as client:
                response = await client.request(
                    request.method,
                    request.url,
                    headers=request.headers,
                    json=request.body,
                )
        except httpx.TimeoutException as e:
            raise LLMError(f"LLM timed out after {request.timeout_s}s") from e
        except httpx.HTTPError as e:
            raise LLMError(f"LLM request failed: {e}") from e
        try:
            payload = response.json()
        except Exception:
            payload = {"text": (response.text or "")[:500]}
        if response.status_code >= 400:
            detail = ""
            if isinstance(payload, dict):
                err = payload.get("error")
                if isinstance(err, dict):
                    detail = str(err.get("message") or err.get("type") or "")
                elif err:
                    detail = str(err)
                else:
                    detail = str(payload.get("message") or "")[:300]
            raise LLMError(f"LLM HTTP {response.status_code}: {detail or 'request failed'}")
        text = extract_llm_text(request.protocol, payload)
        if not text:
            raise LLMError("LLM returned empty content")
        return text

    async def complete_with_tools(
        self,
        settings: LLMSettings,
        messages: List[TranscriptMessage],
        tools: List[ToolSpec],
    ) -> LLMToolTurn:
        missing = settings.missing_reason()
        if missing:
            raise LLMError(missing)
        request = build_tool_request(settings, messages, tools)
        try:
            async with httpx.AsyncClient(timeout=request.timeout_s) as client:
                response = await client.request(
                    request.method,
                    request.url,
                    headers=request.headers,
                    json=request.body,
                )
        except httpx.TimeoutException as exc:
            raise LLMError(f"LLM timed out after {request.timeout_s}s") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"LLM request failed: {exc}") from exc
        try:
            payload = response.json()
        except Exception:
            payload = {"text": (response.text or "")[:500]}
        if response.status_code >= 400:
            detail = ""
            if isinstance(payload, dict):
                err = payload.get("error")
                if isinstance(err, dict):
                    detail = str(err.get("message") or err.get("type") or "")
                elif err:
                    detail = str(err)
                else:
                    detail = str(payload.get("message") or "")[:300]
            raise LLMError(f"LLM HTTP {response.status_code}: {detail or 'request failed'}")
        turn = parse_tool_turn(request.protocol, payload)
        if not turn.text and not turn.tool_calls:
            raise LLMError("LLM returned empty content")
        return turn
