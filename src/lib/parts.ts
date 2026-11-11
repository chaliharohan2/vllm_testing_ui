import type { AgentEvent, MessagePart, ToolPart } from '../types'

const MAX_PROGRESS = 60

const updateTool = (
  parts: MessagePart[],
  id: string,
  update: (part: ToolPart) => ToolPart,
): MessagePart[] => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type === 'tool' && part.id === id) {
      const next = [...parts]
      next[index] = update(part)
      return next
    }
  }
  return parts
}

/** Same rules as agent_server/parts.py, so a live turn matches the stored one. */
export const applyEvent = (
  parts: MessagePart[],
  event: AgentEvent,
): MessagePart[] => {
  switch (event.type) {
    case 'text':
    case 'reasoning': {
      const last = parts.at(-1)
      if (last && last.type === event.type) {
        return [...parts.slice(0, -1), { ...last, text: last.text + event.text }]
      }
      return [...parts, { type: event.type, text: event.text }]
    }
    case 'tool_start':
      return [
        ...parts,
        {
          type: 'tool',
          id: event.id,
          name: event.name,
          args: event.args ?? {},
          status: 'running',
          summary: '',
          output: '',
          progress: [],
        },
      ]
    case 'tool_progress':
      return updateTool(parts, event.id, (part) => ({
        ...part,
        progress: [...part.progress, event.message].slice(-MAX_PROGRESS),
      }))
    case 'tool_end':
      return updateTool(parts, event.id, (part) => ({
        ...part,
        status: event.ok ? 'done' : 'error',
        summary: event.summary ?? '',
        output: event.output ?? '',
      }))
    case 'permission':
      return updateTool(parts, event.tool_call_id, (part) => ({
        ...part,
        permission: {
          request_id: event.request_id,
          command: event.command,
          reason: event.reason,
          state: 'pending',
        },
      }))
    case 'permission_resolved':
      return updateTool(parts, event.tool_call_id, (part) =>
        part.permission?.request_id === event.request_id
          ? {
              ...part,
              permission: {
                ...part.permission,
                state: event.approved ? 'approved' : 'denied',
              },
            }
          : part,
      )
    default:
      return parts
  }
}

/** A stopped or failed stream leaves running tools behind. */
export const settleParts = (parts: MessagePart[]): MessagePart[] =>
  parts.map((part) =>
    part.type === 'tool' && part.status === 'running'
      ? {
          ...part,
          status: 'error',
          summary: part.summary || 'stopped',
          ...(part.permission?.state === 'pending'
            ? { permission: { ...part.permission, state: 'denied' as const } }
            : {}),
        }
      : part,
  )

export const ARTIFACT_HREF = /^#artifact\/([\w-]+)\/(\d+)$/
