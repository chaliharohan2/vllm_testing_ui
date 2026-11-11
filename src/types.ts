export type ChatRole = 'user' | 'assistant'

export interface Attachment {
  id: string
  name: string
  /** A base64 data URL; PDF pages are rasterised to JPEG before they get here. */
  dataUrl: string
}

export interface PermissionRequest {
  request_id: string
  command: string
  reason: string
  state: 'pending' | 'approved' | 'denied'
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool'
      id: string
      name: string
      args: Record<string, unknown>
      status: 'running' | 'done' | 'error'
      summary: string
      output: string
      progress: string[]
      permission?: PermissionRequest
    }

export type ToolPart = Extract<MessagePart, { type: 'tool' }>

export interface ChatMessage {
  id: string
  role: ChatRole
  /** User text, or the assistant's answer markdown with artifact placeholders. */
  content: string
  attachments?: Attachment[]
  /** What an assistant turn shows, in order: reasoning, text and tool cards. */
  parts?: MessagePart[]
  status?: string
  notice?: string
}

export interface GenerationSettings {
  apiKey: string
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
  topP: number
  topK: number
  minP: number
  seed: string
  stop: string
  repetitionPenalty: number
  enableThinking: boolean
  /** Absolute path the file and terminal tools work in; empty uses the server default. */
  workdir: string
  maxSteps: number
}

export interface ToolGroup {
  id: string
  label: string
  description: string
  tools: string[]
}

export interface ChatSummary {
  id: string
  title: string
  created_at: number
  updated_at: number
}

export interface ChatSettings {
  tools?: string[]
  workdir?: string
  showBrowser?: boolean
  maxSteps?: number
}

export interface Artifact {
  id: string
  chat_id: string
  kind: 'markdown' | 'code' | 'html' | 'svg' | 'mermaid' | 'text'
  language: string
  title: string
  content: string
  version: number
  latest_version: number
}

export type AgentEvent =
  | { type: 'start'; chat_id: string; title: string; message_id: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_progress'; id: string; message: string }
  | {
      type: 'tool_end'
      id: string
      name: string
      ok: boolean
      summary: string
      output: string
      duration_ms: number
    }
  | {
      type: 'permission'
      request_id: string
      tool_call_id: string
      kind: string
      command: string
      reason: string
    }
  | {
      type: 'permission_resolved'
      request_id: string
      tool_call_id: string
      approved: boolean
    }
  | {
      type: 'done'
      message_id: string
      status: string
      notice: string
      usage: Record<string, number>
    }
  | { type: 'error'; message: string }

export interface ModelInfo {
  id: string
}

export interface ModelsResponse {
  data: ModelInfo[]
}
