import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerPermission,
  fetchArtifact,
  fetchChat,
  fetchChats,
  fetchTools,
  stopChat,
  streamAgentTurn,
} from './api/agent'
import { fetchModels } from './api/vllm'
import { attachmentsFromFile } from './lib/attachments'
import type { AgentEvent } from './types'
import App from './App'

vi.mock('./api/vllm', () => ({ fetchModels: vi.fn() }))

vi.mock('./api/agent', () => ({
  answerPermission: vi.fn(),
  deleteChat: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchChat: vi.fn(),
  fetchChats: vi.fn(),
  fetchTools: vi.fn(),
  stopChat: vi.fn(),
  streamAgentTurn: vi.fn(),
}))

vi.mock('./lib/attachments', () => ({
  attachmentsFromFile: vi.fn(),
  MAX_PDF_PAGES: 8,
}))

const mockedStream = vi.mocked(streamAgentTurn)
const mockedAttachmentsFromFile = vi.mocked(attachmentsFromFile)

const groups = [
  { id: 'files', label: 'Files', description: 'Files', tools: ['read_file'] },
  { id: 'bash', label: 'Terminal', description: 'Bash', tools: ['run_bash'] },
  { id: 'web_search', label: 'Web search', description: 'Search', tools: ['web_search'] },
  { id: 'artifacts', label: 'Artifacts', description: 'Artifacts', tools: ['create_artifact'] },
]

const replyWith =
  (...events: AgentEvent[]) =>
  async ({ onEvent }: { onEvent: (event: AgentEvent) => void }) => {
    onEvent({ type: 'start', chat_id: 'chat_1', title: 'T', message_id: 'm1' })
    events.forEach(onEvent)
  }

const waitForModel = async () => {
  await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('model-a'))
}

