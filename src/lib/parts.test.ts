import { describe, expect, it } from 'vitest'
import type { AgentEvent, MessagePart } from '../types'
import { applyEvent, settleParts } from './parts'

const run = (events: AgentEvent[]) =>
  events.reduce<MessagePart[]>((parts, event) => applyEvent(parts, event), [])

describe('applyEvent', () => {
  it('joins streamed text and orders it around tool cards', () => {
    const parts = run([
      { type: 'reasoning', text: 'plan ' },
      { type: 'reasoning', text: 'more' },
      { type: 'text', text: 'Look' },
      { type: 'text', text: 'ing.' },
      { type: 'tool_start', id: 'c1', name: 'web_search', args: { query: 'x' } },
      { type: 'tool_progress', id: 'c1', message: 'searching' },
      { type: 'tool_end', id: 'c1', name: 'web_search', ok: true, summary: '3 results', output: '1.', duration_ms: 1 },
      { type: 'text', text: 'Done.' },
    ])
    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool', 'text'])
    expect(parts[1]).toEqual({ type: 'text', text: 'Looking.' })
    expect(parts[2]).toMatchObject({ status: 'done', summary: '3 results', progress: ['searching'] })
  })

  it('tracks a permission prompt on its tool card', () => {
    const parts = run([
      { type: 'tool_start', id: 'c1', name: 'run_bash', args: { command: 'sudo ls' } },
      { type: 'permission', request_id: 'p1', tool_call_id: 'c1', kind: 'sudo', command: 'sudo ls', reason: '' },
    ])
    expect(parts[0]).toMatchObject({ permission: { request_id: 'p1', state: 'pending' } })
    const resolved = applyEvent(parts, {
      type: 'permission_resolved',
      request_id: 'p1',
      tool_call_id: 'c1',
      approved: true,
    })
    expect(resolved[0]).toMatchObject({ permission: { state: 'approved' } })
  })

  it('marks tools left running by a stopped stream', () => {
    const parts = settleParts(run([{ type: 'tool_start', id: 'c1', name: 'run_bash', args: {} }]))
    expect(parts[0]).toMatchObject({ status: 'error', summary: 'stopped' })
  })
})
