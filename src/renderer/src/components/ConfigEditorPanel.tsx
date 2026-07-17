import {
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  EditableConfigState
} from '@shared/config'
import { getErrorMessage } from '../utils/errors'
import {
  createConfigInput,
  createDraft,
  getFieldError,
  type BootstrapHookDraft,
  type ConfigDraft,
  type ConfigSaveResult
} from '../utils/configDraft'

export function ConfigEditorPanel({
  open,
  config,
  loadError,
  onClose,
  onReload,
  onSave
}: {
  open: boolean
  config: EditableConfigState | null
  loadError: string | null
  onClose: () => void
  onReload: () => Promise<void>
  onSave: (input: CommonConfigUpdateInput) => Promise<ConfigSaveResult>
}): ReactElement {
  const [draft, setDraft] = useState<ConfigDraft>(() => createDraft(config))
  const [fieldErrors, setFieldErrors] = useState<ConfigFieldError[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const [showReloadAction, setShowReloadAction] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasOpenRef = useRef(open)

  useEffect(() => {
    setDraft(createDraft(config))
    setFieldErrors([])
  }, [config])

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const firstField = dialogRef.current?.querySelector<HTMLElement>(
        '.config-panel input, .config-panel select, .config-panel textarea'
      )
      ;(firstField ?? closeButtonRef.current)?.focus()
    }
    wasOpenRef.current = open
  }, [open])

  const errorsByField = new Map(fieldErrors.map((error) => [error.field, error.message]))

  async function handleSave(): Promise<void> {
    if (config === null || loadError !== null) {
      return
    }

    setIsSaving(true)
    setStatusMessage(null)
    setFieldErrors([])

    try {
      const inputResult = createConfigInput(draft)
      if (!inputResult.ok) {
        setFieldErrors(inputResult.errors)
        setShowReloadAction(false)
        return
      }

      const result = await onSave(inputResult.input)
      setFieldErrors(result.errors)
      setStatusMessage(result.message ?? (result.errors.length === 0 ? 'Config saved' : null))
      setShowReloadAction(result.canReload)
    } catch (error: unknown) {
      setStatusMessage(getErrorMessage(error))
      setShowReloadAction(false)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleReload(): Promise<void> {
    setIsReloading(true)
    setStatusMessage(null)

    try {
      await onReload()
      setStatusMessage('Config reloaded')
      setShowReloadAction(false)
    } catch (error: unknown) {
      setStatusMessage(getErrorMessage(error))
      setShowReloadAction(true)
    } finally {
      setIsReloading(false)
    }
  }

  function getFocusableElements(): HTMLElement[] {
    if (dialogRef.current === null) {
      return []
    }

    return [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
    )].filter((element) => !element.classList.contains('focus-sentinel'))
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const focusable = getFocusableElements()
    const firstElement = focusable[0]
    const lastElement = focusable[focusable.length - 1]

    if (firstElement === undefined || lastElement === undefined) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
      return
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  return (
    <div className="modal-backdrop" hidden={!open}>
      <div
        aria-labelledby="config-dialog-title"
        aria-modal="true"
        className="modal-dialog config-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <span
          className="focus-sentinel"
          data-focus-sentinel="true"
          onFocus={() => getFocusableElements().at(-1)?.focus()}
          tabIndex={0}
        />
        <div className="modal-header">
          <h2 id="config-dialog-title">Common Config</h2>
        </div>

        <div className="config-panel">
          {loadError !== null ? (
            <div className="form-message error-message" role="alert">
              {loadError}
            </div>
          ) : null}

          {config === null && loadError === null ? (
            <div className="form-message" role="status">
              Loading config
            </div>
          ) : null}

          <PathListEditor
            label="Scan roots"
            fieldName="scan_roots"
            values={draft.scan_roots}
            errorsByField={errorsByField}
            onChange={(scanRoots) => setDraft({ ...draft, scan_roots: scanRoots })}
          />

          <PathListEditor
            label="Explicit repositories"
            fieldName="repos"
            values={draft.repos}
            errorsByField={errorsByField}
            onChange={(repos) => setDraft({ ...draft, repos })}
          />

          <label className="form-field">
            <span>Default agent</span>
            <select
              aria-label="Default agent"
              value={draft.default_agent}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  default_agent: event.currentTarget.value as ConfigDraft['default_agent']
                })
              }
            >
              <option value="">No default</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
            <FieldError message={errorsByField.get('default_agent')} />
          </label>

          <label className="form-field">
            <span>Artifact root</span>
            <input
              aria-label="Artifact root"
              value={draft.artifact_root}
              onChange={(event) => setDraft({ ...draft, artifact_root: event.currentTarget.value })}
            />
            <FieldError message={errorsByField.get('artifact_root')} />
          </label>

          <BootstrapHookEditor
            hooks={draft.bootstrap_hooks}
            errorsByField={errorsByField}
          />

          {statusMessage !== null ? (
            <div className="form-message" role={fieldErrors.length > 0 ? 'alert' : 'status'}>
              {statusMessage}
            </div>
          ) : null}

          {showReloadAction ? (
            <button
              className="secondary-button reload-button"
              type="button"
              onClick={() => void handleReload()}
            >
              <RotateCcw aria-hidden="true" size={16} />
              <span>{isReloading ? 'Reloading config' : 'Reload config'}</span>
            </button>
          ) : null}

          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              <X aria-hidden="true" size={16} />
              <span>Cancel</span>
            </button>
            <button
              className="primary-button"
              disabled={config === null || loadError !== null || isSaving}
              type="button"
              onClick={() => void handleSave()}
            >
              <Save aria-hidden="true" size={16} />
              <span>{isSaving ? 'Saving' : 'Save'}</span>
            </button>
          </div>
        </div>

        <button
          aria-label="Close config"
          className="icon-button modal-close-button"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
        <span
          className="focus-sentinel"
          data-focus-sentinel="true"
          onFocus={() => getFocusableElements()[0]?.focus()}
          tabIndex={0}
        />
      </div>
    </div>
  )
}

