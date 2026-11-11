"""The agent loop: model turn -> tool calls -> model turn ... until the model answers without tools.

Tools are chosen per request, so they can change between messages of a chat. vLLM is
stateless and takes a new ``tools`` list every request; the only cost of a change is a
prefix-cache miss, since Qwen's chat template renders the tools at the top of the prompt.
The model still sees calls to tools that are now off in the history and tends to call
them again, so the system prompt names them as turned off and any such call is answered
with an error instead of being run.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from agent_server.llm import LLMConfig, LLMError, stream_chat
from agent_server.parts import apply_event, finalize
from agent_server.text_filters import PlaceholderFilter, ToolCallTextFilter
from agent_server.tools import GROUP_IDS, TOOLS, tools_for_groups
from agent_server.tools.base import Emit, PermissionBroker, ToolContext, ToolError, ToolResult, ToolSpec, \
    truncate_middle

log = logging.getLogger("agent")

MAX_TOOL_RESULT = 30_000
MAX_TOOL_OUTPUT_SHOWN = 6_000
SUBAGENT_MAX_STEPS = 25
SUBAGENT_GROUPS_EXCLUDED = ("subagents", "artifacts")

STOPPED_TOOL = "Stopped by the user before the tool finished."
BUDGET_NOTE = "\n\n[No more tool calls are possible in this turn. Answer now with what you have, and say what is missing.]"
# the model stopped after tool results without writing anything: one more turn to write the answer
ANSWER_NOTE = "\n\n[Now write your answer to the user from the results above.]"

MAIN_GUIDE = """\
# Working with tools
You can use tools. Use them when they make the answer more accurate or when the user asks you to act; answer \
directly when they would not help. Work step by step: look before you change things, check your work after \
(read the file back, run the test), and fix what fails. Between tool calls, tell the user in one short \
sentence what you are doing. When you finish, give a brief summary of what you did and found."""

SUBAGENT_GUIDE = """\
You are a subagent. A main agent gave you one task; the user does not see your messages. Do the task with your \
tools, then reply with a report the main agent can use directly: the results, with concrete details (file \
paths, commands and their outcome, URLs, figures), and anything you could not do. No greetings or questions: \
you cannot get answers."""

GROUP_NOTES = {
    "files": "Files: the working folder is {workdir}. File tools only work inside it; relative paths are relative "
             "to it. Read a file before editing it.",
    "bash": "Terminal: commands run in {workdir} with no terminal input. Avoid sudo; if root is truly needed, the "
            "user is asked to approve the command and enter the password. Never print or ask for passwords.",
    "web_search": "Web: search results are leads, not facts. Read the pages you rely on and name your sources "
                  "with their URLs.",
    "web_fetch": "",
    "browser": "Browser: browse_web is slow; prefer web_fetch for pages that do not need interaction.",
    "artifacts": "Artifacts: put substantial standalone content (documents, full code files, HTML pages, SVG, "
                 "diagrams) in create_artifact instead of the reply, and keep the reply short. The app shows the "
                 "artifact in your answer by itself: never write links to #artifact/ yourself.",
    "subagents": "Subagents: for independent pieces of a larger task, call spawn_subagent several times in one "
                 "turn so they run in parallel, then combine their reports.",
}


@dataclass
class RunEnv:
    db: Any
    chat_id: str
    message_id: str
    workdir: Path
    llm: LLMConfig
    permissions: PermissionBroker
    show_browser: bool
    stop: asyncio.Event
    max_steps: int = 30


def used_tools(messages: list[dict[str, Any]]) -> set[str]:
    names = set()
    for message in messages:
        for call in message.get("tool_calls") or []:
            names.add((call.get("function") or {}).get("name", ""))
    return {name for name in names if name}


def short_args(args: dict[str, Any], limit: int = 90) -> str:
    for key in ("command", "query", "url", "path", "task", "title"):
        if isinstance(args.get(key), str):
            value = " ".join(args[key].split())
            return value if len(value) <= limit else value[: limit - 1] + "…"
    text = json.dumps(args, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Agent:
    def __init__(self, env: RunEnv, groups: list[str], emit: Emit, *, depth: int = 0, system_prompt: str = "",
                 max_steps: int | None = None):
        self.env = env
        self.depth = depth
        excluded = SUBAGENT_GROUPS_EXCLUDED if depth else ()
        self.groups = [g for g in GROUP_IDS if g in groups and g not in excluded]
        self.specs: dict[str, ToolSpec] = {spec.name: spec for spec in tools_for_groups(self.groups, depth)}
        self._emit = emit
        self.system_prompt = system_prompt
        self.max_steps = max_steps or env.max_steps
        self.parts: list[dict[str, Any]] = []
        self.content = ""
        self.notice = ""
        self.error = ""
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "steps": 0, "tool_calls": 0}
        self._turn_has_text = False

    # ------------------------------------------------------------------ events and answer text

    async def event(self, event: dict[str, Any]) -> None:
        apply_event(self.parts, event)
        await self._emit(event)

    def _paragraph_gap(self) -> str:
        if not self.content or self.content.endswith("\n\n"):
            return ""
        return "\n" if self.content.endswith("\n") else "\n\n"

    async def emit_text(self, text: str) -> None:
        """Model text; a step's first text starts a new paragraph after earlier content."""
        if not text:
            return
        if not self._turn_has_text:
            text = text.lstrip()
            if not text:
                return
            self._turn_has_text = True
            text = self._paragraph_gap() + text
        self.content += text
        await self.event({"type": "text", "text": text})

    async def emit_placeholder(self, link: str) -> None:
        """A placeholder always stands on its own paragraph."""
        text = self._paragraph_gap() + link + "\n\n"
        self.content += text
        await self.event({"type": "text", "text": text})
        self._turn_has_text = False

    # ------------------------------------------------------------------ prompt

    def system_message(self, messages: list[dict[str, Any]], final: bool) -> dict[str, Any]:
        sections = [self.system_prompt.strip()] if self.system_prompt.strip() else []
        if self.specs:
            sections.append(SUBAGENT_GUIDE if self.depth else MAIN_GUIDE)
            notes = [GROUP_NOTES[g].format(workdir=self.env.workdir) for g in self.groups if GROUP_NOTES.get(g)]
            if notes:
                sections.append("\n".join(f"- {note}" for note in notes))
        elif self.depth:
            sections.append(SUBAGENT_GUIDE)
        turned_off = sorted(used_tools(messages) - set(self.specs))
        if turned_off:
            sections.append("The user can turn tools on and off during the chat. Turned off now: "
                            f"{', '.join(turned_off)}. Never call a tool that is turned off; if the user needs "
                            "one, tell them to turn it on in the tool picker.")
        if final:
            sections.append("You cannot call any more tools in this turn.")
        sections.append(f"Today is {datetime.now().strftime('%A, %d %B %Y, %H:%M')}.")
        return {"role": "system", "content": "\n\n".join(sections)}

    @staticmethod
    def prepare(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep reasoning only for the current turn, as Qwen's chat template expects."""
        last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
        return [{k: v for k, v in m.items() if k != "reasoning_content"} if i < last_user else m
                for i, m in enumerate(messages)]

    # ------------------------------------------------------------------ loop

    async def run(self, messages: list[dict[str, Any]]) -> str:
        """Appends the turn's assistant and tool messages to ``messages``. Returns
        completed, stopped or failed."""
        step, nudged = 0, False
        while True:
            step += 1
            if self.env.stop.is_set():
                return "stopped"
            final = step >= self.max_steps
            if final and messages[-1]["role"] == "tool":
                messages[-1] = {**messages[-1], "content": messages[-1]["content"] + BUDGET_NOTE}
            schemas = [] if final else [spec.schema() for spec in self.specs.values()]
            filters = (ToolCallTextFilter(), PlaceholderFilter())
            self._turn_has_text = False

            async def on_text(delta: str) -> None:
                for text_filter in filters:
                    delta = text_filter.feed(delta)
                await self.emit_text(delta)

            async def on_reasoning(delta: str) -> None:
                await self.event({"type": "reasoning", "text": delta})

            try:
                response = await stream_chat(self.env.llm, [self.system_message(messages, final),
                                                            *self.prepare(messages)],
                                             schemas, on_text, on_reasoning, self.env.stop, set(self.specs))
            except LLMError as exc:
                self.error = str(exc)
                return "failed"
            self.usage["steps"] += 1
            self.usage["prompt_tokens"] += int(response.usage.get("prompt_tokens") or 0)
            self.usage["completion_tokens"] += int(response.usage.get("completion_tokens") or 0)
            if response.stopped:
                if response.text.strip():
                    messages.append({"role": "assistant", "content": response.text})
                return "stopped"
            rest = ""
            for text_filter in filters:
                rest = text_filter.feed(rest) + text_filter.flush()
            await self.emit_text(rest)

            calls = [] if final else response.tool_calls
            if not calls:
                if final and response.tool_calls:
                    self.notice = f"Stopped at the limit of {self.max_steps} steps for one message."
                if not response.text.strip() and messages[-1]["role"] == "tool" and not nudged and not final:
                    nudged = True
                    messages[-1] = {**messages[-1], "content": messages[-1]["content"] + ANSWER_NOTE}
                    continue
                messages.append({"role": "assistant", "content": response.text})
                if response.finish_reason == "length":
                    self.notice = self.notice or "Output was cut off by the max tokens limit."
                return "completed"

            assistant: dict[str, Any] = {"role": "assistant", "content": response.text,
                                         "tool_calls": [call.message() for call in calls]}
            if response.reasoning:
                assistant["reasoning_content"] = response.reasoning
            messages.append(assistant)
            messages.extend(await self.run_calls(calls))
            if self.env.stop.is_set():
                return "stopped"

    async def run_calls(self, calls: list) -> list[dict[str, Any]]:
        """Every call gets a result, in order. Consecutive spawn_subagent calls run at the same time."""
        results: list[dict[str, Any]] = []
        index = 0
        while index < len(calls):
            if calls[index].name == "spawn_subagent" and "spawn_subagent" in self.specs:
                end = index
                while end < len(calls) and calls[end].name == "spawn_subagent":
                    end += 1
                results.extend(await asyncio.gather(*(self.run_call(call) for call in calls[index:end])))
                index = end
            else:
                results.append(await self.run_call(calls[index]))
                index += 1
        return results

    async def run_call(self, call) -> dict[str, Any]:
        self.usage["tool_calls"] += 1
        await self.event({"type": "tool_start", "id": call.id, "name": call.name, "args": call.arguments})
        started = time.monotonic()
        spec = self.specs.get(call.name)
        if self.env.stop.is_set():
            result = ToolResult(STOPPED_TOOL, ok=False, summary="stopped")
        elif call.error:
            result = ToolResult(f"Invalid call: {call.error}. Call {call.name} again with a JSON object.", ok=False,
                                summary="invalid arguments")
        elif spec is None and call.name in TOOLS:
            result = ToolResult(f"Error: {call.name} is turned off by the user. Do not call it again; answer "
                                "without it, and tell the user if they need to turn it on.", ok=False,
                                summary="turned off")
        elif spec is None:
            names = ", ".join(self.specs) or "none"
            result = ToolResult(f"Error: there is no tool named {call.name!r}. The tools are: {names}.", ok=False,
                                summary="unknown tool")
        else:
            result = await self._guarded(spec, call)
        await self.event({"type": "tool_end", "id": call.id, "name": call.name, "ok": result.ok,
                          "summary": result.summary,
                          "output": truncate_middle(result.content, MAX_TOOL_OUTPUT_SHOWN),
                          "duration_ms": int((time.monotonic() - started) * 1000)})
        if result.ok and result.placeholder and not self.env.stop.is_set():
            await self.emit_placeholder(result.placeholder)
        return {"role": "tool", "tool_call_id": call.id, "content": truncate_middle(result.content, MAX_TOOL_RESULT)}

    async def _guarded(self, spec: ToolSpec, call) -> ToolResult:
        """Run a tool; a stop cancels it."""
        ctx = ToolContext(
            chat_id=self.env.chat_id, message_id=self.env.message_id, call_id=call.id, workdir=self.env.workdir,
            emit=self.event, stop=self.env.stop, permissions=self.env.permissions, db=self.env.db,
            llm=self.env.llm, show_browser=self.env.show_browser, depth=self.depth, active_tools=list(self.specs),
            run_subagent=self.run_subagent if self.depth == 0 else None)
        task = asyncio.ensure_future(spec.run(ctx, call.arguments))
        stopper = asyncio.ensure_future(self.env.stop.wait())
        done, _ = await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
        stopper.cancel()
        if task not in done:
            task.cancel()
            try:
                await task
            except BaseException:  # noqa: BLE001 - the tool's own cancellation or failure
                pass
            return ToolResult(STOPPED_TOOL, ok=False, summary="stopped")
        try:
            return task.result()
        except ToolError as exc:
            return ToolResult(f"Error: {exc}", ok=False, summary=str(exc)[:140])
        except Exception as exc:  # noqa: BLE001 - any tool bug becomes a result the model can work around
            log.exception("tool %s failed", spec.name)
            return ToolResult(f"Error: the tool failed ({exc.__class__.__name__}: {exc})", ok=False,
                              summary=f"failed: {exc.__class__.__name__}")

    # ------------------------------------------------------------------ subagents

    async def run_subagent(self, ctx: ToolContext, name: str, task: str, groups: list[str] | None) -> str:
        allowed = [g for g in self.groups if g not in SUBAGENT_GROUPS_EXCLUDED]
        if groups:
            allowed = [g for g in allowed if g in groups]

        async def relay(event: dict[str, Any]) -> None:
            kind = event.get("type")
            if kind == "tool_start":
                await ctx.progress(f"{event['name']} · {short_args(event.get('args') or {})}")
            elif kind == "tool_end":
                mark = "done" if event.get("ok") else "failed"
                await ctx.progress(f"{event['name']} {mark}" + (f" · {event['summary']}" if event.get("summary") else ""))
            elif kind in ("permission", "permission_resolved"):
                # the prompt shows on the spawn_subagent card, the call the user can see
                await self.event({**event, "tool_call_id": ctx.call_id})

        sub = Agent(self.env, allowed, relay, depth=1, system_prompt=SUBAGENT_GUIDE,
                    max_steps=min(self.env.max_steps, SUBAGENT_MAX_STEPS))
        await ctx.progress(f"Started with tools: {', '.join(sub.specs) or 'none'}")
        messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
        status = await sub.run(messages)
        for key in ("prompt_tokens", "completion_tokens", "steps", "tool_calls"):
            self.usage[key] += sub.usage[key]
        final = messages[-1]["content"].strip() if messages[-1]["role"] == "assistant" else ""
        if status == "failed":
            raise ToolError(f"the subagent failed: {sub.error}")
        if status == "stopped":
            return (final + "\n\n" if final else "") + "[Stopped before the subagent finished.]"
        return final or "The subagent finished without writing a report."


def close_open_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every tool call needs a result and the turn must end with the assistant, or the next
    request is malformed. A stopped or crashed turn can leave either undone."""
    out: list[dict[str, Any]] = []
    answered = {m.get("tool_call_id") for m in messages if m["role"] == "tool"}
    missing: list[str] = []

    def flush_missing() -> None:
        out.extend({"role": "tool", "tool_call_id": call_id, "content": "Not run: the turn was stopped."}
                   for call_id in missing)
        missing.clear()

    for message in messages:
        if message["role"] != "tool":
            flush_missing()
        out.append(message)
        if message["role"] == "assistant":
            missing.extend(call["id"] for call in message.get("tool_calls") or [] if call["id"] not in answered)
    flush_missing()
    if out and out[-1]["role"] == "tool":
        out.append({"role": "assistant", "content": "(Stopped before answering.)"})
    return out


async def run_turn(env: RunEnv, groups: list[str], system_prompt: str, history: list[dict[str, Any]],
                   user_message: dict[str, Any], emit: Emit) -> dict[str, Any]:
    """One user message: runs the agent and stores the answer. Returns the done event."""
    agent = Agent(env, groups, emit, system_prompt=system_prompt)
    messages = [*history, user_message]
    start = len(messages)
    try:
        status = await agent.run(messages)
    except Exception as exc:  # noqa: BLE001 - the answer so far is still stored
        log.exception("agent turn failed")
        status, agent.error = "failed", f"{exc.__class__.__name__}: {exc}"
    if status == "failed":
        await emit({"type": "error", "message": agent.error or "The agent failed."})
    finalize(agent.parts)
    notice = agent.error if status == "failed" else agent.notice
    new_messages = close_open_calls(messages[start:]) if messages[start:] else []
    for message in new_messages:
        message.pop("reasoning_content", None)
    env.db.finish_message(env.message_id, content=agent.content, parts=agent.parts, llm=new_messages,
                          status=status, notice=notice)
    return {"type": "done", "message_id": env.message_id, "status": status, "notice": notice, "usage": agent.usage}
