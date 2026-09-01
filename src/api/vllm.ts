import type {
  ChatCompletionRequest,
  ChatMessage,
  GenerationSettings,
  ModelsResponse,
  StreamEvents,
} from '../types'

export const headersFor = (apiKey: string): HeadersInit => {
  const token = apiKey.trim()
  if (!token) {
    throw new Error('An API key is required')
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {
      error?: { message?: string }
      message?: string
    }
    return body.error?.message || body.message || response.statusText
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

export const fetchModels = async (
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const response = await fetch('/v1/models', {
    headers: headersFor(apiKey),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Could not load models: ${await errorMessage(response)}`)
  }

  const payload = (await response.json()) as ModelsResponse
  return payload.data.map(({ id }) => id).filter(Boolean).sort()
}

export const buildChatRequest = (
  messages: ChatMessage[],
  settings: GenerationSettings,
): ChatCompletionRequest => {
  const stop = settings.stop
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  const seed = settings.seed.trim()

  return {
    model: settings.model.trim(),
    messages: [
      ...(settings.systemPrompt.trim()
        ? [{ role: 'system' as const, content: settings.systemPrompt.trim() }]
        : []),
      // A turn that produced no visible text would otherwise be replayed as an
      // empty assistant message, which degrades the model's next answer.
      ...messages
        .filter(({ content }) => content.trim())
        .map(({ role, content }) => ({ role, content })),
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    top_p: settings.topP,
    top_k: settings.topK,
    min_p: settings.minP,
    repetition_penalty: settings.repetitionPenalty,
    ...(seed ? { seed: Number.parseInt(seed, 10) } : {}),
    ...(stop.length ? { stop } : {}),
    ...(settings.enableThinking
      ? {}
      : { chat_template_kwargs: { enable_thinking: false } }),
  }
}

interface StreamDelta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
}

const dispatchSseEvent = (event: string, events: StreamEvents): boolean => {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

  if (!data) return false
  if (data.trim() === '[DONE]') return true

  const payload = JSON.parse(data) as {
    choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>
    error?: { message?: string }
  }

  if (payload.error) {
    throw new Error(payload.error.message || 'vLLM returned a streaming error')
  }

  const choice = payload.choices?.[0]
  if (!choice) return false

  const { content, reasoning, reasoning_content: reasoningContent } =
    choice.delta ?? {}

  if (content) events.onContent(content)

  // Reasoning models stream thinking tokens separately; vLLM has used both
  // `reasoning` and `reasoning_content` depending on the version.
  const thinking = reasoning ?? reasoningContent
  if (thinking) events.onReasoning(thinking)

  if (choice.finish_reason) events.onFinish(choice.finish_reason)
  return false
}

export const consumeSseStream = async (
  stream: ReadableStream<Uint8Array>,
  events: StreamEvents,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent = false

  try {
    while (!doneEvent) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator) {
        const event = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        doneEvent = dispatchSseEvent(event, events)
        if (doneEvent) break
        separator = /\r?\n\r?\n/.exec(buffer)
      }

      if (done || doneEvent) break
    }

    if (!doneEvent && buffer.trim()) {
      dispatchSseEvent(buffer, events)
    }
  } finally {
    reader.releaseLock()
  }
}

interface StreamChatOptions extends StreamEvents {
  messages: ChatMessage[]
  settings: GenerationSettings
  signal: AbortSignal
}

export const streamChat = async ({
  messages,
  settings,
  signal,
  onContent,
  onReasoning,
  onFinish,
}: StreamChatOptions): Promise<void> => {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: headersFor(settings.apiKey),
    body: JSON.stringify(buildChatRequest(messages, settings)),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Generation failed: ${await errorMessage(response)}`)
  }
  if (!response.body) {
    throw new Error('The vLLM response did not include a readable stream')
  }

  await consumeSseStream(response.body, { onContent, onReasoning, onFinish })
}
