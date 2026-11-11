import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBrowserHealth, streamBrowserTask } from './api/browser'
import { fetchModels, streamChat } from './api/vllm'
import { attachmentsFromFile } from './lib/attachments'
import App from './App'

vi.mock('./api/vllm', () => ({
  fetchModels: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock('./api/browser', () => ({
  fetchBrowserHealth: vi.fn(),
  formatBrowserTask: (messages: { role: string; content: string }[]) =>
    messages.at(-1)?.content ?? '',
  streamBrowserTask: vi.fn(),
}))

vi.mock('./lib/attachments', () => ({
  attachmentsFromFile: vi.fn(),
  MAX_PDF_PAGES: 8,
}))

const mockedFetchModels = vi.mocked(fetchModels)
const mockedStreamChat = vi.mocked(streamChat)
const mockedBrowserHealth = vi.mocked(fetchBrowserHealth)
const mockedBrowserTask = vi.mocked(streamBrowserTask)
const mockedAttachmentsFromFile = vi.mocked(attachmentsFromFile)

const waitForModel = async () => {
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveValue('model-a'),
  )
}

const enterApiKey = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('API key'), 'test-key')
  await waitForModel()
}

describe('App', () => {
  beforeEach(() => {
    mockedFetchModels.mockResolvedValue(['model-a'])
    mockedStreamChat.mockImplementation(async ({ onContent }) => {
      onContent('Model answer')
    })
    mockedAttachmentsFromFile.mockReset()
    mockedBrowserHealth.mockResolvedValue({
      ok: true,
      chromium: '/tmp/chrome',
      busy: false,
      vllm: 'http://127.0.0.1:8000/v1',
    })
    mockedBrowserTask.mockReset()
  })

  it('sends previous user and assistant messages as context', async () => {
    const user = userEvent.setup()
    render(<App />)
    await enterApiKey(user)

    const composer = screen.getByLabelText('Message')
    await user.type(composer, 'First question')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Model answer')

    await user.type(composer, 'Follow-up')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(mockedStreamChat).toHaveBeenCalledTimes(2))
    expect(mockedStreamChat.mock.calls[1][0].settings.apiKey).toBe('test-key')
    expect(mockedStreamChat.mock.calls[1][0].messages).toMatchObject([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Model answer' },
      { role: 'user', content: 'Follow-up' },
    ])
  })

  it('aborts generation and can reset to a fresh chat', async () => {
    const user = userEvent.setup()
    let observedSignal: AbortSignal | undefined
    mockedStreamChat.mockImplementation(
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          observedSignal = signal
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )

    render(<App />)
    await waitForModel()

    await user.type(screen.getByLabelText('Message'), 'Long answer, please')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await user.click(await screen.findByRole('button', { name: 'Stop' }))

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    expect(screen.getByText('Long answer, please')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.queryByText('Long answer, please')).not.toBeInTheDocument()
    expect(screen.getByText('Test a hosted model')).toBeInTheDocument()
  })

  it('shows reasoning output and warns when the token budget is exhausted', async () => {
    const user = userEvent.setup()
    mockedStreamChat.mockImplementation(async ({ onReasoning, onFinish }) => {
      onReasoning('weighing the options')
      onFinish('length')
    })

    render(<App />)
    await waitForModel()

    await user.type(screen.getByLabelText('Message'), 'Something hard')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('weighing the options')).toBeInTheDocument()
    expect(
      await screen.findByText(/budget was spent on reasoning/),
    ).toBeInTheDocument()
  })

  it('lets a follow-up be typed while a response is still streaming', async () => {
    const user = userEvent.setup()
    mockedStreamChat.mockImplementation(
      ({ onContent }) =>
        new Promise<void>(() => {
          onContent('partial')
        }),
    )

    render(<App />)
    await waitForModel()

    const composer = screen.getByLabelText('Message')
    await user.type(composer, 'First')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('button', { name: 'Stop' })

    expect(composer).not.toBeDisabled()
    await user.type(composer, 'Queued follow-up')
    expect(composer).toHaveValue('Queued follow-up')
  })

  it('renders assistant markdown as formatted output', async () => {
    const user = userEvent.setup()
    mockedStreamChat.mockImplementation(async ({ onContent }) => {
      onContent('# Title\n\nSome **bold** text.\n\n```py\nx = 1\n```')
    })

    render(<App />)
    await waitForModel()

    await user.type(screen.getByLabelText('Message'), '# Not a heading')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(
      await screen.findByRole('heading', { name: 'Title', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    // The prompt itself must stay literal rather than becoming a heading.
    expect(screen.getByText('# Not a heading').tagName).toBe('P')
  })

  it('keeps a stopped reply from looking active while the next one streams', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)

    mockedStreamChat.mockImplementationOnce(
      ({ signal, onReasoning }) =>
        new Promise<void>((_resolve, reject) => {
          onReasoning('half a thought')
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    mockedStreamChat.mockImplementationOnce(() => new Promise<void>(() => {}))

    await waitForModel()

    await user.type(screen.getByLabelText('Message'), 'First question')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await user.click(await screen.findByRole('button', { name: 'Stop' }))

    await user.type(screen.getByLabelText('Message'), 'Second question')
    await user.click(await screen.findByRole('button', { name: 'Send message' }))
    await screen.findByRole('button', { name: 'Stop' })

    expect(container.querySelectorAll('.typing-indicator')).toHaveLength(1)
    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.queryByText(/thinking…/)).not.toBeInTheDocument()
  })

  it('sends the message to the browser agent when Browse is on', async () => {
    const user = userEvent.setup()
    mockedBrowserTask.mockImplementation(async ({ onStatus, onStep, onDone }) => {
      onStatus('Starting the browser…')
      onStep({
        step: 1,
        url: 'https://example.com',
        evaluation: '',
        memory: '',
        goal: 'Read the heading',
        actions: ['navigate(url=https://example.com)'],
      })
      onDone('The heading is Example Domain.')
    })

    render(<App />)
    await waitForModel()

    await user.click(screen.getByRole('button', { name: 'Browse' }))
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.type(screen.getByLabelText('Message'), 'Open example.com')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('The heading is Example Domain.')).toBeInTheDocument()
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByText('navigate(url=https://example.com)')).toBeInTheDocument()
    expect(mockedStreamChat).not.toHaveBeenCalled()
    expect(mockedBrowserTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Open example.com',
        model: 'model-a',
        apiKey: '',
        showBrowser: false,
      }),
    )
  })

  it('sends a PDF as rasterised page images', async () => {
    const user = userEvent.setup()
    mockedAttachmentsFromFile.mockResolvedValue({
      attachments: [
        {
          id: 'page-1',
          name: 'notes.pdf · page 1',
          dataUrl: 'data:image/jpeg;base64,AAA',
        },
      ],
      omittedPages: 0,
    })

    render(<App />)
    await waitForModel()

    const file = new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      file,
    )
    await screen.findByAltText('notes.pdf · page 1')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(mockedStreamChat).toHaveBeenCalled())
    expect(mockedStreamChat.mock.calls[0][0].messages[0]).toMatchObject({
      role: 'user',
      attachments: [
        {
          name: 'notes.pdf · page 1',
          dataUrl: 'data:image/jpeg;base64,AAA',
        },
      ],
    })
  })
})
