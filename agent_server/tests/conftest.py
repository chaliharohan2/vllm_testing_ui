from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable

import pytest

from agent_server import agent as agent_module
from agent_server.agent import RunEnv
from agent_server.db import Database
from agent_server.llm import LLMConfig, LLMResponse, ToolCall
from agent_server.tools.base import PermissionBroker, ToolContext


def call(tool: str, call_id: str | None = None, **arguments: Any) -> ToolCall:
    return ToolCall(call_id or f"call_{tool}", tool, arguments, json.dumps(arguments))


class FakeLLM:
    """Replays scripted replies. A reply is an LLMResponse, or a function of the request
    (messages, tools) that returns one. Text is streamed in small chunks."""

    def __init__(self, replies: list[LLMResponse | Callable[..., LLMResponse]]):
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []

    async def __call__(self, config, messages, tools, on_text, on_reasoning, stop, known_tools=None):
        self.requests.append({"messages": messages, "tools": tools})
        reply = self.replies.pop(0)
        if callable(reply):
            reply = reply(messages, tools)
        if reply.reasoning:
            await on_reasoning(reply.reasoning)
        for i in range(0, len(reply.text), 7):
            await on_text(reply.text[i:i + 7])
        return LLMResponse(text=reply.text, reasoning=reply.reasoning, tool_calls=list(reply.tool_calls),
                           finish_reason=reply.finish_reason or "stop", usage={"prompt_tokens": 10,
                                                                                 "completion_tokens": 5})


@pytest.fixture
def db() -> Database:
    return Database(":memory:")


@pytest.fixture
def fake_llm(monkeypatch):
    def install(replies):
        fake = FakeLLM(replies)
        monkeypatch.setattr(agent_module, "stream_chat", fake)
        return fake

    return install


@pytest.fixture
def env(db: Database, tmp_path: Path) -> RunEnv:
    chat = db.create_chat("Test", {})
    message_id = db.add_message(chat["id"], "assistant", status="running")
    return RunEnv(db=db, chat_id=chat["id"], message_id=message_id, workdir=tmp_path,
                  llm=LLMConfig(model="test-model", base_url="http://unused"), permissions=PermissionBroker(),
                  show_browser=False, stop=asyncio.Event())


@pytest.fixture
def ctx(env: RunEnv) -> ToolContext:
    events: list[dict[str, Any]] = []

    async def emit(event):
        events.append(event)

    context = ToolContext(chat_id=env.chat_id, message_id=env.message_id, call_id="call_1", workdir=env.workdir,
                          emit=emit, stop=env.stop, permissions=env.permissions, db=env.db, llm=env.llm,
                          show_browser=False, depth=0, active_tools=[])
    context.events = events  # type: ignore[attr-defined]
    return context
