"""Drive a real Chromium with browser-use (scripts/browser_use), one task at a time."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj

BROWSER_USE_DIR = Path(__file__).resolve().parents[2] / "scripts" / "browser_use"
RUN_LOCK = asyncio.Lock()
# set once at startup, before the asyncio loop runs: Playwright's sync API refuses to run inside it
CHROMIUM_PATH: str | None = None


def _run_agent_module():
    if str(BROWSER_USE_DIR) not in sys.path:
        sys.path.insert(0, str(BROWSER_USE_DIR))
    import run_agent  # noqa: PLC0415 - heavy import, only when the browser is used

    return run_agent


def find_chromium() -> str | None:
    try:
        return _run_agent_module().find_chromium_executable()
    except ImportError:
        return None


def _describe_actions(output: object) -> str:
    names = []
    for action in getattr(output, "action", None) or []:
        dumped = action.model_dump(exclude_none=True) if hasattr(action, "model_dump") else {}
        for name, params in dumped.items():
            detail = ""
            if isinstance(params, dict):
                detail = ", ".join(f"{k}={str(v)[:60]}" for k, v in params.items() if v not in (None, "", [], {}))
            names.append(f"{name}({detail})" if detail else name)
    return "; ".join(names)


async def browse_web(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    task = str(args.get("task") or "").strip()
    if not task:
        raise ToolError("task is required")
    if CHROMIUM_PATH is None:
        raise ToolError("Chromium is not installed for the browser tool. The user must run "
                        "`playwright install chromium` once.")
    max_steps = max(1, min(int(args.get("max_steps") or 15), 40))
    if RUN_LOCK.locked():
        await ctx.progress("Waiting for another browser task to finish…")
    async with RUN_LOCK:
        run_agent = _run_agent_module()
        await ctx.progress("Starting the browser…")

        async def on_step(summary: object, output: object, step: int) -> None:
            url = str(getattr(summary, "url", "") or "")
            goal = str(getattr(output, "next_goal", "") or "")
            actions = _describe_actions(output)
            await ctx.progress(" · ".join(bit for bit in (f"Step {step}", url, goal, actions) if bit))

        async def should_stop() -> bool:
            return ctx.stop.is_set()

        agent = run_agent.build_agent(
            task, ctx.llm.model, CHROMIUM_PATH, not ctx.show_browser, api_key=ctx.llm.api_key or None,
            register_new_step_callback=on_step, register_should_stop_callback=should_stop)
        history = await agent.run(max_steps=max_steps)
    result = history.final_result() or ""
    steps = len(history.history)
    if not result:
        result = "The browser agent finished without a written result."
    success = history.is_successful() is not False
    return ToolResult(f"Browser result after {steps} steps:\n{result}", ok=success,
                      summary=f"{steps} steps" + ("" if success else " · not completed"))


TOOLS = [
    ToolSpec(
        "browse_web", "browser",
        "Give a task to a browser agent that drives a real Chromium (clicks, types, scrolls, logs in to "
        "nothing). Slow: use it only for pages that need JavaScript or interaction, where web_fetch is not "
        "enough. Describe the task fully, including the URL to start from and exactly what to report back.",
        obj({"task": {"type": "string"},
             "max_steps": {"type": "integer", "description": "Browser steps allowed (default 15, max 40)."}},
            ["task"]),
        browse_web),
]
