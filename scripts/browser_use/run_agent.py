#!/usr/bin/env python3
"""Experiment: drive a real browser with the `browser-use` agent framework,
powered by the self-hosted Qwen model behind this project's vLLM server.

This lives on the throwaway branch `experiment/browser-use-qwen` -- the goal
is just to answer "does tool/structured-output calling work well enough for
browser automation with this model + this vLLM config". If it doesn't pan
out, delete the branch and nothing outside it is affected.

What this talks to:
  - vLLM server (read from VLLM_BASE_URL in .env, e.g. http://192.168.0.147:8000)
    started with:
      vllm serve cyankiwi/Qwen3.8-27B-AWQ-INT4 --port 8000 \
        --max-model-len 170000 --gpu-memory-utilization 0.90 \
        --max-num-seqs 200 --reasoning-parser qwen3 --enable-prefix-caching \
        --enable-auto-tool-choice --tool-call-parser qwen3_xml
    No API key is sent -- the server wasn't started with --api-key, and this
    harness doesn't rely on vLLM's OpenAI "tools" function-calling API at all
    (browser-use instead asks for a strict JSON-schema structured response,
    which this vLLM build already handles fine -- see README.md in this
    folder for how that was verified).
  - A standalone Chromium that *you* run locally, downloaded on-demand by
    Playwright. No system Chrome/Chromium package is required.

Usage:
    source .venv/bin/activate
    pip install -r scripts/browser_use/requirements.txt
    playwright install chromium        # one-time, ~190MB download

    python scripts/browser_use/run_agent.py
    python scripts/browser_use/run_agent.py "search for the vLLM project on GitHub and tell me its star count" --headful
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Keep every file this experiment writes (config, browser profile, logs)
# inside the repo/branch instead of ~/.config or ~/.cache, so discarding the
# branch leaves no trace on the machine.
os.environ.setdefault("BROWSER_USE_CONFIG_DIR", str(REPO_ROOT / ".browseruse"))
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_VERSION_CHECK", "false")

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")

from browser_use import Agent, BrowserProfile, BrowserSession  # noqa: E402
from browser_use.llm import ChatOpenAI  # noqa: E402

DEFAULT_MODEL = "cyankiwi/Qwen3.8-27B-AWQ-INT4"
DEFAULT_TASK = (
    "Go to https://en.wikipedia.org/wiki/Special:Random, open whatever "
    "article you land on, and tell me its title and a one-sentence summary."
)


def vllm_base_url() -> str:
    """Mirrors src/api/vllm.ts: read the same VLLM_BASE_URL used by the UI."""
    base = os.environ.get("VLLM_BASE_URL", "http://localhost:8000").rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def _playwright_chromium() -> str | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    try:
        with sync_playwright() as playwright:
            path = playwright.chromium.executable_path
            return path if path and Path(path).exists() else None
    except Exception:
        return None


def find_chromium_executable() -> str | None:
    """Locate the standalone Chromium binary from `playwright install chromium`.

    browser-use's own browser harness (CDP-based, no Playwright dependency at
    runtime) expects to find a system Chrome/Chromium -- it doesn't download
    one itself. We reuse Playwright purely as an installer/locator for a
    sandboxed Chromium build so no system package install is needed.

    A leftover PLAYWRIGHT_BROWSERS_PATH (some sandboxes set one) would hide
    the copy installed into the normal ~/.cache/ms-playwright directory, so
    fall back to that default location when the override does not contain a
    browser.
    """
    found = _playwright_chromium()
    if found or not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        return found
    os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
    return _playwright_chromium()


def vllm_api_key(override: str | None = None) -> str:
    """Pick an API key the same way src/api/vllm.ts does: prefer whatever was
    typed into the chat's Settings panel (passed through from the UI), then
    fall back to VLLM_API_KEY from .env, then a placeholder.

    The OpenAI client library refuses to start with api_key=None, so a
    placeholder is used for servers that don't check it (started without
    --api-key) -- but a server that *does* check it (like 103.48.50.161)
    needs the real key or every request comes back 401.
    """
    key = (override or "").strip() or os.environ.get("VLLM_API_KEY", "").strip()
    return key or "not-needed"


def build_llm(model: str, api_key: str | None = None) -> ChatOpenAI:
    return ChatOpenAI(
        model=model,
        base_url=vllm_base_url(),
        api_key=vllm_api_key(api_key),
        temperature=0.3,
        max_completion_tokens=4096,
    )


def build_browser_session(executable_path: str, headless: bool | None) -> BrowserSession:
    return BrowserSession(
        browser_profile=BrowserProfile(
            executable_path=executable_path,
            headless=headless,
            # Fresh, throwaway profile every run -- no cookies/history kept.
            user_data_dir=None,
            # Chrome's own setuid sandbox needs user-namespace privileges that
            # containers/CI sandboxes often don't grant, which makes the
            # browser process exit immediately with no clear error. Disabling
            # it is the standard workaround for Docker/dev-sandbox use (same
            # as Chrome's own --no-sandbox guidance); this script is only for
            # local experimentation, never for browsing untrusted content.
            chromium_sandbox=False,
            # Skip downloading browser-use's bundled ad-block/cookie-consent
            # extensions -- nice for real use, unnecessary network dependency
            # and startup delay for this experiment.
            enable_default_extensions=False,
        )
    )


def build_agent(
    task: str,
    model: str,
    executable_path: str,
    headless: bool | None,
    api_key: str | None = None,
    **agent_kwargs: object,
) -> Agent:
    return Agent(
        task=task,
        llm=build_llm(model, api_key),
        browser_session=build_browser_session(executable_path, headless),
        # cyankiwi/Qwen3.8-27B-AWQ-INT4 is a text-only build (no vision
        # encoder), so drive the agent off the DOM/text page representation
        # instead of sending it screenshots it can't actually see.
        use_vision=False,
        **agent_kwargs,
    )


async def run(
    task: str,
    model: str,
    executable_path: str,
    headless: bool | None,
    max_steps: int,
    api_key: str | None = None,
) -> int:
    llm = build_llm(model, api_key)
    print(f"-> vLLM endpoint : {llm.base_url}")
    print(f"-> Model         : {llm.model}")
    print(f"-> Chromium      : {executable_path}")
    print(f"-> Task          : {task}\n")

    agent = build_agent(task, model, executable_path, headless, api_key)

    history = await agent.run(max_steps=max_steps)

    print("\n=== Final result ===")
    print(history.final_result())
    print(f"\n({len(history.history)} step(s), success={history.is_successful()})")
    return 0 if history.is_successful() else 2


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", nargs="?", default=DEFAULT_TASK, help="Natural-language task for the agent.")
    parser.add_argument("--model", default=os.environ.get("VLLM_MODEL", DEFAULT_MODEL))
    parser.add_argument(
        "--api-key",
        default=None,
        help="Overrides VLLM_API_KEY from .env for servers that require one.",
    )
    parser.add_argument("--max-steps", type=int, default=15)
    parser.add_argument(
        "--headful",
        dest="headless",
        action="store_false",
        default=None,
        help="Show the browser window instead of running headless.",
    )
    args = parser.parse_args()

    # Resolved here, in a plain sync context: Playwright's sync API (used only
    # to *locate* the Chromium binary it downloaded) refuses to run inside an
    # active asyncio event loop, which `run()` below has one of.
    executable_path = find_chromium_executable()
    if executable_path is None:
        print(
            "No Chromium binary found. Run this first:\n  playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(1)

    exit_code = asyncio.run(
        run(args.task, args.model, executable_path, args.headless, args.max_steps, args.api_key)
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
