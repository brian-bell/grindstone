import {
  CirclePlus,
  GitBranch,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { resolveMiddlePaneRoute } from '@shared/middlePane'
import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  EditableBootstrapHook,
  EditableConfigState
} from '@shared/config'
import type {
  CatalogDiagnostic,
  FlowPaneState,
  InitialWorkspaceState,
  RepositoryPaneState,
  RepositoryRow
} from '@shared/workspace'
import { defaultInitialWorkspaceState } from '@shared/workspace'

type RightPaneMode = 'hints' | 'config'

type ConfigDraft = {
  scan_roots: string[]
  repos: string[]
  default_agent: '' | 'codex' | 'claude'
  artifact_root: string
  bootstrap_hooks: BootstrapHookDraft[]
}

type BootstrapHookDraft = {
  name: string
  command: string
  cwd: string
  env: string
}

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<InitialWorkspaceState | null>(null)
  const [routeResolution] = useState(() => resolveMiddlePaneRoute(getRendererPath()))
  const routeFlowState = 'flowState' in routeResolution ? routeResolution.flowState : null
  const [flowState, setFlowState] = useState<FlowPaneState>(
    routeFlowState ?? { status: 'loading' }
  )
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>('hints')
  const [editableConfig, setEditableConfig] = useState<EditableConfigState | null>(null)
  const [configLoadError, setConfigLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.grindstone.workspace
      .getInitialState()
      .then((initialState) => {
        if (!cancelled) {
          setWorkspace(initialState)
          setFlowState(routeFlowState ?? initialState.flow)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWorkspace(defaultInitialWorkspaceState)
          setFlowState({
            status: 'error',
            message: getErrorMessage(error)
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [routeFlowState])

  useEffect(() => {
    let cancelled = false

    window.grindstone.config
      .getEditableConfig()
      .then((config) => {
        if (!cancelled) {
          setEditableConfig(config)
          setConfigLoadError(null)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigLoadError(getErrorMessage(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const shellState = workspace ?? defaultInitialWorkspaceState
  const isWorkspaceLoading = workspace === null

  async function handleRepositorySelect(repositoryId: string): Promise<void> {
    try {
      const nextWorkspace = await window.grindstone.workspace.selectRepository({
        repositoryId
      })
      setWorkspace(nextWorkspace)
      setFlowState(routeFlowState ?? nextWorkspace.flow)
    } catch (error: unknown) {
      setFlowState({
        status: 'error',
        message: getErrorMessage(error)
      })
    }
  }

  async function handleConfigSave(input: CommonConfigUpdateInput): Promise<{
    errors: ConfigFieldError[]
    message: string | null
  }> {
    const response = await window.grindstone.config.updateCommonConfig(input)

    if (response.ok) {
      setWorkspace(response.workspace)
      setEditableConfig(response.config)
      setFlowState(routeFlowState ?? response.workspace.flow)
      return { errors: [], message: null }
    }

    if (response.kind === 'validation') {
      return { errors: response.errors, message: null }
    }

    if (response.config !== undefined) {
      setEditableConfig(response.config)
    }

    return {
      errors: [],
      message: `Config saved to ${response.configPath}, but reload failed: ${response.message}`
    }
  }

  return (
    <div className="app-shell">
      <section
        className="pane repository-pane"
        aria-labelledby="repository-pane-title"
      >
        <div className="pane-header">
          <GitBranch aria-hidden="true" size={18} />
          <h2 id="repository-pane-title">Repository Area</h2>
        </div>
        <RepositoryCatalogView
          isLoading={isWorkspaceLoading}
          repository={shellState.repository}
          onSelect={handleRepositorySelect}
          onConfigure={() => setRightPaneMode('config')}
        />
      </section>

      <main
        className="pane flow-pane"
        aria-labelledby="flow-workspace-title"
      >
        <div className="pane-header">
          <Sparkles aria-hidden="true" size={18} />
          <h1 id="flow-workspace-title">Flow Workspace</h1>
        </div>
        <FlowWorkspaceStateView state={flowState} />
      </main>

      <section
        className="pane context-pane"
        aria-labelledby="context-pane-title"
      >
        {rightPaneMode === 'config' ? (
          <ConfigEditorPanel
            config={editableConfig}
            loadError={configLoadError}
            onCancel={() => setRightPaneMode('hints')}
            onSave={handleConfigSave}
          />
        ) : (
          <ContextHintsPanel workspace={shellState} />
        )}
      </section>
    </div>
  )
}

function RepositoryCatalogView({
  isLoading,
  repository,
  onSelect,
  onConfigure
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  onSelect: (repositoryId: string) => Promise<void>
  onConfigure: () => void
}): ReactElement {
  if (isLoading) {
    return (
      <div
        className="repository-summary"
        role="status"
        aria-label="Repository catalog loading"
      >
        <p className="eyebrow">Repository</p>
        <h3>Loading repositories</h3>
        <p>Reading configured scan roots and explicit repositories.</p>
      </div>
    )
  }

  return (
    <div className="repository-catalog">
      <div className="repository-summary">
        <p className="eyebrow">Repository</p>
        <h3>{repository.title}</h3>
        <p>{repository.description}</p>
        <button className="configure-button" type="button" onClick={onConfigure}>
          <Settings aria-hidden="true" size={16} />
          <span>Configure</span>
        </button>
      </div>

      {repository.repositories.length > 0 ? (
        <div className="repository-list" aria-label="Configured repositories">
          {repository.repositories.map((row) => (
            <RepositoryRowButton
              isSelected={row.id === repository.selectedRepositoryId}
              key={row.id}
              repository={row}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      {repository.diagnostics.length > 0 ? (
        <div className="diagnostic-list" aria-label="Repository diagnostics">
          {repository.diagnostics.map((diagnostic) => (
            <CatalogDiagnosticRow
              diagnostic={diagnostic}
              key={`${diagnostic.code}:${diagnostic.configuredPath}:${diagnostic.resolvedPath}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RepositoryRowButton({
  isSelected,
  repository,
  onSelect
}: {
  isSelected: boolean
  repository: RepositoryRow
  onSelect: (repositoryId: string) => Promise<void>
}): ReactElement {
  return (
    <button
      aria-pressed={isSelected}
      className="repository-row"
      onClick={() => void onSelect(repository.id)}
      type="button"
    >
      <span className="repository-row-main">
        <span className="repository-name">{repository.name}</span>
        <span className="repository-path">{repository.path}</span>
      </span>
      <span className="repository-sources">{repository.sources.join(', ')}</span>
    </button>
  )
}

function CatalogDiagnosticRow({
  diagnostic
}: {
  diagnostic: CatalogDiagnostic
}): ReactElement {
  return (
    <div className="diagnostic-row" role="alert">
      <span className="diagnostic-code">{diagnostic.code}</span>
      <span className="diagnostic-message">{diagnostic.message}</span>
      <span className="diagnostic-path">{diagnostic.configuredPath}</span>
    </div>
  )
}

function ContextHintsPanel({ workspace }: { workspace: InitialWorkspaceState }): ReactElement {
  return (
    <>
      <div className="pane-header">
        <Sparkles aria-hidden="true" size={18} />
        <h2 id="context-pane-title">Contextual Hints</h2>
      </div>

      <div className="hint-list">
        {workspace.hints.map((hint) => (
          <article className="hint-row" key={hint.id}>
            <h3>{hint.title}</h3>
            <p>{hint.description}</p>
          </article>
        ))}
      </div>

      <div className="shortcut-list" aria-label="Flow shortcuts">
        {workspace.shortcuts.map((shortcut) => (
          <button
            className="shortcut-button"
            disabled={shortcut.disabled}
            key={shortcut.id}
            title={shortcut.description}
            type="button"
          >
            {shortcut.id === 'new-flow' ? (
              <CirclePlus aria-hidden="true" size={16} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}
            <span>{shortcut.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function ConfigEditorPanel({
  config,
  loadError,
  onCancel,
  onSave
}: {
  config: EditableConfigState | null
  loadError: string | null
  onCancel: () => void
  onSave: (input: CommonConfigUpdateInput) => Promise<{
    errors: ConfigFieldError[]
    message: string | null
  }>
}): ReactElement {
  const [draft, setDraft] = useState<ConfigDraft>(() => createDraft(config))
  const [fieldErrors, setFieldErrors] = useState<ConfigFieldError[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setDraft(createDraft(config))
    setFieldErrors([])
  }, [config])

  const errorsByField = new Map(fieldErrors.map((error) => [error.field, error.message]))

  async function handleSave(): Promise<void> {
    setIsSaving(true)
    setStatusMessage(null)
    setFieldErrors([])

    try {
      const result = await onSave(createConfigInput(draft))
      setFieldErrors(result.errors)
      setStatusMessage(result.message ?? (result.errors.length === 0 ? 'Config saved' : null))
    } catch (error: unknown) {
      setStatusMessage(getErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <div className="pane-header config-header">
        <Settings aria-hidden="true" size={18} />
        <h2 id="context-pane-title">Common Config</h2>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close config">
          <X aria-hidden="true" size={16} />
        </button>
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
          onChange={(bootstrapHooks) =>
            setDraft({ ...draft, bootstrap_hooks: bootstrapHooks })
          }
        />

        {statusMessage !== null ? (
          <div className="form-message" role={fieldErrors.length > 0 ? 'alert' : 'status'}>
            {statusMessage}
          </div>
        ) : null}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            <X aria-hidden="true" size={16} />
            <span>Cancel</span>
          </button>
          <button className="primary-button" type="button" onClick={() => void handleSave()}>
            <Save aria-hidden="true" size={16} />
            <span>{isSaving ? 'Saving' : 'Save'}</span>
          </button>
        </div>
      </div>
    </>
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
  errorsByField,
  onChange
}: {
  hooks: BootstrapHookDraft[]
  errorsByField: Map<string, string>
  onChange: (hooks: BootstrapHookDraft[]) => void
}): ReactElement {
  return (
    <fieldset className="form-group">
      <legend>Bootstrap hooks</legend>
      {hooks.map((hook, index) => (
        <div className="hook-editor" key={`hook-${index}`}>
          <div className="hook-header">
            <span>{`Hook ${index + 1}`}</span>
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove hook ${index + 1}`}
              onClick={() => onChange(hooks.filter((_, currentIndex) => currentIndex !== index))}
            >
              <Trash2 aria-hidden="true" size={16} />
            </button>
          </div>
          <HookField
            label={`Hook ${index + 1} command`}
            value={hook.command}
            error={errorsByField.get(`bootstrap_hooks[${index}].command`)}
            onChange={(value) => replaceHook(hooks, index, { ...hook, command: value }, onChange)}
          />
          <HookField
            label={`Hook ${index + 1} name`}
            value={hook.name}
            error={errorsByField.get(`bootstrap_hooks[${index}].name`)}
            onChange={(value) => replaceHook(hooks, index, { ...hook, name: value }, onChange)}
          />
          <HookField
            label={`Hook ${index + 1} cwd`}
            value={hook.cwd}
            error={errorsByField.get(`bootstrap_hooks[${index}].cwd`)}
            onChange={(value) => replaceHook(hooks, index, { ...hook, cwd: value }, onChange)}
          />
          <label className="form-field">
            <span>{`Hook ${index + 1} environment`}</span>
            <textarea
              aria-label={`Hook ${index + 1} environment`}
              value={hook.env}
              onChange={(event) =>
                replaceHook(hooks, index, { ...hook, env: event.currentTarget.value }, onChange)
              }
            />
            <FieldError message={errorsByField.get(`bootstrap_hooks[${index}].env`)} />
          </label>
        </div>
      ))}
      <button
        className="secondary-button"
        type="button"
        onClick={() => onChange([...hooks, { name: '', command: '', cwd: '', env: '' }])}
      >
        <Plus aria-hidden="true" size={16} />
        <span>Add hook</span>
      </button>
    </fieldset>
  )
}

function HookField({
  label,
  value,
  error,
  onChange
}: {
  label: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}): ReactElement {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <FieldError message={error} />
    </label>
  )
}

function FieldError({ message }: { message: string | undefined }): ReactElement | null {
  return message === undefined ? null : <span className="field-error">{message}</span>
}

function createDraft(config: EditableConfigState | null): ConfigDraft {
  return {
    scan_roots: config?.scan_roots ?? [],
    repos: config?.repos ?? [],
    default_agent: config?.default_agent ?? '',
    artifact_root: config?.artifact_root ?? '',
    bootstrap_hooks: (config?.bootstrap_hooks ?? []).map((hook) => ({
      name: hook.name ?? '',
      command: hook.command,
      cwd: hook.cwd ?? '',
      env: formatEnv(hook.env)
    }))
  }
}

function createConfigInput(draft: ConfigDraft): CommonConfigUpdateInput {
  return {
    scan_roots: draft.scan_roots,
    repos: draft.repos,
    default_agent: draft.default_agent === '' ? null : draft.default_agent,
    artifact_root: draft.artifact_root.trim() === '' ? null : draft.artifact_root,
    bootstrap_hooks: draft.bootstrap_hooks.map((hook) => {
      const nextHook: EditableBootstrapHook = {
        command: hook.command
      }

      if (hook.name.trim() !== '') {
        nextHook.name = hook.name
      }

      if (hook.cwd.trim() !== '') {
        nextHook.cwd = hook.cwd
      }

      const env = parseEnv(hook.env)
      if (Object.keys(env).length > 0) {
        nextHook.env = env
      }

      return nextHook
    })
  }
}

function replaceHook(
  hooks: BootstrapHookDraft[],
  index: number,
  hook: BootstrapHookDraft,
  onChange: (hooks: BootstrapHookDraft[]) => void
): void {
  const nextHooks = [...hooks]
  nextHooks[index] = hook
  onChange(nextHooks)
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (env === undefined) {
    return ''
  }

  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function parseEnv(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line.includes('='))
      .map((line) => {
        const separatorIndex = line.indexOf('=')
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)]
      })
  )
}

function getRendererPath(): string {
  if (window.location.protocol === 'file:') {
    return '/'
  }

  if (window.location.pathname.endsWith('/index.html')) {
    return '/'
  }

  return window.location.pathname || '/'
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }

  return 'Unable to load Flow workspace'
}

function FlowWorkspaceStateView({ state }: { state: FlowPaneState }): ReactElement {
  if (state.status === 'loading') {
    return (
      <div
        className="state-block"
        role="status"
        aria-label="Flow workspace loading"
      >
        <p className="eyebrow">Flow</p>
        <h2>Loading Flow workspace</h2>
        <p>Preparing the Flow-only workspace surface.</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        className="state-block error-block"
        role="alert"
        aria-label="Flow workspace error"
      >
        <p className="eyebrow">Flow</p>
        <h2>Flow workspace unavailable</h2>
        <p>{state.message}</p>
      </div>
    )
  }

  return (
    <div className="state-block">
      <p className="eyebrow">Flow</p>
      <h2>{state.title}</h2>
      <p>{state.description}</p>
    </div>
  )
}
