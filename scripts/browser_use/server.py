#!/usr/bin/env python3
"""Local sidecar the chat UI calls when "Browse" is on.

`npm run dev` starts this process and proxies `/browser/*` to it. One browser
task runs at a time; the response is a Server-Sent Events stream of steps,
then a final answer produced by the same Qwen/vLLM model the chat uses.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

# Imported for its env setup (config dir, telemetry) and shared agent builders.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_agent  # noqa: E402

from aiohttp import web  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("BROWSER_AGENT_PORT", "8787"))
RUN_LOCK = asyncio.Lock()
# Resolved once, before the asyncio loop starts. Playwright's sync API
# refuses to run while that loop is active, which would make every health
# check look like Chromium is missing.
CHROMIUM_PATH: str | None = None


def describe_actions(output: object) -> list[str]:
    actions = getattr(output, "action", None) or []
    lines: list[str] = []
    for action in actions:
        dumped = action.model_dump(exclude_none=True) if hasattr(action, "model_dump") else {}
        for name, params in dumped.items():
            if not isinstance(params, dict):
                lines.append(name)
                continue
            bits = [
                f"{key}={value}"
                for key, value in params.items()
                if value not in (None, "", [], {})
            ]
            lines.append(f"{name}({', '.join(bits)})" if bits else name)
    return lines


def step_event(summary: object, output: object, step: int) -> dict:
    return {
        "type": "step",
        "step": step,
        "url": str(getattr(summary, "url", "") or ""),
        "evaluation": str(getattr(output, "evaluation_previous_goal", "") or ""),
        "memory": str(getattr(output, "memory", "") or ""),
        "goal": str(getattr(output, "next_goal", "") or ""),
        "actions": describe_actions(output),
    }


async def run_task(
    task: str, model: str, api_key: str | None, headless: bool, max_steps: int, emit, should_stop
) -> None:
    executable_path = CHROMIUM_PATH
    if executable_path is None:
        await emit(
            {
                "type": "error",
                "message": "No Chromium binary found. Run `playwright install chromium` once, then try again.",
            }
        )
        return

    await emit({"type": "status", "message": "Starting the browser…"})

    async def on_step(summary: object, output: object, step: int) -> None:
        await emit(step_event(summary, output, step))

    agent = run_agent.build_agent(
        task,
        model,
        executable_path,
        headless,
        api_key=api_key,
        register_new_step_callback=on_step,
        register_should_stop_callback=should_stop,
    )
    history = await agent.run(max_steps=max_steps)
    result = history.final_result() or ""
    if not result and await should_stop():
        result = "Stopped before the browser agent finished."
    await emit(
        {
            "type": "done",
            "result": result,
            "success": history.is_successful() is not False and not await should_stop(),
        }
    )


async def handle_health(_request: web.Request) -> web.Response:
    chromium = CHROMIUM_PATH
    return web.json_response(
        {
            "ok": chromium is not None,
            "chromium": chromium,
            "busy": RUN_LOCK.locked(),
            "vllm": run_agent.vllm_base_url(),
        }
    )


async def handle_run(request: web.Request) -> web.StreamResponse:
    if RUN_LOCK.locked():
        return web.json_response(
            {"error": "A browser task is already running. Stop it or wait for it to finish."},
            status=409,
        )

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Expected a JSON body."}, status=400)

    task = str(body.get("task") or "").strip()
    model = str(body.get("model") or run_agent.DEFAULT_MODEL).strip()
    api_key = str(body.get("apiKey") or "").strip() or None
    if not task:
        return web.json_response({"error": "A task is required."}, status=400)
    try:
        max_steps = int(body.get("maxSteps") or 12)
    except (TypeError, ValueError):
        max_steps = 12
    max_steps = min(max(max_steps, 1), 30)
    headless = not bool(body.get("showBrowser"))

    async with RUN_LOCK:
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)
        stop = asyncio.Event()

        async def emit(event: dict) -> None:
            if stop.is_set():
                return
            try:
                await response.write(f"data: {json.dumps(event)}\n\n".encode())
            except (ConnectionResetError, RuntimeError):
                stop.set()

        async def should_stop() -> bool:
            return stop.is_set()

        try:
            await run_task(task, model, api_key, headless, max_steps, emit, should_stop)
        except asyncio.CancelledError:
            stop.set()
            raise
        except Exception as caught:
            await emit({"type": "error", "message": str(caught) or "The browser agent failed."})
        return response


def main() -> None:
    global CHROMIUM_PATH
    CHROMIUM_PATH = run_agent.find_chromium_executable()
    if CHROMIUM_PATH:
        print(f"Chromium: {CHROMIUM_PATH}", flush=True)
    else:
        print("Chromium was not found. Run `playwright install chromium`.", flush=True)

    app = web.Application()
    app.router.add_get("/browser/health", handle_health)
    app.router.add_post("/browser/run", handle_run)
    web.run_app(app, host=HOST, port=PORT, print=lambda message: print(message, flush=True))


if __name__ == "__main__":
    main()
