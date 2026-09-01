import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchModels, streamChat } from './api/vllm'
import { SettingsPanel } from './components/SettingsPanel'
import type { ChatMessage, GenerationSettings } from './types'
import './styles.css'

const initialSettings: GenerationSettings = {
  apiKey: '',
  model: '',
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
  maxTokens: 4096,
  topP: 0.95,
  topK: -1,
  minP: 0,
  seed: '',
  stop: '',
  repetitionPenalty: 1,
  enableThinking: false,
}

const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [settings, setSettings] =
    useState<GenerationSettings>(initialSettings)
  const [models, setModels] = useState<string[]>([])
  const [modelStatus, setModelStatus] = useState<
    'idle' | 'loading' | 'error'
  >('idle')
  const [isGenerating, setIsGenerating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const loadModels = useCallback(
    async (
      apiKey: string,
      signal?: AbortSignal,
      showLoading = true,
    ) => {
      if (showLoading) setModelStatus('loading')
      try {
        const availableModels = await fetchModels(apiKey, signal)
        setModels(availableModels)
        setSettings((current) => ({
          ...current,
          model:
            current.model || (availableModels.length ? availableModels[0] : ''),
        }))
        setModelStatus('idle')
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setModelStatus('error')
      }
    },
    [],
  )

  useEffect(() => {
    const apiKey = settings.apiKey.trim()
    if (!apiKey) return

    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      // Loading models is an intentional external-system synchronization.
      // oxlint-disable-next-line react/set-state-in-effect
      void loadModels(apiKey, controller.signal, false)
    }, 350)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [loadModels, settings.apiKey])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => () => abortRef.current?.abort(), [])

  const stopGeneration = () => abortRef.current?.abort()

  const startNewChat = () => {
    stopGeneration()
    setMessages([])
    setDraft('')
    setError('')
  }

  const sendMessage = async () => {
    const content = draft.trim()
    if (!content || isGenerating) return
    if (!settings.apiKey.trim()) {
      setError('Enter a vLLM API key in settings before sending a message.')
      setSettingsOpen(true)
      return
    }
    if (!settings.model.trim()) {
      setError('Choose or enter a model ID before sending a message.')
      setSettingsOpen(true)
      return
    }

    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content,
    }
    const assistantId = makeId()
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
    }
    const context = [...messages, userMessage]
    const controller = new AbortController()
    let receivedText = ''
    let receivedReasoning = ''
    let finishReason = ''

    abortRef.current = controller
    setDraft('')
    setError('')
    setIsGenerating(true)
    setMessages([...context, assistantMessage])

    const updateAssistant = (patch: Partial<ChatMessage>) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, ...patch } : message,
        ),
      )

    try {
      await streamChat({
        messages: context,
        settings,
        signal: controller.signal,
        onContent: (text) => {
          receivedText += text
          updateAssistant({ content: receivedText })
        },
        onReasoning: (text) => {
          receivedReasoning += text
          updateAssistant({ reasoning: receivedReasoning })
        },
        onFinish: (reason) => {
          finishReason = reason
        },
      })

      if (finishReason === 'length' && !receivedText) {
        updateAssistant({
          notice: `The whole ${settings.maxTokens}-token budget was spent on reasoning, so no answer was produced. Raise max tokens or turn off thinking in settings.`,
        })
      } else if (finishReason === 'length') {
        updateAssistant({
          notice: 'Output was cut off by the max tokens limit.',
        })
      }
    } catch (caught) {
      const wasAborted =
        controller.signal.aborted ||
        (caught instanceof DOMException && caught.name === 'AbortError')

      if (!receivedText && !receivedReasoning) {
        setMessages((current) =>
          current.filter((message) => message.id !== assistantId),
        )
      }
      if (!wasAborted) {
        setError(
          caught instanceof Error ? caught.message : 'Generation failed.',
        )
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setIsGenerating(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-column">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              v
            </span>
            <div>
              <p className="eyebrow">Inference playground</p>
              <h1>vLLM Chat</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection-status ${
                modelStatus === 'error' ? 'is-error' : ''
              }`}
            >
              <i aria-hidden="true" />
              {modelStatus === 'loading'
                ? 'Connecting'
                : modelStatus === 'error'
                  ? 'Manual model'
                  : 'Ready'}
            </span>
            <button
              className="secondary-button"
              type="button"
              onClick={startNewChat}
            >
              New chat
            </button>
            <button
              className="icon-button settings-toggle"
              type="button"
              aria-label="Open settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">
                v
              </div>
              <h2>Test a hosted model</h2>
              <p>
                Choose a model, tune generation settings, and start a
                conversation. Context stays available until you start a new
                chat.
              </p>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article
                  className={`message message-${message.role}`}
                  key={message.id}
                >
                  <div className="message-avatar" aria-hidden="true">
                    {message.role === 'user' ? 'You' : 'v'}
                  </div>
                  <div className="message-body">
                    <strong>
                      {message.role === 'user' ? 'You' : settings.model}
                    </strong>
                    {message.reasoning && (
                      <details className="reasoning-block">
                        <summary>
                          Reasoning
                          {isGenerating && !message.content
                            ? ' (thinking…)'
                            : ''}
                        </summary>
                        <div className="reasoning-content">
                          {message.reasoning}
                        </div>
                      </details>
                    )}
                    <div className="message-content">
                      {message.content ||
                        (isGenerating && message.role === 'assistant' ? (
                          <span className="typing-indicator">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : null)}
                      {isGenerating &&
                        message.role === 'assistant' &&
                        message === messages[messages.length - 1] &&
                        message.content && (
                          <span className="stream-cursor" aria-hidden="true" />
                        )}
                    </div>
                    {message.notice && (
                      <p className="message-notice">{message.notice}</p>
                    )}
                  </div>
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="composer-area">
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                type="button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          <div className="composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              rows={1}
              placeholder={
                isGenerating ? 'Generating… type your next message' : 'Message the model…'
              }
              aria-label="Message"
            />
            {isGenerating ? (
              <button
                className="stop-button"
                type="button"
                onClick={stopGeneration}
              >
                <span aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                className="send-button"
                type="button"
                onClick={() => void sendMessage()}
                disabled={!draft.trim()}
                aria-label="Send message"
              >
                ↑
              </button>
            )}
          </div>
          <p className="composer-hint">
            Enter to send · Shift + Enter for a new line
          </p>
        </div>
      </section>

      <SettingsPanel
        settings={settings}
        models={models}
        modelStatus={modelStatus}
        isOpen={settingsOpen}
        disabled={isGenerating}
        onChange={setSettings}
        onRefreshModels={() => void loadModels(settings.apiKey)}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  )
}

export default App