const send = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.type(screen.getByLabelText('Message'), text)
  await user.click(screen.getByRole('button', { name: 'Send message' }))
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(fetchModels).mockResolvedValue(['model-a'])
    vi.mocked(fetchTools).mockResolvedValue({ groups, chromium: false })
    vi.mocked(fetchChats).mockResolvedValue([])
    vi.mocked(stopChat).mockResolvedValue({ ok: true })
    vi.mocked(answerPermission).mockResolvedValue({ ok: true })
    mockedStream.mockReset()
    mockedStream.mockImplementation(replyWith({ type: 'text', text: 'Model answer' }))
    mockedAttachmentsFromFile.mockReset()
  })

  it('continues the same chat and sends the tools picked for each message', async () => {
    const user = userEvent.setup()
    render(<App />)
    await waitForModel()

    await send(user, 'First question')
    await screen.findByText('Model answer')
    expect(mockedStream.mock.calls[0][0]).toMatchObject({
      chatId: null,
      content: 'First question',
      tools: ['web_search', 'web_fetch', 'artifacts'],
    })

    // Tools stay switchable after the chat has started.
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.click(screen.getByRole('button', { name: 'Web search' }))
    await send(user, 'Follow-up')

    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(2))
    expect(mockedStream.mock.calls[1][0]).toMatchObject({
      chatId: 'chat_1',
      content: 'Follow-up',
      tools: ['web_fetch', 'artifacts', 'bash'],
    })
  })

  it('asks the server to stop the turn and can reset to a fresh chat', async () => {
    const user = userEvent.setup()
    mockedStream.mockImplementation(
      ({ onEvent, signal }) =>
        new Promise<void>((_resolve, reject) => {
          onEvent({ type: 'start', chat_id: 'chat_9', title: 'T', message_id: 'm' })
          onEvent({ type: 'text', text: 'partial' })
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    render(<App />)
    await waitForModel()

    await send(user, 'Long answer, please')
    await user.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(stopChat).toHaveBeenCalledWith('chat_9')

    await user.click(screen.getAllByRole('button', { name: 'New chat' })[0])
    expect(screen.queryByText('Long answer, please')).not.toBeInTheDocument()
    expect(screen.getByText('Test a hosted model')).toBeInTheDocument()
  })

  it('shows tool calls and opens an artifact from its placeholder', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchArtifact).mockResolvedValue({
      id: 'art_1',
      chat_id: 'chat_1',
      kind: 'markdown',
      language: '',
      title: 'Trip plan',
      content: '# Day one\n\nMuseum',
      version: 1,
      latest_version: 1,
    })
    mockedStream.mockImplementation(
      replyWith(
        { type: 'text', text: 'Writing it.' },
        { type: 'tool_start', id: 'c1', name: 'create_artifact', args: { title: 'Trip plan' } },
        {
          type: 'tool_end',
          id: 'c1',
          name: 'create_artifact',
          ok: true,
          summary: 'Trip plan · markdown',
          output: 'Created',
          duration_ms: 3,
        },
        { type: 'text', text: '\n\n[Trip plan](#artifact/art_1/1)\n\n' },
        { type: 'text', text: 'Here it is.' },
      ),
    )
    render(<App />)
    await waitForModel()
    await send(user, 'Plan a trip')

    expect(await screen.findByText('Create artifact')).toBeInTheDocument()
    expect(screen.getByText('Trip plan · markdown')).toBeInTheDocument()
    const chip = await screen.findByRole('button', { name: /Trip plan.*Document · version 1/ })
    expect(fetchArtifact).toHaveBeenCalledWith('art_1', 1)

    await user.click(chip)
    const panel = screen.getByRole('complementary', { name: 'Artifact' })
    expect(within(panel).getByRole('heading', { name: 'Day one' })).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Close artifact' }))
    expect(screen.queryByRole('complementary', { name: 'Artifact' })).not.toBeInTheDocument()
  })

  it('asks for the sudo password and sends the answer', async () => {
    const user = userEvent.setup()
    mockedStream.mockImplementation(
      ({ onEvent }) =>
        new Promise<void>(() => {
          onEvent({ type: 'start', chat_id: 'chat_1', title: 'T', message_id: 'm' })
          onEvent({ type: 'tool_start', id: 'c1', name: 'run_bash', args: { command: 'sudo apt update' } })
          onEvent({
            type: 'permission',
            request_id: 'perm_1',
            tool_call_id: 'c1',
            kind: 'sudo',
            command: 'sudo apt update',
            reason: 'Refresh package lists',
          })
        }),
    )
    render(<App />)
    await waitForModel()
    await send(user, 'Update packages')

    expect(await screen.findByText('Refresh package lists')).toBeInTheDocument()
    expect(screen.getByText('waiting for you')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Sudo password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(answerPermission).toHaveBeenCalledWith('perm_1', true, 'hunter2')
  })

  it('shows reasoning and the notice the server sends with the result', async () => {
    const user = userEvent.setup()
    mockedStream.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'start', chat_id: 'chat_1', title: 'T', message_id: 'm' })
      onEvent({ type: 'reasoning', text: 'weighing the options' })
      onEvent({
        type: 'done',
        message_id: 'm',
        status: 'completed',
        notice: 'Output was cut off by the max tokens limit.',
        usage: {},
      })
    })
    render(<App />)
    await waitForModel()
    await send(user, 'Something hard')

    expect(await screen.findByText('weighing the options')).toBeInTheDocument()
    expect(await screen.findByText(/cut off by the max tokens/)).toBeInTheDocument()
  })

  it('renders assistant markdown and keeps the prompt literal', async () => {
    const user = userEvent.setup()
    mockedStream.mockImplementation(
      replyWith({ type: 'text', text: '# Title\n\nSome **bold** text.\n\n```py\nx = 1\n```' }),
    )
    render(<App />)
    await waitForModel()
    await send(user, '# Not a heading')

    expect(await screen.findByRole('heading', { name: 'Title', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByText('# Not a heading').tagName).toBe('P')
  })

  it('lets a follow-up be typed while a response is still streaming', async () => {
    const user = userEvent.setup()
    mockedStream.mockImplementation(() => new Promise<void>(() => {}))
    render(<App />)
    await waitForModel()

    await send(user, 'First')
    await screen.findByRole('button', { name: 'Stop' })
    const composer = screen.getByLabelText('Message')
    await user.type(composer, 'Queued follow-up')
    expect(composer).toHaveValue('Queued follow-up')
  })

  it('sends a PDF as rasterised page images', async () => {
    const user = userEvent.setup()
    mockedAttachmentsFromFile.mockResolvedValue({
      attachments: [{ id: 'page-1', name: 'notes.pdf · page 1', dataUrl: 'data:image/jpeg;base64,AAA' }],
      omittedPages: 0,
    })
    render(<App />)
    await waitForModel()

    const file = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file)
    await screen.findByAltText('notes.pdf · page 1')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(mockedStream).toHaveBeenCalled())
    expect(mockedStream.mock.calls[0][0].attachments).toMatchObject([
      { name: 'notes.pdf · page 1', dataUrl: 'data:image/jpeg;base64,AAA' },
    ])
  })

  it('loads a saved chat with its tools from the sidebar', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchChats).mockResolvedValue([
      { id: 'chat_old', title: 'Old chat', created_at: 1, updated_at: 2 },
    ])
    vi.mocked(fetchChat).mockResolvedValue({
      chat: {
        id: 'chat_old',
        title: 'Old chat',
        created_at: 1,
        updated_at: 2,
        settings: { tools: ['files'] },
      },
      messages: [
        { id: 'u', role: 'user', content: 'Earlier question' },
        {
          id: 'a',
          role: 'assistant',
          content: 'Earlier answer',
          parts: [{ type: 'text', text: 'Earlier answer' }],
          status: 'completed',
        },
      ],
      running: false,
    })
    render(<App />)
    await waitForModel()

    await user.click(await screen.findByRole('button', { name: 'Old chat' }))
    expect(await screen.findByText('Earlier answer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Web search' })).toHaveAttribute('aria-pressed', 'false')

    await send(user, 'More')
    await waitFor(() => expect(mockedStream).toHaveBeenCalled())
    expect(mockedStream.mock.calls[0][0]).toMatchObject({ chatId: 'chat_old', tools: ['files'] })
  })

  it('refuses the browser tool until Chromium is installed', async () => {
    const user = userEvent.setup()
    vi.mocked(fetchTools).mockResolvedValue({
      groups: [...groups, { id: 'browser', label: 'Browser', description: 'B', tools: ['browse_web'] }],
      chromium: false,
    })
    render(<App />)
    await waitForModel()

    await user.click(await screen.findByRole('button', { name: 'Browser' }))
    expect(screen.getByRole('alert')).toHaveTextContent('playwright install chromium')
    expect(screen.getByRole('button', { name: 'Browser' })).toHaveAttribute('aria-pressed', 'false')
  })
})
