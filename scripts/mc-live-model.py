"""Acceptance-only model adapter. Credentials stay in memory; never log request bodies."""
import asyncio
import json
import re
import subprocess
import sys
import httpx

from gamebot.brain.client import LLMClient, ToolSpec, TranscriptMessage
from gamebot.brain.settings import LLMSettings, provider_defaults


def vertex_body(request):
    """One fresh game decision; reuse the host prompt and advertised action schemas."""
    return {
        "systemInstruction": {"parts": [{"text": request["prompt"]["system"]}]},
        "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]} for m in request["prompt"]["messages"]],
        "tools": [{"functionDeclarations": [{"name": t["name"], "description": t.get("description", ""), "parametersJsonSchema": t["parameters"]} for t in request["tools"]]}],
        "generationConfig": {"maxOutputTokens": 8192},
    }


def vertex_result(payload):
    candidates = payload.get("candidates", [])
    if not candidates or candidates[0].get("finishReason") not in (None, "STOP"):
        raise ValueError("Gemini decision incomplete or blocked")
    parts = candidates[0].get("content", {}).get("parts", [])
    calls = [{"name": p["functionCall"]["name"], "arguments": p["functionCall"].get("args", {})} for p in parts if p.get("functionCall", {}).get("name")]
    text = "".join(p["text"] for p in parts if "text" in p and not p.get("thought"))
    if not text and not calls:
        raise ValueError("Gemini empty content")
    usage = payload.get("usageMetadata") or {}
    return {"text": text, "toolCalls": calls, "usage": {"input": usage.get("promptTokenCount"), "output": usage.get("candidatesTokenCount"), "thoughts": usage.get("thoughtsTokenCount")}}


async def main():
    request = json.load(sys.stdin)
    provider = {"deepseek-official": "deepseek", "xai-vision": "xai", "google-vertex-vision": "vertex"}.get(request["seat"]["provider"])
    if provider is None:
        raise ValueError("unsupported live acceptance provider")
    ref = {"deepseek": "DEEPSEEK_API_KEY", "xai": "XAI_API_KEY", "vertex": "GOOGLE_VERTEX_API_KEY"}[provider]
    credential = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "S:/TRIX/tools/get-credential.ps1", "-Name", ref], capture_output=True, text=True, check=True).stdout.strip()
    if provider == "vertex":
        model = request["seat"]["model"]
        if not re.fullmatch(r"[A-Za-z0-9._-]+", model):
            raise ValueError("invalid Gemini model")
        async with httpx.AsyncClient(timeout=85) as client:
            response = await client.post(f"https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent", headers={"x-goog-api-key": credential}, json=vertex_body(request))
        if response.status_code != 200:
            raise RuntimeError(f"LLM HTTP {response.status_code}")
        print(json.dumps(vertex_result(response.json()), ensure_ascii=False))
        return
    defaults = provider_defaults(provider)
    settings = LLMSettings(enabled=True, provider=provider, protocol=defaults["protocol"], base_url=defaults["base_url"], model=request["seat"]["model"], api_key=credential, timeout_s=85, max_tokens=8192)
    messages = [TranscriptMessage(role="system", content=request["prompt"]["system"])]
    messages.extend(TranscriptMessage(role=m["role"], content=m["content"]) for m in request["prompt"]["messages"])
    result = await LLMClient().complete_with_tools(settings, messages, [ToolSpec(**tool) for tool in request["tools"]])
    print(json.dumps({"text": result.text, "toolCalls": [{"name": c.name, "arguments": c.arguments} for c in result.tool_calls]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        # Provider errors may quote prompts. Only emit the type; do not leak private turns.
        code = re.search(r"LLM HTTP (\d{3})", str(exc))
        category = " timeout" if "timed out" in str(exc) else " empty-content" if "empty content" in str(exc) else ""
        print(json.dumps({"error": type(exc).__name__ + (" HTTP " + code.group(1) if code else category)}))
        sys.exit(1)