function PathListEditor({
  label,
  fieldName,
  values,
  errorsByField,
  onChange
}: {
  label: string
  fieldName: 'scan_roots' | 'repos'
  values: string[]
  errorsByField: Map<string, string>
  onChange: (values: string[]) => void
}): ReactElement {
  const itemLabel = fieldName === 'scan_roots' ? 'Scan root' : 'Repository'

  return (
    <fieldset className="form-group">
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div className="list-field" key={`${fieldName}-${index}`}>
          <label className="form-field">
            <span>{`${itemLabel} ${index + 1}`}</span>
            <input
              aria-label={`${itemLabel} ${index + 1}`}
              value={value}
              onChange={(event) => {
                const nextValues = [...values]
                nextValues[index] = event.currentTarget.value
                onChange(nextValues)
              }}
            />
            <FieldError message={errorsByField.get(`${fieldName}[${index}]`)} />
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, currentIndex) => currentIndex !== index))}
          >
            <Trash2 aria-hidden="true" size={16} />
          </button>
        </div>
      ))}
      <button className="secondary-button" type="button" onClick={() => onChange([...values, ''])}>
        <Plus aria-hidden="true" size={16} />
        <span>{`Add ${itemLabel.toLowerCase()}`}</span>
      </button>
      <FieldError message={errorsByField.get(fieldName)} />
    </fieldset>
  )
}

function BootstrapHookEditor({
  hooks,
  errorsByField
}: {
  hooks: BootstrapHookDraft[]
  errorsByField: Map<string, string>
}): ReactElement {
  return (
    <fieldset className="form-group">
      <legend>Bootstrap hooks</legend>
      {hooks.map((hook, index) => (
        <div className="hook-editor" key={`hook-${index}`}>
          <div className="hook-header">
            <span>{`Hook ${index + 1}`}</span>
          </div>
          <HookField
            label={`Hook ${index + 1} command`}
            value={hook.command}
            error={errorsByField.get(`bootstrap_hooks[${index}].command`)}
          />
          <HookField
            label={`Hook ${index + 1} name`}
            value={hook.name}
            error={errorsByField.get(`bootstrap_hooks[${index}].name`)}
          />
          <HookField
            label={`Hook ${index + 1} cwd`}
            value={hook.cwd}
            error={errorsByField.get(`bootstrap_hooks[${index}].cwd`)}
          />
          <label className="form-field">
            <span>{`Hook ${index + 1} environment`}</span>
            <textarea
              aria-label={`Hook ${index + 1} environment`}
              readOnly
              value={hook.env}
            />
            <FieldError message={getFieldError(errorsByField, `bootstrap_hooks[${index}].env`)} />
          </label>
        </div>
      ))}
    </fieldset>
  )
}

function HookField({
  label,
  value,
  error
}: {
  label: string
  value: string
  error: string | undefined
}): ReactElement {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        aria-label={label}
        readOnly
        value={value}
      />
      <FieldError message={error} />
    </label>
  )
}

function FieldError({ message }: { message: string | undefined }): ReactElement | null {
  return message === undefined ? null : <span className="field-error">{message}</span>
}
