"""Run bash commands in the working folder. sudo needs the user's approval and password."""

from __future__ import annotations

import asyncio
import os
import re
import signal
import tempfile
import time
from pathlib import Path
from typing import Any

from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj, truncate_middle

DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 1800
MAX_CAPTURE = 400_000
MAX_RESULT = 30_000
PROGRESS_EVERY = 0.7

_WORD_START = r"(?:^|[\s;&|()`{}!]|\$\()"
SUDO = re.compile(_WORD_START + r"sudo(?=$|[\s;&|)`])")
# other ways to become root: no password can be handed to them safely, so they are refused
OTHER_ELEVATION = re.compile(_WORD_START + r"(su|pkexec|doas|run0)(?=$|[\s;&|)`])")

# askpass helper: sudo -A runs it and reads the password from its stdout
ASKPASS = "#!/bin/sh\nprintf '%s\\n' \"$AGENT_SUDO_PASSWORD\"\n"


def needs_sudo(command: str) -> bool:
    return bool(SUDO.search(command))


def other_elevation(command: str) -> str | None:
    match = OTHER_ELEVATION.search(command)
    return match.group(1) if match else None


def _kill(process: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def run_bash(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ToolError("command is required")
    timeout = max(1, min(int(args.get("timeout_seconds") or DEFAULT_TIMEOUT), MAX_TIMEOUT))

    elevated = other_elevation(command)
    if elevated:
        raise ToolError(f"`{elevated}` is not allowed. If the task really needs root, use sudo: the user is "
                        "asked to approve the command and give the password.")

    env = {**os.environ, "SUDO_ASKPASS": "/bin/false", "PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb"}
    env.pop("AGENT_SUDO_PASSWORD", None)
    script = command
    password: str | None = None
    askpass_dir: tempfile.TemporaryDirectory | None = None

    if needs_sudo(command):
        approved, password = await ctx.permissions.ask(ctx.emit, ctx.stop, {
            "tool_call_id": ctx.call_id, "kind": "sudo", "command": command,
            "reason": args.get("reason") or "",
        })
        if not approved:
            return ToolResult("The user did not allow this sudo command. Do not retry it; continue without it "
                              "or ask the user what to do.", ok=False, summary="sudo denied")
        if not password:
            return ToolResult("The user approved but gave no password, so sudo was not run.", ok=False,
                              summary="no sudo password")
        askpass_dir = tempfile.TemporaryDirectory(prefix="agent-askpass-")
        helper = Path(askpass_dir.name) / "askpass.sh"
        helper.write_text(ASKPASS)
        helper.chmod(0o700)
        env.update({"SUDO_ASKPASS": str(helper), "AGENT_SUDO_PASSWORD": password})
        script = 'sudo() { command sudo -A "$@"; }\nexport -f sudo\n' + command

    ctx.workdir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        "/bin/bash", "-c", script, cwd=str(ctx.workdir), env=env,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True)
    output = bytearray()
    last_progress = 0.0
    timed_out = False

    async def pump() -> None:
        nonlocal last_progress
        assert process.stdout is not None
        while True:
            chunk = await process.stdout.read(4096)
            if not chunk:
                return
            if len(output) < MAX_CAPTURE:
                output.extend(chunk[: MAX_CAPTURE - len(output)])
            now = time.monotonic()
            if now - last_progress >= PROGRESS_EVERY:
                last_progress = now
                tail = output[-400:].decode("utf-8", errors="replace").strip().splitlines()
                if tail:
                    line = tail[-1][:200]
                    await ctx.progress(line.replace(password, "******") if password else line)

    try:
        try:
            await asyncio.wait_for(pump(), timeout=timeout)
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            timed_out = True
            _kill(process)
            await process.wait()
    except asyncio.CancelledError:
        _kill(process)
        try:
            await asyncio.wait_for(asyncio.shield(process.wait()), timeout=2)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        raise
    finally:
        if askpass_dir is not None:
            askpass_dir.cleanup()

    text = output.decode("utf-8", errors="replace")
    if password:
        text = text.replace(password, "******")
    if len(output) >= MAX_CAPTURE:
        text += "\n[output capture limit reached]"
    elapsed = time.monotonic() - started
    code = process.returncode
    status = f"Timed out after {timeout}s (process killed)" if timed_out else f"Exit code: {code}"
    body = truncate_middle(text.strip(), MAX_RESULT) if text.strip() else "(no output)"
    return ToolResult(f"{status}\n{body}", ok=not timed_out and code == 0,
                      summary=("timed out" if timed_out else f"exit {code}") + f" · {elapsed:.1f}s")


TOOLS = [
    ToolSpec(
        "run_bash", "bash",
        "Run a bash command in the working folder and get its output (stdout and stderr together) and exit "
        "code. Each call is a fresh shell: `cd` and variables do not carry over, so chain steps with && or "
        "use absolute paths. There is no terminal input: never run interactive programs (editors, pagers, "
        "prompts); pass flags like -y instead. Long-running servers must be started in the background with "
        "output redirected. Do not use sudo unless the task cannot be done without root; when you do, the "
        "user is asked to approve the command and type the password. su, pkexec and doas are not allowed.",
        obj({"command": {"type": "string", "description": "The bash command or script."},
             "timeout_seconds": {"type": "integer",
                                 "description": f"Kill the command after this many seconds (default "
                                                f"{DEFAULT_TIMEOUT}, max {MAX_TIMEOUT})."},
             "reason": {"type": "string",
                        "description": "Only for sudo commands: one sentence for the user on why root is needed."}},
            ["command"]),
        run_bash),
]
