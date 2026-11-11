import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  answerPermission,
  deleteChat,
  fetchChat,
  fetchChats,
  fetchTools,
  stopChat,
  streamAgentTurn,
} from './api/agent'
import { fetchModels } from './api/vllm'
import { ChatSidebar } from './components/ChatSidebar'
import { Markdown } from './components/Markdown'
import { SettingsPanel } from './components/SettingsPanel'
import { ToolCard } from './components/ToolCard'
import { ToolPicker } from './components/ToolPicker'
import { ArtifactPanel } from './components/artifacts'
import { ArtifactContext, type OpenArtifact } from './lib/artifactContext'
import { attachmentsFromFile, MAX_PDF_PAGES } from './lib/attachments'
import { applyEvent, settleParts } from './lib/parts'
import type {
  Attachment,
  ChatMessage,
  ChatSummary,
  GenerationSettings,
  MessagePart,
  ToolGroup,
} from './types'
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
  workdir: '',
  maxSteps: 30,
}

const TOOLS_KEY = 'vllm-chat.tools'
const DEFAULT_TOOLS = ['web_search', 'web_fetch', 'artifacts']
// Stop asks the server to end the turn so its answer is stored; this is the fallback.
const STOP_GRACE_MS = 5000

const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`

const savedTools = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? 'null') as unknown
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : DEFAULT_TOOLS
  } catch {
    return DEFAULT_TOOLS
  }
}

function AssistantParts({
  parts,
  isStreaming,
  onPermission,
}: {
  parts: MessagePart[]
  isStreaming: boolean
  onPermission: (requestId: string, approve: boolean, password?: string) => Promise<void>
}) {
  return (
    <>
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1
        if (part.type === 'reasoning') {
          return (
            <details className="reasoning-block" key={index}>
              <summary>
                Reasoning{isStreaming && isLast ? ' (thinking…)' : ''}
              </summary>
              <div className="reasoning-content">{part.text}</div>
            </details>
          )
        }
        if (part.type === 'tool') {
          return <ToolCard key={part.id} part={part} onPermission={onPermission} />
        }
        return (
          <div
            key={index}
            className={`message-content ${isStreaming && isLast ? 'is-streaming' : ''}`}
          >
            <Markdown content={part.text} />
          </div>
        )
      })}
    </>
  )
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [settings, setSettings] = useState<GenerationSettings>(initialSettings)
  const [models, setModels] = useState<string[]>([])
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamingId, setStreamingId] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isAttaching, setIsAttaching] = useState(false)
  const [chatId, setChatId] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [toolGroups, setToolGroups] = useState<ToolGroup[]>([])
  const [chromium, setChromium] = useState(false)
  const [selectedTools, setSelectedTools] = useState<string[]>(savedTools)
  const [showBrowser, setShowBrowser] = useState(false)
  const [openArtifact, setOpenArtifact] = useState<OpenArtifact | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const chatIdRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const loadModels = useCallback(
    async (apiKey: string, signal?: AbortSignal, showLoading = true) => {
      if (showLoading) setModelStatus('loading')
      try {
        const availableModels = await fetchModels(apiKey, signal)
        setModels(availableModels)
        setSettings((current) => ({
          ...current,
          model: current.model || (availableModels.length ? availableModels[0] : ''),
        }))
        setModelStatus('idle')
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setModelStatus('error')
      }
    },
    [],
  )

  const refreshChats = useCallback(async () => {
    try {
      setChats(await fetchChats())
    } catch {
      // The list is a convenience; the chat itself still works.
    }
  }, [])

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
    const controller = new AbortController()
    fetchTools(controller.signal).then(
      (info) => {
        setToolGroups(info.groups)
        setChromium(info.chromium)
      },
      () => {
        if (!controller.signal.aborted) {
          setError('The agent server is not running. Start the app with npm run dev so it can launch it.')
        }
      },
    )
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshChats()
    return () => controller.abort()
  }, [refreshChats])

  useEffect(() => {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(selectedTools))
  }, [selectedTools])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => () => abortRef.current?.abort(), [])

  const stopGeneration = () => {
    const controller = abortRef.current
    if (!controller) return
    const activeChat = chatIdRef.current
    if (!activeChat) {
      controller.abort()
      return
    }
    void stopChat(activeChat).catch(() => controller.abort())
    window.setTimeout(() => controller.abort(), STOP_GRACE_MS)
  }

  const resetChat = () => {
    setMessages([])
    setDraft('')
    setError('')
    setAttachments([])
    setChatId(null)
    chatIdRef.current = null
    setOpenArtifact(null)
  }

  const startNewChat = () => {
    abortRef.current?.abort()
    resetChat()
    setSidebarOpen(false)
  }

  const selectChat = async (id: string) => {
    if (isGenerating) return
    setSidebarOpen(false)
    try {
      const loaded = await fetchChat(id)
      setMessages(loaded.messages)
      setChatId(id)
      chatIdRef.current = id
      setOpenArtifact(null)
      setError('')
      if (loaded.chat.settings.tools) setSelectedTools(loaded.chat.settings.tools)
      setShowBrowser(Boolean(loaded.chat.settings.showBrowser))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load that chat.')
    }
  }

  const removeChat = async (id: string) => {
    try {
      await deleteChat(id)
      if (id === chatId) resetChat()
      await refreshChats()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete that chat.')
    }
  }

  const toggleTool = (groupId: string) => {
    if (selectedTools.includes(groupId)) {
      setSelectedTools(selectedTools.filter((id) => id !== groupId))
      return
    }
    if (groupId === 'browser' && !chromium) {
      setError(
        'Chromium is not installed for the browser tool. From the project folder run: playwright install chromium, then restart npm run dev.',
      )
      return
    }
    setSelectedTools([...selectedTools, groupId])
  }

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setIsAttaching(true)
    setError('')
    try {
      for (const file of files) {
        const { attachments: added, omittedPages } = await attachmentsFromFile(file)
        setAttachments((current) => [...current, ...added])
        if (omittedPages) {
          setError(
            `${file.name} has ${omittedPages} more page${omittedPages === 1 ? '' : 's'}; only the first ${MAX_PDF_PAGES} were attached.`,
          )
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read that file.')
    } finally {
      setIsAttaching(false)
    }
  }

  const removeAttachment = (id: string) =>
    setAttachments((current) => current.filter((item) => item.id !== id))

  const respondToPermission = async (requestId: string, approve: boolean, password?: string) => {
    try {
      await answerPermission(requestId, approve, password)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send your answer.')
    }
  }

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
    const controller = new AbortController()
    const sentAttachments = attachments
    let parts: MessagePart[] = []
    let answer = ''
    let received = false

    abortRef.current = controller
    setDraft('')
    setAttachments([])
    setError('')
    setIsGenerating(true)
    setStreamingId(assistantId)
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', parts: [] },
    ])

    const updateAssistant = (patch: Partial<ChatMessage>) =>
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, ...patch } : message)),
      )

    try {
      await streamAgentTurn({
        chatId,
        content,
        attachments: sentAttachments,
        settings,
        tools: selectedTools,
        showBrowser,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'start') {
            chatIdRef.current = event.chat_id
            setChatId(event.chat_id)
            void refreshChats()
            return
          }
          if (event.type === 'done') {
            updateAssistant({ status: event.status, notice: event.notice || undefined })
            return
          }
          if (event.type === 'error') {
            setError(event.message)
            return
          }
          received = true
          if (event.type === 'text') answer += event.text
          parts = applyEvent(parts, event)
          updateAssistant({ parts, content: answer })
        },
      })
    } catch (caught) {
      const wasAborted =
        controller.signal.aborted ||
        (caught instanceof DOMException && caught.name === 'AbortError')
      if (!received) {
        setMessages((current) => current.filter((message) => message.id !== assistantId))
      }
      if (!wasAborted) {
        setError(caught instanceof Error ? caught.message : 'Generation failed.')
      }
    } finally {
      updateAssistant({ parts: settleParts(parts) })
      if (abortRef.current === controller) {
        abortRef.current = null
        setIsGenerating(false)
        setStreamingId('')
      }
      void refreshChats()
    }
  }

  const artifactContext = useMemo(
    () => ({ open: setOpenArtifact, current: openArtifact }),
    [openArtifact],
  )

  return (
    <ArtifactContext.Provider value={artifactContext}>
      <main className={`app-shell ${openArtifact ? 'has-artifact' : ''}`}>
        <ChatSidebar
          chats={chats}
          activeId={chatId}
          isOpen={sidebarOpen}
          onSelect={(id) => void selectChat(id)}
          onDelete={(id) => void removeChat(id)}
          onNewChat={startNewChat}
          onClose={() => setSidebarOpen(false)}
        />
        <section className="chat-column">
          <header className="topbar">
            <div className="brand">
              <button
                className="icon-button sidebar-toggle"
                type="button"
                aria-label="Open chats"
                onClick={() => setSidebarOpen(true)}
              >
                ☰
              </button>
              <span className="brand-mark" aria-hidden="true">
                v
              </span>
              <div>
                <p className="eyebrow">Inference playground</p>
                <h1>vLLM Chat</h1>
              </div>
            </div>
            <div className="topbar-actions">
              <span className={`connection-status ${modelStatus === 'error' ? 'is-error' : ''}`}>
                <i aria-hidden="true" />
                {modelStatus === 'loading'
                  ? 'Connecting'
                  : modelStatus === 'error'
                    ? 'Manual model'
                    : 'Ready'}
              </span>
              <button className="secondary-button" type="button" onClick={startNewChat}>
                New chat
              </button>
              <button
                className="icon-button settings-toggle"
                type="button"
                aria-label="Open settings"
                onClick={() => {
                  setOpenArtifact(null)
                  setSettingsOpen(true)
                }}
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
                  Choose a model and the tools it may use, then start a conversation. Chats are
                  saved, and tools can be switched between messages.
                </p>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => {
                  const isStreaming = isGenerating && message.id === streamingId
                  const parts = message.parts ?? []
                  return (
                    <article className={`message message-${message.role}`} key={message.id}>
                      <div className="message-avatar" aria-hidden="true">
                        {message.role === 'user' ? 'You' : 'v'}
                      </div>
                      <div className="message-body">
                        <strong>{message.role === 'user' ? 'You' : settings.model}</strong>
                        {message.attachments?.length ? (
                          <ul className="message-attachments">
                            {message.attachments.map((attachment) => (
                              <li key={attachment.id}>
                                <a href={attachment.dataUrl} target="_blank" rel="noopener noreferrer">
                                  <img src={attachment.dataUrl} alt={attachment.name} />
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {message.role === 'user' ? (
                          <div className="message-content">
                            <p className="plain-text">{message.content}</p>
                          </div>
                        ) : parts.length ? (
                          <AssistantParts
                            parts={parts}
                            isStreaming={isStreaming}
                            onPermission={respondToPermission}
                          />
                        ) : message.content ? (
                          <div className="message-content">
                            <Markdown content={message.content} />
                          </div>
                        ) : null}
                        {isStreaming && (parts.at(-1)?.type ?? 'tool') === 'tool' &&
                        !parts.some((part) => part.type === 'tool' && part.status === 'running') ? (
                          <span className="typing-indicator">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : null}
                        {message.notice && <p className="message-notice">{message.notice}</p>}
                        {!isStreaming && message.status === 'stopped' ? (
                          <p className="message-status">Stopped.</p>
                        ) : null}
                        {!isStreaming && message.status === 'interrupted' ? (
                          <p className="message-status">The server restarted before this answer finished.</p>
                        ) : null}
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
                <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
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
              <ToolPicker
                groups={toolGroups}
                selected={selectedTools}
                disabled={isGenerating}
                showBrowser={showBrowser}
                onToggle={toggleTool}
                onShowBrowser={setShowBrowser}
              />
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
                  placeholder={isGenerating ? 'Working… type your next message' : 'Message the model…'}
                  aria-label="Message"
                />
                {isGenerating ? (
                  <button className="stop-button" type="button" onClick={stopGeneration}>
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
              Enter to send · Shift + Enter for a new line · tools can change between messages ·
              attach, paste, or drop images and PDFs
            </p>
          </div>
        </section>

        {openArtifact ? (
          <ArtifactPanel
            artifact={openArtifact}
            onSelect={setOpenArtifact}
            onClose={() => setOpenArtifact(null)}
          />
        ) : null}
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
    </ArtifactContext.Provider>
  )
}

export default App
