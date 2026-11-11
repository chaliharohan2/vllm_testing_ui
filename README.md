# vLLM Chat Frontend

A React chat UI for models exposed through vLLM's OpenAI-compatible API, backed
by a small Python agent server. Responses stream as they are generated and are
rendered as Markdown with LaTeX math, images and PDFs can be attached to a
prompt, and the model can use tools: files, a terminal, web search and fetch, a
browser, artifacts and subagents. Chats and artifacts are saved in SQLite.

## Setup

Requirements:

- Node.js 22.12+ (the dev server runs on 20.19+, but `jsdom` in the test suite
  needs 22+)
- A running vLLM OpenAI-compatible server

Install dependencies:

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r agent_server/requirements.txt
```

The browser tool also needs `scripts/browser_use/requirements.txt` and a
one-time `.venv/bin/playwright install chromium`; see
`scripts/browser_use/README.md`.

Copy the environment example and point it at the vLLM server:

```bash
cp .env.example .env
```

```dotenv
VLLM_BASE_URL=http://localhost:8000
# Only if the server was started with --api-key:
VLLM_API_KEY=...
```

The vLLM server needs tool calling enabled, for example
`--enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3`
for Qwen3 models.

Start the frontend:

```bash
npm run dev
```

This workspace also has a git-ignored local Node runtime, because the host's
Node is older than the test suite needs. On this machine, either export
`PATH="$PWD/.node/bin:$PATH"` once or prefix the npm commands with that value.

`npm run dev` also starts the agent server (`agent_server/app.py`) on
`127.0.0.1:8787`. Vite proxies `/api` to it and `/v1` to `VLLM_BASE_URL`, which
avoids browser CORS configuration during development. Restart the dev server
after changing `.env`.

The API key field in the settings panel is optional. When it is filled in, it
is sent as `Authorization: Bearer <key>`; when it is empty, `VLLM_API_KEY` from
`.env` is used, and if that is unset too, no `Authorization` header is sent.
The key typed in the UI is kept in browser memory only.

## Usage

- Select a model from `/v1/models` or type a model ID; add an API key only if the server requires one.
- Configure the system prompt and vLLM sampling values in the settings panel.
- Assistant replies render Markdown, including tables, lists, code blocks with a copy button, and LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`).
- Attach images and PDFs with the paperclip, by pasting, or by dropping them on the composer.
- Send a message with Enter; use Shift + Enter for a line break.
- Pick tools with the chips above the composer. The selection can change at any point in a chat.
- Stop ends the run on the server, including a running command or subagent, and keeps what was already streamed.
- Chats are listed in the sidebar and reload from `data/chats.db`.

## Tools

| Tool | What it does |
| --- | --- |
| Files | List, read, write, edit and delete files inside the working folder |
| Terminal | Run bash commands in the working folder |
| Web search | `ddgs` (or SearXNG when `SEARXNG_URL` is set), falling back to Wikipedia |
| Web fetch | Fetch a page or PDF as Markdown with `trafilatura` / `pypdf` |
| Browser | Drive Chromium with browser-use |
| Artifacts | Create, update and read documents, code, HTML, SVG and Mermaid diagrams |
| Subagents | Hand a task to a subagent; several run in parallel |

The working folder defaults to `workspace/` and can be changed in Settings. File
paths cannot leave it; terminal commands start in it but are not sandboxed.

**sudo.** A command that uses `sudo` pauses and shows a prompt in the chat. It
runs only after you click Allow and enter your password. The password is passed
through `SUDO_ASKPASS` for that one command, removed from the output, and never
saved or shown to the model. `su`, `pkexec`, `doas` and `run0` are always
refused. A script that calls sudo internally on a machine with passwordless
sudo is not caught by this check.

**Artifacts** are versioned and stored with the chat. After a successful create
or update the server inserts a placeholder link on its own line, which the UI
renders as a chip; clicking it opens the artifact panel. HTML runs in a
sandboxed iframe.

**Changing tools mid-chat.** vLLM keeps no state between requests, so each turn
sends only the selected tools. The model may still try to call a tool it saw
earlier in the conversation, so the system prompt names the tools that are off
and the server answers any such call with an error; the model then continues
without it.

Other settings: `AGENT_DB_PATH`, `AGENT_WORKDIR`, `AGENT_SERVER_PORT`,
`AGENT_SEARCH_REGION`, and `AGENT_WEB_ALLOW_PRIVATE=1` to let web fetch reach
private network addresses.

## Attachments

Images are sent as-is. PDFs never reach the server as PDFs: each page is
rasterised to a JPEG in the browser with pdf.js, and those page images are sent
instead. At most the first 8 pages are attached, and the UI says so when a
longer document is truncated.

Both are sent as OpenAI-style `image_url` content parts holding base64 data
URLs, so the served model has to be a vision model. A text-only model answers
with `At most 0 image(s) may be provided in one prompt`, which shows up in the
error banner.

`pdfjs-dist` is pinned to an exact version. Releases from 6.x on call
`Map.prototype.getOrInsertComputed`, which most current browsers do not have
yet, and PDF conversion hangs when it is missing.

## Checks

```bash
npm run lint
npm test
npm run build
.venv/bin/pytest
```
