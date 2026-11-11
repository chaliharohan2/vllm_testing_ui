import type { GenerationSettings } from '../types'

interface SettingsPanelProps {
  settings: GenerationSettings
  models: string[]
  modelStatus: 'idle' | 'loading' | 'error'
  isOpen: boolean
  disabled: boolean
  onChange: (settings: GenerationSettings) => void
  onRefreshModels: () => void
  onClose: () => void
}

const numericValue = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function SettingsPanel({
  settings,
  models,
  modelStatus,
  isOpen,
  disabled,
  onChange,
  onRefreshModels,
  onClose,
}: SettingsPanelProps) {
  const update = <Key extends keyof GenerationSettings>(
    key: Key,
    value: GenerationSettings[Key],
  ) => onChange({ ...settings, [key]: value })

  return (
    <>
      <button
        className={`settings-backdrop ${isOpen ? 'is-visible' : ''}`}
        type="button"
        aria-label="Close settings"
        onClick={onClose}
      />
      <aside
        className={`settings-panel ${isOpen ? 'is-open' : ''}`}
        aria-label="Generation settings"
      >
        <div className="settings-heading">
          <div>
            <p className="eyebrow">Configuration</p>
            <h2>Model settings</h2>
          </div>
          <button
            className="icon-button close-settings"
            type="button"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-fields">
          <label>
            <span>API key</span>
            <input
              aria-label="API key"
              type="password"
              value={settings.apiKey}
              onChange={(event) => update('apiKey', event.target.value)}
              placeholder="Leave empty if the server has no key"
              autoComplete="off"
              disabled={disabled}
            />
            <small>
              Sent as a Bearer token when set. Kept in memory only.
            </small>
          </label>

          <label>
            <span>Model</span>
            <div className="model-field">
              <input
                aria-label="Model"
                list="available-models"
                value={settings.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder="Enter a model ID"
                disabled={disabled}
              />
              <button
                className="secondary-button refresh-button"
                type="button"
                onClick={onRefreshModels}
                disabled={disabled || modelStatus === 'loading'}
                aria-label="Refresh models"
              >
                {modelStatus === 'loading' ? '…' : '↻'}
              </button>
            </div>
            <datalist id="available-models">
              {models.map((model) => (
                <option value={model} key={model} />
              ))}
            </datalist>
            <small>
              {modelStatus === 'error'
                ? 'Model list unavailable; enter an ID manually.'
                : `${models.length} model${models.length === 1 ? '' : 's'} available`}
            </small>
          </label>

          <label className="toggle-field">
            <input
              type="checkbox"
              checked={settings.enableThinking}
              onChange={(event) =>
                update('enableThinking', event.target.checked)
              }
              disabled={disabled}
            />
            <span>Thinking mode</span>
            <small>
              Reasoning models spend the token budget on thinking before
              answering. Leave this off for faster, direct replies.
            </small>
          </label>

          <label>
            <span>Working folder</span>
            <input
              aria-label="Working folder"
              value={settings.workdir}
              onChange={(event) => update('workdir', event.target.value)}
              placeholder="workspace/ in this repo"
              disabled={disabled}
            />
            <small>
              Absolute path the file and terminal tools work in. File tools
              cannot reach outside it.
            </small>
          </label>

          <label>
            <span>Max tool steps per message</span>
            <input
              aria-label="Max tool steps"
              type="number"
              min="1"
              max="100"
              step="1"
              value={settings.maxSteps}
              onChange={(event) =>
                update('maxSteps', numericValue(event.target.value, settings.maxSteps))
              }
              disabled={disabled}
            />
          </label>

          <label>
            <span>System prompt</span>
            <textarea
              rows={5}
              value={settings.systemPrompt}
              onChange={(event) => update('systemPrompt', event.target.value)}
              placeholder="You are a helpful assistant."
              disabled={disabled}
            />
          </label>

          <div className="field-grid">
            <label>
              <span>Temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={settings.temperature}
                onChange={(event) =>
                  update(
                    'temperature',
                    numericValue(event.target.value, settings.temperature),
                  )
                }
                disabled={disabled}
              />
            </label>
            <label>
              <span>Max tokens</span>
              <input
                type="number"
                min="1"
                step="1"
                value={settings.maxTokens}
                onChange={(event) =>
                  update(
                    'maxTokens',
                    numericValue(event.target.value, settings.maxTokens),
                  )
                }
                disabled={disabled}
              />
            </label>
            <label>
              <span>Top P</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={settings.topP}
                onChange={(event) =>
                  update('topP', numericValue(event.target.value, settings.topP))
                }
                disabled={disabled}
              />
            </label>
            <label>
              <span>Top K</span>
              <input
                type="number"
                min="-1"
                step="1"
                value={settings.topK}
                onChange={(event) =>
                  update('topK', numericValue(event.target.value, settings.topK))
                }
                disabled={disabled}
              />
            </label>
            <label>
              <span>Min P</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={settings.minP}
                onChange={(event) =>
                  update('minP', numericValue(event.target.value, settings.minP))
                }
                disabled={disabled}
              />
            </label>
            <label>
              <span>Repetition</span>
              <input
                type="number"
                min="0"
                step="0.05"
                value={settings.repetitionPenalty}
                onChange={(event) =>
                  update(
                    'repetitionPenalty',
                    numericValue(
                      event.target.value,
                      settings.repetitionPenalty,
                    ),
                  )
                }
                disabled={disabled}
              />
            </label>
          </div>

          <label>
            <span>Seed</span>
            <input
              type="number"
              step="1"
              value={settings.seed}
              onChange={(event) => update('seed', event.target.value)}
              placeholder="Random"
              disabled={disabled}
            />
          </label>

          <label>
            <span>Stop sequences</span>
            <textarea
              rows={3}
              value={settings.stop}
              onChange={(event) => update('stop', event.target.value)}
              placeholder={'One sequence per line'}
              disabled={disabled}
            />
          </label>
        </div>
      </aside>
    </>
  )
}
