#!/usr/bin/env python3
"""Local agent server the chat UI talks to. `npm run dev` starts it and proxies /api to it.

POST /api/chat streams a turn as Server-Sent Events; everything else is JSON.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from aiohttp import web  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")

from agent_server.agent import RunEnv, run_turn  # noqa: E402
from agent_server.db import Database  # noqa: E402
from agent_server.llm import LLMConfig, vllm_base_url  # noqa: E402
from agent_server.tools import GROUP_IDS, GROUPS, browser  # noqa: E402
from agent_server.tools.base import PermissionBroker  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("AGENT_SERVER_PORT", "8787"))
DB_PATH = Path(os.environ.get("AGENT_DB_PATH", REPO_ROOT / "data" / "chats.db"))
DEFAULT_WORKDIR = Path(os.environ.get("AGENT_WORKDIR", REPO_ROOT / "workspace")).expanduser()
TITLE_MAX = 60

log = logging.getLogger("agent")

DB = web.AppKey("db", Database)
PERMISSIONS = web.AppKey("permissions", PermissionBroker)
RUNS = web.AppKey("runs", dict)

SAMPLING_KEYS = {"temperature": "temperature", "maxTokens": "max_tokens", "topP": "top_p", "topK": "top_k",
                 "minP": "min_p", "repetitionPenalty": "repetition_penalty"}


def short_title(text: str) -> str:
    title = " ".join(text.split()).strip() or "Image"
    if len(title) > TITLE_MAX:
        cut = title[: TITLE_MAX + 1].rsplit(" ", 1)[0]
        title = (cut if len(cut) >= TITLE_MAX // 2 else title[:TITLE_MAX]).rstrip(" ,.;:-") + "…"
    return title


def llm_config(settings: dict[str, Any]) -> LLMConfig:
    params: dict[str, Any] = {}
    for key, name in SAMPLING_KEYS.items():
        if isinstance(settings.get(key), (int, float)) and not isinstance(settings.get(key), bool):
            params[name] = settings[key]
    seed = str(settings.get("seed") or "").strip()
    if seed.lstrip("-").isdigit():
        params["seed"] = int(seed)
    stop = [line.strip() for line in str(settings.get("stop") or "").splitlines() if line.strip()]
    if stop:
        params["stop"] = stop
    return LLMConfig(model=str(settings.get("model") or "").strip(), api_key=str(settings.get("apiKey") or ""),
                     enable_thinking=bool(settings.get("enableThinking")), params=params)


def user_llm_message(content: str, attachments: list[dict[str, Any]]) -> dict[str, Any]:
    images = [a["dataUrl"] for a in attachments if isinstance(a, dict) and isinstance(a.get("dataUrl"), str)]
    if not images:
        return {"role": "user", "content": content}
    parts: list[dict[str, Any]] = [{"type": "text", "text": content}] if content.strip() else []
    parts += [{"type": "image_url", "image_url": {"url": url}} for url in images]
    return {"role": "user", "content": parts}


def history_messages(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        if row["role"] == "user":
            out.append(user_llm_message(row["content"], row["attachments"]))
        elif row["llm"]:
            out.extend(row["llm"])
        elif row["content"].strip():
            out.append({"role": "assistant", "content": row["content"]})
    return out


def public_message(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "role": row["role"], "content": row["content"], "parts": row["parts"],
            "attachments": row["attachments"], "status": row["status"], "notice": row["notice"]}


def resolve_workdir(raw: Any) -> Path:
    text = str(raw or "").strip()
    path = Path(text).expanduser() if text else DEFAULT_WORKDIR
    if not path.is_absolute():
        raise ValueError("The working folder must be an absolute path.")
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


# --------------------------------------------------------------------------- handlers

async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "chromium": browser.CHROMIUM_PATH, "vllm": vllm_base_url(),
                              "workdir": str(DEFAULT_WORKDIR), "busy": list(request.app[RUNS])})


async def handle_tools(_request: web.Request) -> web.Response:
    return web.json_response({"groups": [{"id": g.id, "label": g.label, "description": g.description,
                                          "tools": g.tools} for g in GROUPS],
                              "chromium": browser.CHROMIUM_PATH is not None})


async def handle_list_chats(request: web.Request) -> web.Response:
    return web.json_response({"chats": request.app[DB].list_chats()})


async def handle_get_chat(request: web.Request) -> web.Response:
    db = request.app[DB]
    chat = db.get_chat(request.match_info["chat_id"])
    if chat is None:
        return web.json_response({"error": "Chat not found."}, status=404)
    return web.json_response({"chat": chat, "messages": [public_message(m) for m in db.messages(chat["id"])],
                              "running": chat["id"] in request.app[RUNS]})


async def handle_delete_chat(request: web.Request) -> web.Response:
    chat_id = request.match_info["chat_id"]
    stop = request.app[RUNS].get(chat_id)
    if stop is not None:
        stop.set()
    if not request.app[DB].delete_chat(chat_id):
        return web.json_response({"error": "Chat not found."}, status=404)
    return web.json_response({"ok": True})


async def handle_stop(request: web.Request) -> web.Response:
    stop = request.app[RUNS].get(request.match_info["chat_id"])
    if stop is not None:
        stop.set()
    return web.json_response({"ok": True, "running": stop is not None})


async def handle_permission(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Expected a JSON body."}, status=400)
    password = body.get("password")
    resolved = request.app[PERMISSIONS].resolve(request.match_info["request_id"], bool(body.get("approve")),
                                                password if isinstance(password, str) else None)
    if not resolved:
        return web.json_response({"error": "That request is no longer waiting."}, status=404)
    return web.json_response({"ok": True})


async def handle_artifact(request: web.Request) -> web.Response:
    version = request.query.get("version")
    artifact = request.app[DB].get_artifact(request.match_info["artifact_id"],
                                            int(version) if version and version.isdigit() else None)
    if artifact is None:
        return web.json_response({"error": "Artifact not found."}, status=404)
    return web.json_response(artifact)


async def handle_chat(request: web.Request) -> web.StreamResponse:
    app = request.app
    db: Database = app[DB]
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Expected a JSON body."}, status=400)

    settings = body.get("settings") or {}
    message = body.get("message") or {}
    content = str(message.get("content") or "")
    attachments = [a for a in message.get("attachments") or [] if isinstance(a, dict)]
    groups = [g for g in body.get("tools") or [] if g in GROUP_IDS]
    llm = llm_config(settings)
    if not content.strip() and not attachments:
        return web.json_response({"error": "The message is empty."}, status=400)
    if not llm.model:
        return web.json_response({"error": "Choose a model first."}, status=400)
    try:
        workdir = resolve_workdir(body.get("workdir"))
    except (ValueError, OSError) as exc:
        return web.json_response({"error": f"Working folder: {exc}"}, status=400)
    try:
        max_steps = max(1, min(int(body.get("maxSteps") or 30), 100))
    except (TypeError, ValueError):
        max_steps = 30

    chat_settings = {"tools": groups, "workdir": str(workdir), "showBrowser": bool(body.get("showBrowser")),
                     "maxSteps": max_steps}
    chat_id = body.get("chatId")
    chat = db.get_chat(chat_id) if chat_id else None
    if chat_id and chat is None:
        return web.json_response({"error": "Chat not found."}, status=404)
    if chat is None:
        chat = db.create_chat(short_title(content), chat_settings)
    elif chat["id"] in app[RUNS]:
        return web.json_response({"error": "This chat is still answering. Stop it or wait."}, status=409)
    else:
        db.update_chat(chat["id"], settings=chat_settings)
    chat_id = chat["id"]

    history = history_messages(db.messages(chat_id))
    db.add_message(chat_id, "user", content=content, attachments=attachments)
    assistant_id = db.add_message(chat_id, "assistant", status="running")
    stop = asyncio.Event()
    app[RUNS][chat_id] = stop

    response = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
        "X-Accel-Buffering": "no"})
    write_lock = asyncio.Lock()
    client_gone = False

    async def emit(event: dict[str, Any]) -> None:
        nonlocal client_gone
        if client_gone:
            return
        try:
            async with write_lock:
                await response.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode())
        except (ConnectionResetError, RuntimeError):
            # the tab closed or the user hit Stop: finish the turn as stopped
            client_gone = True
            stop.set()

    env = RunEnv(db=db, chat_id=chat_id, message_id=assistant_id, workdir=workdir, llm=llm,
                 permissions=app[PERMISSIONS], show_browser=bool(body.get("showBrowser")), stop=stop,
                 max_steps=max_steps)
    try:
        await response.prepare(request)
        await emit({"type": "start", "chat_id": chat_id, "title": chat["title"], "message_id": assistant_id})
        done = await run_turn(env, groups, str(settings.get("systemPrompt") or ""), history,
                              user_llm_message(content, attachments), emit)
        db.update_chat(chat_id)
        await emit(done)
    finally:
        app[RUNS].pop(chat_id, None)
    return response


def build_app(db: Database | None = None) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app[DB] = db or Database(DB_PATH)
    app[PERMISSIONS] = PermissionBroker()
    app[RUNS] = {}
    app.router.add_get("/api/health", handle_health)
    app.router.add_get("/api/tools", handle_tools)
    app.router.add_get("/api/chats", handle_list_chats)
    app.router.add_get("/api/chats/{chat_id}", handle_get_chat)
    app.router.add_delete("/api/chats/{chat_id}", handle_delete_chat)
    app.router.add_post("/api/chats/{chat_id}/stop", handle_stop)
    app.router.add_post("/api/chat", handle_chat)
    app.router.add_post("/api/permissions/{request_id}", handle_permission)
    app.router.add_get("/api/artifacts/{artifact_id}", handle_artifact)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    browser.CHROMIUM_PATH = browser.find_chromium()
    print(f"Chromium: {browser.CHROMIUM_PATH or 'not found (run `playwright install chromium`)'}", flush=True)
    print(f"Chats: {DB_PATH}  Working folder: {DEFAULT_WORKDIR}", flush=True)
    web.run_app(build_app(), host=HOST, port=PORT, print=lambda message: print(message, flush=True))


if __name__ == "__main__":
    main()
