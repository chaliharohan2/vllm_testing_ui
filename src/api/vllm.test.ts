import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, GenerationSettings, StreamEvents } from '../types'
import {
  buildChatRequest,
  consumeSseStream,
  fetchModels,
  headersFor,
  streamChat,
} from './vllm'

const settings: GenerationSettings = {
  apiKey: '',
  model: 'example/model',
  systemPrompt: 'Be concise.',
  temperature: 0.4,
  maxTokens: 512,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  seed: '7',
  stop: 'END\nSTOP',
  repetitionPenalty: 1.1,
  enableThinking: true,
}

const streamOf = (...parts: string[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(encoder.encode(part)))
      controller.close()
    },
  })
}

const recordingEvents = (): StreamEvents & {
  content: string[]
  reasoning: string[]
  finished: string[]
} => {
  const content: string[] = []
  const reasoning: string[] = []
  const finished: string[] = []

  return {
    content,
    reasoning,
    finished,
    onContent: (text) => content.push(text),
    onReasoning: (text) => reasoning.push(text),
    onFinish: (reason) => finished.push(reason),
  }
}

describe('buildChatRequest', () => {
  it('includes system prompt, conversation context, and sampling values', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Question' },
      { id: '2', role: 'assistant', content: 'Answer' },
    ]

    expect(buildChatRequest(messages, settings)).toEqual({
      model: 'example/model',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.4,
      max_tokens: 512,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.1,
      seed: 7,
      stop: ['END', 'STOP'],
    })
  })

  it('drops assistant turns that produced no visible answer', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Question' },
      { id: '2', role: 'assistant', content: '', reasoning: 'thinking' },
      { id: '3', role: 'user', content: 'Follow-up' },
    ]

    expect(buildChatRequest(messages, settings).messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Question' },
      { role: 'user', content: 'Follow-up' },
    ])
  })

  it('sends attachments as image parts alongside the prompt text', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'What is in this?',
        attachments: [
          { id: 'a', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' },
          { id: 'b', name: 'doc.pdf · page 1', dataUrl: 'data:image/jpeg;base64,BBB' },
        ],
      },
    ]

    expect(buildChatRequest(messages, settings).messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
      ],
    })
  })

  it('keeps an image-only turn that carries no text', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: '',
        attachments: [
          { id: 'a', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' },
        ],
      },
    ]

    expect(buildChatRequest(messages, settings).messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    })
  })

  it('leaves plain turns as string content', () => {
    const messages: ChatMessage[] = [{ id: '1', role: 'user', content: 'Hi' }]

    expect(buildChatRequest(messages, settings).messages[1]).toEqual({
      role: 'user',
      content: 'Hi',
    })
  })

  it('disables thinking mode through chat template kwargs', () => {
    const request = buildChatRequest([], {
      ...settings,
      enableThinking: false,
    })

    expect(request.chat_template_kwargs).toEqual({ enable_thinking: false })
  })
})

describe('headersFor', () => {
  it('sends the API key as a Bearer token', () => {
    expect(headersFor('  secret-key  ')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret-key',
    })
  })

  it('omits the header when the server runs without a key', () => {
    expect(headersFor('   ')).toEqual({ 'Content-Type': 'application/json' })
  })
})

describe('fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authorizes model discovery with the current API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchModels('live-key')).resolves.toEqual(['model-a'])
    expect(fetchMock).toHaveBeenCalledWith('/v1/models', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer live-key',
      },
      signal: undefined,
    })
  })
})

describe('streamChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authorizes chat completions with the current API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: streamOf('data: [DONE]\n\n'),
    })
    vi.stubGlobal('fetch', fetchMock)

    await streamChat({
      messages: [{ id: '1', role: 'user', content: 'Hi' }],
      settings: { ...settings, apiKey: 'live-key' },
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onReasoning: vi.fn(),
      onFinish: vi.fn(),
    })

    expect(fetchMock.mock.calls[0][0]).toBe('/v1/chat/completions')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer live-key',
    })
  })
})

describe('consumeSseStream', () => {
  it('parses deltas split across transport chunks', async () => {
    const events = recordingEvents()

    await consumeSseStream(
      streamOf(
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ),
      events,
    )

    expect(events.content).toEqual(['Hello', ' world'])
  })

  it('reports reasoning tokens separately from answer content', async () => {
    const events = recordingEvents()

    await consumeSseStream(
      streamOf(
        'data: {"choices":[{"delta":{"reasoning":"step one"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" step two"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"4"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      events,
    )

    expect(events.reasoning).toEqual(['step one', ' step two'])
    expect(events.content).toEqual(['4'])
    expect(events.finished).toEqual(['stop'])
  })

  it('reports a truncated generation that never produced content', async () => {
    const events = recordingEvents()

    await consumeSseStream(
      streamOf(
        'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ),
      events,
    )

    expect(events.content).toEqual([])
    expect(events.finished).toEqual(['length'])
  })
})
