import { CirclePlus, GitBranch, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { resolveMiddlePaneRoute } from '@shared/middlePane'
import type {
  CatalogDiagnostic,
  FlowPaneState,
  GitHubVisibility,
  InitialWorkspaceState,
  RepositoryCreateState,
  RepositoryRemoteRetryRecord,
  RepositoryPaneState,
  RepositoryRow
} from '@shared/workspace'
import { defaultInitialWorkspaceState } from '@shared/workspace'

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<InitialWorkspaceState | null>(null)
  const [routeResolution] = useState(() => resolveMiddlePaneRoute(getRendererPath()))
  const routeFlowState = 'flowState' in routeResolution ? routeResolution.flowState : null
  const [flowState, setFlowState] = useState<FlowPaneState>(
    routeFlowState ?? { status: 'loading' }
  )

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

  const shellState = workspace ?? defaultInitialWorkspaceState
  const isWorkspaceLoading = workspace === null

  async function handleRepositorySelect(repositoryId: string): Promise<void> {
    try {
      const nextWorkspace = await window.grindstone.workspace.selectRepository({
        repositoryId
      })
      applyWorkspace(nextWorkspace)
    } catch (error: unknown) {
      setFlowState({
        status: 'error',
        message: getErrorMessage(error)
      })
    }
  }

  function applyWorkspace(nextWorkspace: InitialWorkspaceState): void {
    setWorkspace(nextWorkspace)
    setFlowState(routeFlowState ?? nextWorkspace.flow)
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
        <FlowWorkspaceStateView state={flowState} />
      </main>

      <section
        className="pane context-pane"
        aria-labelledby="context-pane-title"
      >
        <div className="pane-header">
          <Sparkles aria-hidden="true" size={18} />
          <h2 id="context-pane-title">Contextual Hints</h2>
        </div>

        <div className="hint-list">
          {shellState.hints.map((hint) => (
            <article className="hint-row" key={hint.id}>
              <h3>{hint.title}</h3>
              <p>{hint.description}</p>
            </article>
          ))}
        </div>

        <div className="shortcut-list" aria-label="Flow shortcuts">
          {shellState.shortcuts.map((shortcut) => (
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
      </section>
    </div>
  )
}

function RepositoryCatalogView({
  isLoading,
  repository,
  onSelect,
  onWorkspaceUpdate
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  onSelect: (repositoryId: string) => Promise<void>
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
