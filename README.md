# vLLM Chat Frontend

A small React playground for testing models exposed through vLLM's
OpenAI-compatible API. Responses stream as they are generated, and the full
conversation is sent with each follow-up message.

## Setup

Requirements:

- Node.js 20.19+ or 22.12+
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

This workspace also has a git-ignored local Node runtime because the host did
not have Node installed. On this machine, either export
`PATH="$PWD/.node/bin:$PATH"` once or prefix the npm commands with that value.

Vite proxies `/v1` requests to `VLLM_BASE_URL`, which avoids browser CORS
configuration during development. Restart the dev server after changing the
URL.

Enter the vLLM API key in the settings panel. It is sent as
`Authorization: Bearer <key>` on model listing and chat requests, can be
changed at any time, and is kept in browser memory only.

## Usage

- Enter the vLLM API key, then select a model from `/v1/models` or type a model ID.
- Configure the system prompt and vLLM sampling values in the settings panel.
- Send a message with Enter; use Shift + Enter for a line break.
- Stop cancels the current HTTP request and keeps any text already streamed.
- New chat aborts active generation and clears all in-memory context.
- Refreshing or closing the page clears the chat and settings.

## Checks

```bash
npm run lint
npm test
npm run build
```
