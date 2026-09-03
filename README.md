# vLLM Chat Frontend

A small React playground for testing models exposed through vLLM's
OpenAI-compatible API. Responses stream as they are generated and are rendered
as Markdown with LaTeX math, images and PDFs can be attached to a prompt, and
the full conversation is sent with each follow-up message.

## Setup

Requirements:

- Node.js 22.12+ (the dev server runs on 20.19+, but `jsdom` in the test suite
  needs 22+)
- A running vLLM OpenAI-compatible server

Install dependencies:

```bash
npm install
```

Copy the environment example and point it at the vLLM server:

```bash
cp .env.example .env
```

```dotenv
VLLM_BASE_URL=http://localhost:8000
```

Start the frontend:

```bash
npm run dev
```

This workspace also has a git-ignored local Node runtime, because the host's
Node is older than the test suite needs. On this machine, either export
`PATH="$PWD/.node/bin:$PATH"` once or prefix the npm commands with that value.

Vite proxies `/v1` requests to `VLLM_BASE_URL`, which avoids browser CORS
configuration during development. Restart the dev server after changing the
URL.

The API key field in the settings panel is optional. When it is filled in, the
key is sent as `Authorization: Bearer <key>` on model listing and chat
requests; when it is empty, no `Authorization` header is sent, which is what a
server started without `--api-key` expects. The key can be changed at any time
and is kept in browser memory only.

## Usage

- Select a model from `/v1/models` or type a model ID; add an API key only if the server requires one.
- Configure the system prompt and vLLM sampling values in the settings panel.
- Assistant replies render Markdown, including tables, lists, code blocks with a copy button, and LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`).
- Attach images and PDFs with the paperclip, by pasting, or by dropping them on the composer.
- Send a message with Enter; use Shift + Enter for a line break.
- Stop cancels the current HTTP request and keeps any text already streamed.
- New chat aborts active generation and clears all in-memory context.
- Refreshing or closing the page clears the chat and settings.

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
```
