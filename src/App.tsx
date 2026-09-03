import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchModels, streamChat } from './api/vllm'
import { Markdown } from './components/Markdown'
import { SettingsPanel } from './components/SettingsPanel'
import { attachmentsFromFile, MAX_PDF_PAGES } from './lib/attachments'
import type { Attachment, ChatMessage, GenerationSettings } from './types'
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
  const [streamingId, setStreamingId] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isAttaching, setIsAttaching] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      // Loading models is an intentional external-system synchronization.
      // oxlint-disable-next-line react/set-state-in-effect
      void loadModels(settings.apiKey, controller.signal, false)
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
    setAttachments([])
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return

    setIsAttaching(true)
    setError('')
    try {
      for (const file of files) {
        const { attachments: added, omittedPages } =
          await attachmentsFromFile(file)
        setAttachments((current) => [...current, ...added])
        if (omittedPages) {
          setError(
            `${file.name} has ${omittedPages} more page${
              omittedPages === 1 ? '' : 's'
            }; only the first ${MAX_PDF_PAGES} were attached.`,
          )
        }
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not read that file.',
      )
    } finally {
      setIsAttaching(false)
    }
  }

  const removeAttachment = (id: string) =>
    setAttachments((current) => current.filter((item) => item.id !== id))

  const sendMessage = async () => {
    const content = draft.trim()
    if ((!content && !attachments.length) || isGenerating) return
    if (!settings.model.trim()) {
      setError('Choose or enter a model ID before sending a message.')
      setSettingsOpen(true)
      return
    }

    const userMessage: ChatMessage = {
      id: makeId(),
      role: 'user',
      content,
      ...(attachments.length ? { attachments } : {}),
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
    setAttachments([])
    setError('')
    setIsGenerating(true)
    setStreamingId(assistantId)
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
      if (abortRef.current === controller) {
        abortRef.current = null
        setIsGenerating(false)
        setStreamingId('')
      }
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
              {messages.map((message) => {
                const isStreaming =
                  isGenerating && message.id === streamingId
                return (
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
                      {message.attachments?.length ? (
                        <ul className="message-attachments">
                          {message.attachments.map((attachment) => (
                            <li key={attachment.id}>
                              <a
                                href={attachment.dataUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <img
                                  src={attachment.dataUrl}
                                  alt={attachment.name}
                                />
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {message.reasoning && (
                        <details className="reasoning-block">
                          <summary>
                            Reasoning
                            {isStreaming && !message.content
                              ? ' (thinking…)'
                              : ''}
                          </summary>
                          <div className="reasoning-content">
                            {message.reasoning}
                          </div>
                        </details>
                      )}
                      <div
                        className={`message-content ${
                          isStreaming ? 'is-streaming' : ''
                        }`}
                      >
                        {message.content ? (
                          message.role === 'assistant' ? (
                            <Markdown content={message.content} />
                          ) : (
                            <p className="plain-text">{message.content}</p>
                          )
                        ) : isStreaming ? (
                          <span className="typing-indicator">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : null}
                      </div>
                      {message.notice && (
                        <p className="message-notice">{message.notice}</p>
                      )}
                    </div>
                  </article>
                )
              })}
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
          <div
            className="composer"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              void addFiles([...event.dataTransfer.files])
            }}
          >
            {(attachments.length > 0 || isAttaching) && (
              <ul className="attachment-strip">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <img src={attachment.dataUrl} alt={attachment.name} />
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ×
                    </button>
                    <small>{attachment.name}</small>
                  </li>
                ))}
                {isAttaching && <li className="attachment-pending">Reading…</li>}
              </ul>
            )}
            <div className="composer-row">
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="image/*,application/pdf"
                multiple
                aria-label="Attach images or PDFs"
                onChange={(event) => {
                  void addFiles([...(event.target.files ?? [])])
                  // Allows re-picking the same file after removing it.
                  event.target.value = ''
                }}
              />
              <button
                className="icon-button attach-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isAttaching}
                aria-label="Attach images or PDFs"
                title="Attach images or PDFs"
              >
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                  <path
                    d="M6.2 10.7 11 5.9a2.8 2.8 0 1 1 4 4l-6.4 6.4a4 4 0 0 1-5.6-5.6l6-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files]
                  if (files.length) {
                    event.preventDefault()
                    void addFiles(files)
                  }
                }}
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
                  disabled={!draft.trim() && !attachments.length}
                  aria-label="Send message"
                >
                  ↑
                </button>
              )}
            </div>
          </div>
          <p className="composer-hint">
            Enter to send · Shift + Enter for a new line · attach, paste, or drop
            images and PDFs
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
