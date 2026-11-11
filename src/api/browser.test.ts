import { describe, expect, it } from 'vitest'
import { formatBrowserTask } from './browser'
import type { ChatMessage } from '../types'

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: content,
  role,
  content,
})

describe('formatBrowserTask', () => {
  it('sends a first turn as the task itself', () => {
    expect(formatBrowserTask([message('user', 'What is on example.com?')])).toBe(
      'What is on example.com?',
    )
  })

  it('keeps earlier turns so a follow-up still has context', () => {
    expect(
      formatBrowserTask([
        message('user', 'Open example.com'),
        message('assistant', 'The heading is Example Domain.'),
        message('user', 'What does the paragraph say?'),
      ]),
    ).toBe(
      [
        'Conversation so far:',
        'User: Open example.com',
        'Assistant: The heading is Example Domain.',
        '',
        'Do this now:',
        'What does the paragraph say?',
      ].join('\n'),
    )
  })
})
