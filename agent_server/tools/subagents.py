"""Subagents: a fresh agent loop with its own context that works on one task and reports back.

Several spawn_subagent calls in one model turn run at the same time.
"""

from __future__ import annotations

from typing import Any

from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj


async def spawn_subagent(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    task = str(args.get("task") or "").strip()
    if not task:
        raise ToolError("task is required")
    if ctx.run_subagent is None or ctx.depth > 0:
        raise ToolError("subagents cannot start other subagents")
    name = str(args.get("name") or "").strip()[:40] or "subagent"
    requested = args.get("tools")
    report = await ctx.run_subagent(ctx, name, task, requested if isinstance(requested, list) else None)
    return ToolResult(f"Report from subagent '{name}':\n\n{report}", summary=name)


TOOLS = [
    ToolSpec(
        "spawn_subagent", "subagents",
        "Hand a self-contained task to a subagent. It starts with an empty context (it does not see this "
        "chat), uses the same tools as you (except subagents and artifacts) and returns a written report. "
        "Use it for independent research or work that would flood your context, and call it several times "
        "in one turn to run tasks in parallel. Write the task with everything the subagent needs: goal, "
        "relevant paths or URLs, constraints, and what the report must contain.",
        obj({"name": {"type": "string", "description": "A short label, e.g. 'pricing research'."},
             "task": {"type": "string", "description": "The complete task description."},
             "tools": {"type": "array", "items": {"type": "string"},
                       "description": "Optional: limit the subagent to these tool groups (files, bash, "
                                      "web_search, web_fetch, browser)."}},
            ["name", "task"]),
        spawn_subagent, main_only=True),
]
