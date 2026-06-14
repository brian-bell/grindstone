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
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { resolveMiddlePaneRoute } from '@shared/middlePane'
import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  EditableBootstrapHook,
  EditableConfigState
} from '@shared/config'
import type {
  CatalogDiagnostic,
  CreateFlowRequest,
  FlowPaneState,
  GitHubVisibility,
  InitialWorkspaceState,
  RepositoryCreateState,
  RepositoryRemoteRetryRecord,
  RepositoryPaneState,
  RepositoryRow
} from '@shared/workspace'
import { defaultInitialWorkspaceState } from '@shared/workspace'

type RightPaneMode = 'hints' | 'config'

type ConfigSaveResult = {
  errors: ConfigFieldError[]
  message: string | null
  canReload: boolean
}

type ConfigDraft = {
  scan_roots: string[]
  repos: string[]
  default_agent: '' | 'codex' | 'claude'
  artifact_root: string
  bootstrap_hooks: BootstrapHookDraft[]
}

type ConfigInputResult =
  | {
    ok: true
    input: CommonConfigUpdateInput
  }
  | {
    ok: false
    errors: ConfigFieldError[]
  }

type BootstrapHookDraft = {
  sourceIndex?: number
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
  const selectionRequestIdRef = useRef(0)
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

  async function handleRepositorySelect(repository: RepositoryRow): Promise<void> {
    const requestId = selectionRequestIdRef.current + 1
    selectionRequestIdRef.current = requestId

    if (routeFlowState === null) {
      setFlowState({
        status: 'loading',
        repositoryId: repository.id,
        repositoryName: repository.name
      })
    }

    try {
      const nextWorkspace = await window.grindstone.workspace.selectRepository({
        repositoryId: repository.id
      })
      if (requestId !== selectionRequestIdRef.current) {
        return
      }

      applyWorkspace(nextWorkspace)
    } catch (error: unknown) {
      if (requestId !== selectionRequestIdRef.current) {
        return
      }

      setFlowState({
        status: 'error',
        message: getErrorMessage(error),
        repositoryId: repository.id,
        repositoryName: repository.name
      })
    }
  }

  function applyWorkspace(nextWorkspace: InitialWorkspaceState): void {
    setWorkspace(nextWorkspace)
    setFlowState(routeFlowState ?? nextWorkspace.flow)
  }

  async function handleConfigReload(): Promise<void> {
    const [nextWorkspace, nextConfig] = await Promise.all([
      window.grindstone.workspace.getInitialState(),
      window.grindstone.config.getEditableConfig()
    ])

    setWorkspace(nextWorkspace)
    setEditableConfig(nextConfig)
    setFlowState(routeFlowState ?? nextWorkspace.flow)
  }

  async function handleConfigSave(input: CommonConfigUpdateInput): Promise<ConfigSaveResult> {
    const response = await window.grindstone.config.updateCommonConfig(input)

    if (response.ok) {
      setWorkspace(response.workspace)
      setEditableConfig(response.config)
      setFlowState(routeFlowState ?? response.workspace.flow)
      return { errors: [], message: null, canReload: false }
    }

    if (response.kind === 'validation') {
      return { errors: response.errors, message: null, canReload: false }
    }

    if (response.config !== undefined) {
      setEditableConfig(response.config)
    }

    return {
      errors: [],
      message: `Config saved to ${response.configPath}, but reload failed: ${response.message}`,
      canReload: true
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
          onWorkspaceUpdate={applyWorkspace}
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
        <FlowWorkspaceStateView
          state={flowState}
          onWorkspaceUpdate={applyWorkspace}
        />
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
            onReload={handleConfigReload}
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
  onConfigure,
  onWorkspaceUpdate
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  onSelect: (repository: RepositoryRow) => Promise<void>
  onConfigure: () => void
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
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

      <RepositoryCreatePanel
        create={repository.create}
        onWorkspaceUpdate={onWorkspaceUpdate}
      />

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

function RepositoryCreatePanel({
  create,
  onWorkspaceUpdate
}: {
  create: RepositoryCreateState
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [scanRootId, setScanRootId] = useState(create.scanRoots[0]?.id ?? '')
  const [name, setName] = useState('')
  const [githubEnabled, setGithubEnabled] = useState(false)
  const [visibility, setVisibility] = useState<GitHubVisibility>('private')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const isAvailable = create.available && create.scanRoots.length > 0

  useEffect(() => {
    if (!create.scanRoots.some((scanRoot) => scanRoot.id === scanRootId)) {
      setScanRootId(create.scanRoots[0]?.id ?? '')
    }
  }, [create.scanRoots, scanRootId])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setLocalError('Repository name is required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createRepository({
        scanRootId,
        name: trimmedName,
        github: {
          enabled: githubEnabled,
          visibility
        }
      })
      onWorkspaceUpdate(nextWorkspace)
      if (nextWorkspace.repository.create.error === null) {
        setName('')
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRetry(retry: RepositoryRemoteRetryRecord): Promise<void> {
    setRetryingId(retry.id)
    setLocalError(null)
    try {
      const nextWorkspace = await window.grindstone.workspace.retryRepositoryRemote({
        retryId: retry.id
      })
      onWorkspaceUpdate(nextWorkspace)
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setRetryingId(null)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <div className="repository-create">
      <form
        aria-label="Create repository"
        className="repository-create-form"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <label className="field">
          <span>Scan root</span>
          <select
            disabled={!isAvailable || isSubmitting}
            onChange={(event) => setScanRootId(event.target.value)}
            value={scanRootId}
          >
            {create.scanRoots.length === 0 ? (
              <option value="">No scan roots configured</option>
            ) : (
              create.scanRoots.map((scanRoot) => (
                <option
                  key={scanRoot.id}
                  value={scanRoot.id}
                >
                  {scanRoot.displayPath}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="field">
          <span>Repository name</span>
          <input
            disabled={!isAvailable || isSubmitting}
            onChange={(event) => setName(event.target.value)}
            placeholder="new-repo"
            type="text"
            value={name}
          />
        </label>

        <label className="checkbox-field">
          <input
            checked={githubEnabled}
            disabled={!isAvailable || isSubmitting}
            onChange={(event) => setGithubEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Create on GitHub</span>
        </label>

        <label className="field">
          <span>GitHub visibility</span>
          <select
            disabled={!isAvailable || !githubEnabled || isSubmitting}
            onChange={(event) => setVisibility(event.target.value as GitHubVisibility)}
            value={visibility}
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </label>

        {errorMessage !== null ? (
          <div
            aria-label="Repository creation error"
            className="create-error"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        <button
          className="primary-action"
          disabled={!isAvailable || isSubmitting || name.trim() === ''}
          type="submit"
        >
          <CirclePlus aria-hidden="true" size={16} />
          <span>{isSubmitting ? 'Creating' : 'Create repository'}</span>
        </button>
      </form>

      {create.remoteRetries.length > 0 ? (
        <div
          aria-label="Repository remote retries"
          className="remote-retry-list"
        >
          {create.remoteRetries.map((retry) => (
            <RemoteRetryRow
              key={retry.id}
              retry={retry}
              isRetrying={retryingId === retry.id}
              onRetry={handleRetry}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RemoteRetryRow({
  retry,
  isRetrying,
  onRetry
}: {
  retry: RepositoryRemoteRetryRecord
  isRetrying: boolean
  onRetry: (retry: RepositoryRemoteRetryRecord) => Promise<void>
}): ReactElement {
  const isSucceeded = retry.status === 'succeeded'

  return (
    <div className="remote-retry-row">
      <GitBranch aria-hidden="true" size={16} />
      <span className="remote-retry-copy">
        <span className="remote-retry-name">{retry.githubRepositoryName}</span>
        <span className="remote-retry-status">
          {isSucceeded ? 'Remote setup succeeded' : retry.lastError}
        </span>
      </span>
      <button
        aria-label={`Retry remote for ${retry.githubRepositoryName}`}
        className="icon-action"
        disabled={isSucceeded || isRetrying}
        onClick={() => void onRetry(retry)}
        title={`Retry remote for ${retry.githubRepositoryName}`}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={15} />
      </button>
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
  onSelect: (repository: RepositoryRow) => Promise<void>
}): ReactElement {
  return (
    <button
      aria-pressed={isSelected}
      className="repository-row"
      onClick={() => void onSelect(repository)}
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
  onReload,
  onSave
}: {
  config: EditableConfigState | null
  loadError: string | null
  onCancel: () => void
  onReload: () => Promise<void>
  onSave: (input: CommonConfigUpdateInput) => Promise<ConfigSaveResult>
}): ReactElement {
  const [draft, setDraft] = useState<ConfigDraft>(() => createDraft(config))
  const [fieldErrors, setFieldErrors] = useState<ConfigFieldError[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const [showReloadAction, setShowReloadAction] = useState(false)

  useEffect(() => {
    setDraft(createDraft(config))
    setFieldErrors([])
  }, [config])

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
          <button className="secondary-button" type="button" onClick={onCancel}>
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
            <FieldError message={getFieldError(errorsByField, `bootstrap_hooks[${index}].env`)} />
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
      sourceIndex: hook.sourceIndex,
      name: hook.name ?? '',
      command: hook.command,
      cwd: hook.cwd ?? '',
      env: formatEnv(hook.env)
    }))
  }
}

function createConfigInput(draft: ConfigDraft): ConfigInputResult {
  const errors: ConfigFieldError[] = []
  const bootstrapHooks = draft.bootstrap_hooks.map((hook, index) => {
    const nextHook: EditableBootstrapHook = {
      command: hook.command
    }

    if (hook.sourceIndex !== undefined) {
      nextHook.sourceIndex = hook.sourceIndex
    }

    if (hook.name.trim() !== '') {
      nextHook.name = hook.name
    }

    if (hook.cwd.trim() !== '') {
      nextHook.cwd = hook.cwd
    }

    const parsedEnv = parseEnv(hook.env, `bootstrap_hooks[${index}].env`)
    if (!parsedEnv.ok) {
      errors.push(...parsedEnv.errors)
    } else if (Object.keys(parsedEnv.env).length > 0) {
      nextHook.env = parsedEnv.env
    }

    return nextHook
  })

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    }
  }

  return {
    ok: true,
    input: {
      scan_roots: draft.scan_roots,
      repos: draft.repos,
      default_agent: draft.default_agent === '' ? null : draft.default_agent,
      artifact_root: draft.artifact_root.trim() === '' ? null : draft.artifact_root,
      bootstrap_hooks: bootstrapHooks
    }
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

function parseEnv(
  value: string,
  field: string
): { ok: true; env: Record<string, string> } | { ok: false; errors: ConfigFieldError[] } {
  const env: Record<string, string> = {}
  const errors: ConfigFieldError[] = []

  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .forEach((line) => {
      const separatorIndex = line.indexOf('=')
      if (separatorIndex <= 0) {
        errors.push({
          field,
          message: 'Environment lines must use KEY=value.'
        })
        return
      }

      env[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1)
    })

  return errors.length === 0 ? { ok: true, env } : { ok: false, errors }
}

function getFieldError(errorsByField: Map<string, string>, field: string): string | undefined {
  return errorsByField.get(field) ??
    [...errorsByField.entries()].find(([errorField]) => errorField.startsWith(`${field}.`))?.[1]
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

function FlowWorkspaceStateView({
  state,
  onWorkspaceUpdate
}: {
  state: FlowPaneState
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  if (state.status === 'loading') {
    const title = state.repositoryName === undefined
      ? 'Loading Flow workspace'
      : `Loading ${state.repositoryName} Flows`
    const description = state.repositoryName === undefined
      ? 'Preparing the Flow-only workspace surface.'
      : `Reading Flow artifacts for ${state.repositoryName}.`

    return (
      <div
        className="state-block"
        role="status"
        aria-label="Flow workspace loading"
      >
        <p className="eyebrow">Flow</p>
        <h2>{title}</h2>
        <p>{description}</p>
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

  if (state.status === 'ready') {
    return (
      <div className="flow-list-view">
        <FlowCreatePanel
          create={state.create}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />

        <div className="flow-list-header">
          <p className="eyebrow">Flow</p>
          <h2>{state.repositoryName} Flows</h2>
          <p>{state.flows.length} {state.flows.length === 1 ? 'Flow' : 'Flows'} found.</p>
        </div>

        <div className="flow-list" aria-label={`${state.repositoryName} Flow records`}>
          {state.flows.map((flow) => (
            <article className="flow-row" key={flow.id}>
              <div className="flow-row-header">
                <h3>{flow.title}</h3>
                <span className="flow-status">{flow.status}</span>
              </div>
              <p className="flow-updated">Updated {flow.updatedAt}</p>
              <div className="flow-labels" aria-label={`${flow.title} metadata`}>
                <span>{flow.repositoryPath}</span>
                {flow.branch === undefined ? null : <span>{flow.branch}</span>}
                {flow.worktreePath === undefined ? null : <span>{flow.worktreePath}</span>}
                {flow.baseRef === undefined ? null : <span>base {flow.baseRef}</span>}
                {flow.commit === undefined ? null : <span>{flow.commit}</span>}
                {flow.planId === undefined ? null : <span>{flow.planId}</span>}
                {flow.planPath === undefined ? null : <span>{flow.planPath}</span>}
              </div>
              {flow.failure === undefined ? null : (
                <div
                  className="flow-failure"
                  role="alert"
                >
                  <strong>{flow.failure.stage}</strong>
                  <span>{flow.failure.message}</span>
                  {flow.failure.output === undefined ? null : <span>{flow.failure.output}</span>}
                </div>
              )}
              {flow.phases === undefined ? null : (
                <div className="phase-summary" aria-label={`${flow.title} phases`}>
                  {flow.phases.map((phase) => (
                    <span key={phase.id}>
                      {phase.title} - {phase.status}
                      {phase.summary === undefined ? '' : ` - ${phase.summary}`}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="empty-flow-view">
      {state.create === undefined ? null : (
        <FlowCreatePanel
          create={state.create}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />
      )}
      <div className="state-block">
        <p className="eyebrow">Flow</p>
        <h2>{state.title}</h2>
        <p>{state.description}</p>
      </div>
    </div>
  )
}

function FlowCreatePanel({
  create,
  onWorkspaceUpdate
}: {
  create: NonNullable<Extract<FlowPaneState, { status: 'ready' | 'empty' }>['create']>
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const request: CreateFlowRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      baseRef: baseRef.trim() === '' ? undefined : baseRef.trim()
    }

    if (request.title === '') {
      setLocalError('Flow title is required.')
      return
    }

    if (request.instructions === '') {
      setLocalError('Flow instructions are required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createFlow(request)
      onWorkspaceUpdate(nextWorkspace)
      if (
        (nextWorkspace.flow.status === 'ready' || nextWorkspace.flow.status === 'empty') &&
        nextWorkspace.flow.create?.error === null
      ) {
        setTitle('')
        setInstructions('')
        setBaseRef('')
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <form
      aria-label="Create Flow"
      className="flow-create-form"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <label className="field">
        <span>Title</span>
        <input
          disabled={!create.available || isSubmitting}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="Ship workspace creation"
          value={title}
        />
      </label>
      <label className="field">
        <span>Instructions</span>
        <textarea
          disabled={!create.available || isSubmitting}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          placeholder="Describe the implementation goal"
          value={instructions}
        />
      </label>
      <label className="field">
        <span>Base ref</span>
        <input
          disabled={!create.available || isSubmitting}
          onChange={(event) => setBaseRef(event.currentTarget.value)}
          placeholder="HEAD"
          value={baseRef}
        />
      </label>

      {errorMessage === null ? null : (
        <div
          aria-label="Flow creation error"
          className="create-error"
          role="alert"
        >
          {errorMessage}
        </div>
      )}

      <button
        className="primary-action"
        disabled={!create.available || isSubmitting || title.trim() === '' || instructions.trim() === ''}
        type="submit"
      >
        <CirclePlus aria-hidden="true" size={16} />
        <span>{isSubmitting ? 'Creating' : 'Create Flow'}</span>
      </button>
    </form>
  )
}
