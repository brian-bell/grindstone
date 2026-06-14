import { CirclePlus, GitBranch, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { resolveMiddlePaneRoute } from '@shared/middlePane'
import type {
  CatalogDiagnostic,
  FlowPaneState,
  InitialWorkspaceState,
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
  const selectionRequestIdRef = useRef(0)

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

      setWorkspace(nextWorkspace)
      setFlowState(routeFlowState ?? nextWorkspace.flow)
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
  onSelect
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  onSelect: (repository: RepositoryRow) => Promise<void>
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
                {flow.planId === undefined ? null : <span>{flow.planId}</span>}
                {flow.planPath === undefined ? null : <span>{flow.planPath}</span>}
              </div>
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
    <div className="state-block">
      <p className="eyebrow">Flow</p>
      <h2>{state.title}</h2>
      <p>{state.description}</p>
    </div>
  )
}
