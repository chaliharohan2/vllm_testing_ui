export type ChatRole = 'user' | 'assistant'

export interface Attachment {
  id: string
  name: string
  /** A base64 data URL; PDF pages are rasterised to JPEG before they get here. */
  dataUrl: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  attachments?: Attachment[]
  reasoning?: string
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
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ApiMessage {
  role: 'system' | ChatRole
  content: string | ContentPart[]
}

export interface ChatCompletionRequest {
  model: string
  messages: ApiMessage[]
  stream: true
  stream_options: { include_usage: true }
  temperature: number
  max_tokens: number
  top_p: number
  top_k: number
  min_p: number
  repetition_penalty: number
  seed?: number
  stop?: string[]
  chat_template_kwargs?: { enable_thinking: boolean }
}

export type FinishReason = 'stop' | 'length' | 'abort' | string

export interface StreamEvents {
  onContent: (text: string) => void
  onReasoning: (text: string) => void
  onFinish: (reason: FinishReason) => void
}

export interface ModelInfo {
  id: string
}

export interface ModelsResponse {
  data: ModelInfo[]
}
