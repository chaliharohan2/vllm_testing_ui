"""What an assistant turn shows, in order: reasoning, text and tool cards.

The server and the UI apply the same stream events to build it (see src/lib/parts.ts).
"""

from __future__ import annotations

from typing import Any

MAX_PROGRESS = 60


def _tool(parts: list[dict[str, Any]], call_id: str) -> dict[str, Any] | None:
    for part in reversed(parts):
        if part["type"] == "tool" and part["id"] == call_id:
            return part
    return None


def apply_event(parts: list[dict[str, Any]], event: dict[str, Any]) -> None:
    kind = event.get("type")
    if kind in ("text", "reasoning"):
        if parts and parts[-1]["type"] == kind:
            parts[-1]["text"] += event["text"]
        else:
            parts.append({"type": kind, "text": event["text"]})
    elif kind == "tool_start":
        parts.append({"type": "tool", "id": event["id"], "name": event["name"], "args": event.get("args") or {},
                      "status": "running", "summary": "", "output": "", "progress": []})
    elif kind == "tool_progress":
        part = _tool(parts, event["id"])
        if part is not None:
            part["progress"] = (part["progress"] + [event["message"]])[-MAX_PROGRESS:]
    elif kind == "tool_end":
        part = _tool(parts, event["id"])
        if part is not None:
            part.update(status="done" if event.get("ok") else "error", summary=event.get("summary") or "",
                        output=event.get("output") or "")
    elif kind == "permission":
        part = _tool(parts, event.get("tool_call_id") or "")
        if part is not None:
            part["permission"] = {"request_id": event["request_id"], "command": event.get("command", ""),
                                  "reason": event.get("reason", ""), "state": "pending"}
    elif kind == "permission_resolved":
        part = _tool(parts, event.get("tool_call_id") or "")
        if part is not None and part.get("permission", {}).get("request_id") == event["request_id"]:
            part["permission"]["state"] = "approved" if event.get("approved") else "denied"


def finalize(parts: list[dict[str, Any]]) -> None:
    """A stopped turn leaves running tools and open permission prompts behind."""
    for part in parts:
        if part["type"] == "tool":
            if part["status"] == "running":
                part["status"] = "error"
                part["summary"] = part["summary"] or "stopped"
            if part.get("permission", {}).get("state") == "pending":
                part["permission"]["state"] = "denied"
