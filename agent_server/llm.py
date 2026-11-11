"""Streaming chat completions against the vLLM OpenAI-compatible server."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from agent_server.toolcall_parse import extract_tool_calls, parse_arguments

OnDelta = Callable[[str], Awaitable[None]]


def vllm_base_url() -> str:
    base = os.environ.get("VLLM_BASE_URL", "http://localhost:8000").rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


@dataclass
class LLMConfig:
    model: str
    api_key: str = ""
    base_url: str = field(default_factory=vllm_base_url)
    enable_thinking: bool = False
    # OpenAI / vLLM sampling fields sent as-is: temperature, max_tokens, top_p, top_k, ...
    params: dict[str, Any] = field(default_factory=dict)

    def headers(self) -> dict[str, str]:
        key = self.api_key.strip() or os.environ.get("VLLM_API_KEY", "").strip()
        # servers started without --api-key reject requests that carry an Authorization header
        return {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str
    error: str | None = None

    def message(self) -> dict[str, Any]:
        return {"id": self.id, "type": "function",
                "function": {"name": self.name, "arguments": self.raw_arguments or json.dumps(self.arguments)}}


@dataclass
class LLMResponse:
    text: str = ""
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    stopped: bool = False
    error: str | None = None


class LLMError(Exception):
    pass


def _call_id() -> str:
    return f"call_{secrets.token_hex(8)}"


async def stream_chat(config: LLMConfig, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
                      on_text: OnDelta, on_reasoning: OnDelta, stop: asyncio.Event,
                      known_tools: set[str] | None = None) -> LLMResponse:
    payload: dict[str, Any] = {
        "model": config.model, "messages": messages, "stream": True,
        "stream_options": {"include_usage": True}, **config.params,
        "chat_template_kwargs": {"enable_thinking": config.enable_thinking},
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    response = LLMResponse()
    partial: dict[int, dict[str, str]] = {}
    timeout = httpx.Timeout(connect=15, read=600, write=60, pool=15)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{config.base_url}/chat/completions", json=payload,
                                     headers=config.headers()) as r:
                if r.status_code >= 400:
                    body = (await r.aread()).decode("utf-8", errors="replace")
                    try:
                        message = json.loads(body).get("error", {}).get("message") or body
                    except (ValueError, AttributeError):
                        message = body
                    raise LLMError(f"vLLM answered HTTP {r.status_code}: {str(message)[:500]}")
                async for line in r.aiter_lines():
                    if stop.is_set():
                        response.stopped = True
                        break
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if chunk.get("error"):
                        raise LLMError(chunk["error"].get("message") or "vLLM streaming error")
                    if chunk.get("usage"):
                        response.usage = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        thinking = delta.get("reasoning") or delta.get("reasoning_content")
                        if thinking:
                            response.reasoning += thinking
                            await on_reasoning(thinking)
                        if delta.get("content"):
                            response.text += delta["content"]
                            await on_text(delta["content"])
                        for call in delta.get("tool_calls") or []:
                            slot = partial.setdefault(call.get("index", len(partial)),
                                                      {"id": "", "name": "", "arguments": ""})
                            function = call.get("function") or {}
                            slot["id"] = call.get("id") or slot["id"]
                            slot["name"] += function.get("name") or ""
                            slot["arguments"] += function.get("arguments") or ""
                        if choice.get("finish_reason"):
                            response.finish_reason = choice["finish_reason"]
    except httpx.HTTPError as exc:
        raise LLMError(f"could not reach vLLM at {config.base_url} ({exc.__class__.__name__}: {exc})") from exc

    for index in sorted(partial):
        slot = partial[index]
        if not slot["name"]:
            continue
        args, error = parse_arguments(slot["arguments"])
        response.tool_calls.append(ToolCall(slot["id"] or _call_id(), slot["name"], args, slot["arguments"], error))

    if not response.tool_calls and not response.stopped and ("<tool_call>" in response.text
                                                             or "<function=" in response.text):
        parsed, rest = extract_tool_calls(response.text, known_tools)
        if parsed:
            response.text = rest
            response.tool_calls = [ToolCall(_call_id(), p.name, p.arguments, json.dumps(p.arguments), p.error)
                                   for p in parsed]
    return response
