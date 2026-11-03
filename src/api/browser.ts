import type { BrowserStep, ChatMessage } from '../types'

export type { BrowserStep }

export interface BrowserHealth {
  ok: boolean
  chromium: string | null
  busy: boolean
  vllm: string
}

interface BrowserStatusEvent {
  type: 'status'
  message: string
}

interface BrowserStepEvent extends BrowserStep {
  type: 'step'
}

interface BrowserDoneEvent {
  type: 'done'
  result: string
  success: boolean
}

interface BrowserErrorEvent {
  type: 'error'
  message: string
}

export type BrowserEvent =
  | BrowserStatusEvent
  | BrowserStepEvent
  | BrowserDoneEvent
  | BrowserErrorEvent

export const formatBrowserTask = (messages: ChatMessage[]): string => {
  const lines = messages
    .filter((message) => message.content.trim())
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.trim()}`,
    )
  const current = lines.at(-1)?.replace(/^User: /, '') ?? ''
  if (lines.length <= 1) return current
  return `Conversation so far:\n${lines.slice(0, -1).join('\n')}\n\nDo this now:\n${current}`
}

export const fetchBrowserHealth = async (
  signal?: AbortSignal,
): Promise<BrowserHealth> => {
  const response = await fetch('/browser/health', { signal })
  if (!response.ok) {
    throw new Error('The browser agent is not running.')
  }
  return (await response.json()) as BrowserHealth
}

const parseEvent = (raw: string): BrowserEvent | null => {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  return JSON.parse(data) as BrowserEvent
}

interface StreamBrowserOptions {
  task: string
  model: string
  apiKey: string
  showBrowser: boolean
  maxSteps?: number
  signal: AbortSignal
  onStatus: (message: string) => void
  onStep: (step: BrowserStep) => void
  onDone: (result: string) => void
}

export const streamBrowserTask = async ({
  task,
  model,
  apiKey,
  showBrowser,
  maxSteps = 12,
  signal,
  onStatus,
  onStep,
  onDone,
}: StreamBrowserOptions): Promise<void> => {
  const response = await fetch('/browser/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, model, apiKey, showBrowser, maxSteps }),
    signal,
  })

  if (response.status === 409) {
    throw new Error('A browser task is already running.')
  }
  if (!response.ok) {
    let message = `Browser agent failed (HTTP ${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // The body was not JSON; the status line is enough.
    }
    throw new Error(message)
  }
  if (!response.body) {
    throw new Error('The browser agent did not return a stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator) {
        const event = parseEvent(buffer.slice(0, separator.index))
        buffer = buffer.slice(separator.index + separator[0].length)
        if (event?.type === 'status') onStatus(event.message)
        if (event?.type === 'step') {
          onStep({
            step: event.step,
            url: event.url,
            evaluation: event.evaluation,
            memory: event.memory,
            goal: event.goal,
            actions: event.actions,
          })
        }
        if (event?.type === 'done') onDone(event.result)
        if (event?.type === 'error') throw new Error(event.message)
        separator = /\r?\n\r?\n/.exec(buffer)
      }

      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}
