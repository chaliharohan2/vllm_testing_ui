from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

if TYPE_CHECKING:
    from agent_server.db import Database
    from agent_server.llm import LLMConfig

Emit = Callable[[dict[str, Any]], Awaitable[None]]


class ToolError(Exception):
    """A failure the model can act on; its message becomes the tool result."""


@dataclass
class ToolResult:
    content: str
    ok: bool = True
    summary: str = ""
    placeholder: str | None = None


@dataclass
class ToolContext:
    chat_id: str
    message_id: str
    call_id: str
    workdir: Path
    emit: Emit
    stop: asyncio.Event
    permissions: "PermissionBroker"
    db: "Database"
    llm: "LLMConfig"
    show_browser: bool
    depth: int
    active_tools: list[str]
    run_subagent: Callable[..., Awaitable[str]] | None = None

    async def progress(self, message: str) -> None:
        await self.emit({"type": "tool_progress", "id": self.call_id, "message": message})


@dataclass
class ToolSpec:
    name: str
    group: str
    description: str
    parameters: dict[str, Any]
    run: Callable[[ToolContext, dict[str, Any]], Awaitable[ToolResult]]
    # tools a subagent may not use: their output belongs in the main answer
    main_only: bool = False

    def schema(self) -> dict[str, Any]:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


@dataclass
class ToolGroup:
    id: str
    label: str
    description: str
    tools: list[str] = field(default_factory=list)


class PermissionBroker:
    """Holds approval requests (e.g. sudo) until the user answers them in the UI."""

    TIMEOUT = 600

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future] = {}

    async def ask(self, emit: Emit, stop: asyncio.Event, payload: dict[str, Any]) -> tuple[bool, str | None]:
        request_id = f"perm_{secrets.token_hex(6)}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await emit({"type": "permission", "request_id": request_id, **payload})
        stopped = asyncio.ensure_future(stop.wait())
        try:
            await asyncio.wait({future, stopped}, timeout=self.TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
        finally:
            stopped.cancel()
            self._pending.pop(request_id, None)
        approved, password = future.result() if future.done() else (False, None)
        await emit({"type": "permission_resolved", "request_id": request_id, "approved": approved,
                    "tool_call_id": payload.get("tool_call_id")})
        return approved, password

    def resolve(self, request_id: str, approved: bool, password: str | None) -> bool:
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result((approved, password))
        return True


def obj(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required}


def truncate_middle(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = int(limit * 0.6)
    tail = limit - head
    return f"{text[:head]}\n\n[... {len(text) - limit:,} characters cut ...]\n\n{text[-tail:]}"
