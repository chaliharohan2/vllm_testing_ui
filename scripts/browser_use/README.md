# Browser-use + Qwen (vLLM) experiment

**Branch:** `experiment/browser-use-qwen` — throwaway. If this doesn't pan
out, just delete the branch; nothing outside this folder (plus two
`.gitignore` lines) was touched.

## What this is

A quick test of whether the [`browser-use`](https://github.com/browser-use/browser-use)
agent framework (MIT licensed, open source) can drive a real browser using
the Qwen model already running on the `192.168.0.147` vLLM server, instead of
OpenAI/Anthropic/Gemini.

`browser-use` + [`playwright`](https://playwright.dev/) (Apache-2.0, used only
to fetch a standalone Chromium binary) are the only two "SDKs" involved, both
free/open source — no paid browser-use cloud, no API keys.

## How it talks to the model

`browser-use`'s agent loop does **not** use vLLM's OpenAI-style `tools` /
function-calling API. Instead, on every step it sends a chat completion
request with a strict JSON-schema `response_format` (the `AgentOutput`
schema: next action + reasoning) and parses the JSON back out of
`message.content`. This was verified directly against the server with a raw
`curl`-style request before writing any agent code — vLLM returned valid,
schema-conforming JSON in `content`, with Qwen's thinking trace cleanly
separated out into the `reasoning` field (thanks to `--reasoning-parser
qwen3`), so no server-side changes were needed for this to work.

Separately, plain OpenAI-style `tools` + `tool_choice` was also tested and
works correctly (`--enable-auto-tool-choice --tool-call-parser qwen3_xml`
does its job) — not used by this particular script, but confirms the current
server flags are good for *either* approach if a future iteration wants
real function-calling instead of structured output.

**No server config changes requested.** The current launch command works for
this experiment as-is:

```
vllm serve cyankiwi/Qwen3.8-27B-AWQ-INT4 --port 8000 \
    --max-model-len 170000 --gpu-memory-utilization 0.90 \
    --max-num-seqs 200 --reasoning-parser qwen3 --enable-prefix-caching \
    --enable-auto-tool-choice --tool-call-parser qwen3_xml
```

If your server has no `--api-key` set, nothing extra is needed — a
placeholder is sent only because the OpenAI Python client refuses to
initialize with `api_key=None`. If your server *does* require a key (e.g. a
different box than `192.168.0.147`), the agent picks one up the same way the
chat already does: whatever is typed into the Settings panel's **API key**
field is sent with each browser-agent request, falling back to
`VLLM_API_KEY` in `.env`, then the placeholder. From the CLI, pass
`--api-key` instead.

One thing worth knowing if you change the model: `use_vision=False` is
hard-set in `run_agent.py` because `cyankiwi/Qwen3.8-27B-AWQ-INT4` has no
vision encoder, so the agent is driven off the page's DOM/text
representation rather than screenshots. If you swap in a VL variant, flip
that to `True` to let it look at screenshots too.

## Setup

```bash
source .venv/bin/activate
pip install -r scripts/browser_use/requirements.txt
playwright install chromium   # one-time, ~190MB, downloads a standalone Chromium
                               # (no system Chrome/chromium-browser package needed)
```

`VLLM_BASE_URL` is read from the repo's `.env` (same variable the React UI
uses), so it already points at the right server.

## Using it from the chat

The agent server (`agent_server/`) exposes this agent as the **Browser** tool
(`browse_web`). Turn it on with the tool chips above the composer; the chat
model decides when to hand a task to it, and each browser step shows up as
progress on the tool card. **Show window** opens a visible Chromium window
instead of running headless. Stop cancels the run.

Only one browser task runs at a time.

The standalone script below is the same agent without the chat UI.

## Running it from the terminal

```bash
python scripts/browser_use/run_agent.py
```

With a custom task and a visible browser window (useful the first time, to
watch what it's doing):

```bash
python scripts/browser_use/run_agent.py \
    "search for the vLLM project on GitHub and tell me its star count" \
    --headful
```

Flags: `--model <id>` (defaults to the model above), `--max-steps <n>`
(defaults to 15), `--headful` (default is headless).

## What was actually verified (in a sandboxed dev environment without
general internet DNS access)

- Raw OpenAI-style `tools` function calling against the server → correct
  `tool_calls` response.
- Raw strict `response_format: json_schema` request against the server →
  correct, schema-conforming JSON in `content`, reasoning kept separate.
- Full `browser-use` `Agent.run()` loop: launched a real (sandboxed,
  `chromium_sandbox=False`) headless Chromium, navigated to a URL, read the
  page, reasoned over two steps via the Qwen/vLLM backend, and returned a
  correct final answer with `success=True`.

Browsing arbitrary public sites (Wikipedia, GitHub, etc.) wasn't exercised
end-to-end in that sandbox because its network is DNS-restricted to package
registries — that part should "just work" when you run it from a machine
with normal internet access, but it's worth trying a `--headful` run first
to watch for anything unexpected.

## Known rough edges

- Startup can take a little while (browser process launch + the model
  reasoning through steps) — not a bug, just expect it, especially with
  `enable_thinking` effectively on by default for Qwen3.
- `.browseruse/` (created next to the repo root) holds browser-use's config
  and browser profile for this experiment; it's git-ignored and safe to
  delete any time (`rm -rf .browseruse`).
