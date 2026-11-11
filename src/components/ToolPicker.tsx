import type { ToolGroup } from '../types'

export function ToolPicker({
  groups,
  selected,
  disabled,
  showBrowser,
  onToggle,
  onShowBrowser,
}: {
  groups: ToolGroup[]
  selected: string[]
  disabled: boolean
  showBrowser: boolean
  onToggle: (groupId: string) => void
  onShowBrowser: (value: boolean) => void
}) {
  if (!groups.length) return null

  return (
    <div className="tool-picker" role="group" aria-label="Tools">
      <span className="tool-picker-label">Tools</span>
      {groups.map((group) => {
        const on = selected.includes(group.id)
        return (
          <button
            key={group.id}
            className={`browser-toggle ${on ? 'is-on' : ''}`}
            type="button"
            aria-pressed={on}
            title={group.description}
            onClick={() => onToggle(group.id)}
            disabled={disabled}
          >
            {group.label}
          </button>
        )
      })}
      {selected.includes('browser') ? (
        <label className="browser-window-toggle">
          <input
            type="checkbox"
            checked={showBrowser}
            onChange={(event) => onShowBrowser(event.target.checked)}
            disabled={disabled}
          />
          Show window
        </label>
      ) : null}
    </div>
  )
}
