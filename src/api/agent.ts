import type {
  AgentEvent,
  Artifact,
  Attachment,
  ChatMessage,
  ChatSettings,
  ChatSummary,
  GenerationSettings,
  ToolGroup,
} from '../types'

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || response.statusText
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await errorMessage(response))
  return (await response.json()) as T
}

const postJson = (url: string, body: unknown) =>
  getJson<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

export interface ToolsInfo {
  groups: ToolGroup[]
  chromium: boolean
}

export const fetchTools = (signal?: AbortSignal) =>
  getJson<ToolsInfo>('/api/tools', { signal })

export const fetchChats = async (signal?: AbortSignal) =>
  (await getJson<{ chats: ChatSummary[] }>('/api/chats', { signal })).chats

export interface LoadedChat {
  chat: ChatSummary & { settings: ChatSettings }
  messages: ChatMessage[]
  running: boolean
}

export const fetchChat = (chatId: string, signal?: AbortSignal) =>
  getJson<LoadedChat>(`/api/chats/${encodeURIComponent(chatId)}`, { signal })

export const deleteChat = (chatId: string) =>
  getJson<{ ok: boolean }>(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
  })

export const stopChat = (chatId: string) =>
  postJson(`/api/chats/${encodeURIComponent(chatId)}/stop`, {})

export const answerPermission = (
  requestId: string,
  approve: boolean,
  password?: string,
) =>
  postJson(`/api/permissions/${encodeURIComponent(requestId)}`, {
    approve,
    ...(password ? { password } : {}),
  })

const artifactCache = new Map<string, Promise<Artifact>>()

/** Placeholders load their artifact by id; each version is fetched once. */
export const fetchArtifact = (id: string, version?: number) => {
  const key = `${id}/${version ?? 'latest'}`
  let pending = artifactCache.get(key)
  if (!pending) {
    pending = getJson<Artifact>(
      `/api/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`,
    )
    pending.catch(() => artifactCache.delete(key))
    artifactCache.set(key, pending)
  }
  return pending
}

export interface AgentTurnRequest {
  chatId: string | null
  content: string
  attachments: Attachment[]
  settings: GenerationSettings
  tools: string[]
  showBrowser: boolean
}

interface StreamTurnOptions extends AgentTurnRequest {
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

const parseEvent = (raw: string): AgentEvent | null => {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return data ? (JSON.parse(data) as AgentEvent) : null
}

export const streamAgentTurn = async ({
  chatId,
  content,
  attachments,
  settings,
  tools,
  showBrowser,
  signal,
  onEvent,
}: StreamTurnOptions): Promise<void> => {
  const { workdir, maxSteps, ...generation } = settings
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId,
      message: { content, attachments },
      settings: generation,
      tools,
      workdir: workdir.trim() || undefined,
      maxSteps,
      showBrowser,
    }),
    signal,
  })
  if (!response.ok) throw new Error(await errorMessage(response))
  if (!response.body) throw new Error('The agent server did not return a stream.')

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
        if (event) onEvent(event)
        separator = /\r?\n\r?\n/.exec(buffer)
      }
      if (done) break
    }
    const rest = parseEvent(buffer)
    if (rest) onEvent(rest)
  } finally {
    reader.releaseLock()
  }
}
