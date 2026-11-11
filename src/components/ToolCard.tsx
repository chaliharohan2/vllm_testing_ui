import { useState } from 'react'
import type { ToolPart } from '../types'

const LABELS: Record<string, string> = {
  list_files: 'List files',
  read_file: 'Read file',
  write_file: 'Write file',
  edit_file: 'Edit file',
  delete_file: 'Delete',
  run_bash: 'Terminal',
  web_search: 'Web search',
  web_fetch: 'Read page',
  browse_web: 'Browser',
  create_artifact: 'Create artifact',
  update_artifact: 'Update artifact',
  read_artifact: 'Read artifact',
  spawn_subagent: 'Subagent',
}

const headline = (part: ToolPart): string => {
  const args = part.args
  for (const key of ['command', 'query', 'url', 'path', 'name', 'title', 'task']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

/** Arguments without the big text fields, which the output or artifact already shows. */
const shownArgs = (args: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(args).map(([key, value]) =>
        typeof value === 'string' && value.length > 600
          ? [key, `${value.slice(0, 600)}… (${value.length} characters)`]
          : [key, value],
      ),
    ),
    null,
    2,
  )

function PermissionPrompt({
  part,
  onAnswer,
}: {
  part: ToolPart
  onAnswer: (requestId: string, approve: boolean, password?: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const permission = part.permission
  if (!permission) return null

  if (permission.state !== 'pending') {
    return (
      <p className={`permission-result is-${permission.state}`}>
        {permission.state === 'approved' ? 'You allowed this sudo command.' : 'Not allowed.'}
      </p>
    )
  }

  const answer = async (approve: boolean) => {
    setBusy(true)
    try {
      await onAnswer(permission.request_id, approve, approve ? password : undefined)
    } finally {
      setBusy(false)
      setPassword('')
    }
  }

  return (
    <form
      className="permission-prompt"
      onSubmit={(event) => {
        event.preventDefault()
        if (password) void answer(true)
      }}
    >
      <strong>The agent wants to run this with sudo</strong>
      <pre>{permission.command}</pre>
      {permission.reason ? <p>{permission.reason}</p> : null}
      <label>
        <span>Your sudo password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
          autoFocus
          aria-label="Sudo password"
          disabled={busy}
        />
      </label>
      <small>Used for this command only; it is never shown to the model or stored.</small>
      <div className="permission-actions">
        <button type="submit" className="send-button permission-approve" disabled={busy || !password}>
          Allow
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void answer(false)}
          disabled={busy}
        >
          Deny
        </button>
      </div>
    </form>
  )
}

export function ToolCard({
  part,
  onPermission,
}: {
  part: ToolPart
  onPermission: (requestId: string, approve: boolean, password?: string) => Promise<void>
}) {
  const detail = headline(part)
  const lastProgress = part.progress.at(-1)
  const waiting = part.permission?.state === 'pending'

  return (
    <div className={`tool-card is-${part.status}`}>
      <details open={waiting || undefined}>
        <summary>
          <span className="tool-status" aria-hidden="true" />
          <span className="tool-name">{LABELS[part.name] ?? part.name}</span>
          {detail ? <span className="tool-detail">{detail}</span> : null}
          <span className="tool-summary">
            {part.status === 'running'
              ? waiting
                ? 'waiting for you'
                : (lastProgress ?? 'running…')
              : part.summary}
          </span>
        </summary>
        <div className="tool-body">
          <p className="tool-label">Arguments</p>
          <pre>{shownArgs(part.args)}</pre>
          {part.progress.length ? (
            <>
              <p className="tool-label">Progress</p>
              <pre>{part.progress.join('\n')}</pre>
            </>
          ) : null}
          {part.output ? (
            <>
              <p className="tool-label">Result</p>
              <pre>{part.output}</pre>
            </>
          ) : null}
        </div>
      </details>
      <PermissionPrompt part={part} onAnswer={onPermission} />
    </div>
  )
}
