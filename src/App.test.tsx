import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchModels, streamChat } from './api/vllm'
import App from './App'

vi.mock('./api/vllm', () => ({
  fetchModels: vi.fn(),
  streamChat: vi.fn(),
}))

const mockedFetchModels = vi.mocked(fetchModels)
const mockedStreamChat = vi.mocked(streamChat)

const enterApiKey = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('API key'), 'test-key')
  await waitFor(() =>
    expect(screen.getByLabelText('Model')).toHaveValue('model-a'),
  )
}

describe('App', () => {
  beforeEach(() => {
    mockedFetchModels.mockResolvedValue(['model-a'])
    mockedStreamChat.mockImplementation(async ({ onContent }) => {
      onContent('Model answer')
    })
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
    await enterApiKey(user)

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
    await enterApiKey(user)

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
    await enterApiKey(user)

    const composer = screen.getByLabelText('Message')
    await user.type(composer, 'First')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('button', { name: 'Stop' })

    expect(composer).not.toBeDisabled()
    await user.type(composer, 'Queued follow-up')
    expect(composer).toHaveValue('Queued follow-up')
  })
})
