import { CirclePlus, GitBranch, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import type { FlowPaneState, InitialWorkspaceState } from '@shared/workspace'
import { defaultInitialWorkspaceState } from '@shared/workspace'

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<InitialWorkspaceState | null>(null)
  const [flowState, setFlowState] = useState<FlowPaneState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    window.grindstone.workspace
      .getInitialState()
      .then((initialState) => {
        if (!cancelled) {
          setWorkspace(initialState)
          setFlowState(initialState.flow)
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
  }, [])

  const shellState = workspace ?? defaultInitialWorkspaceState

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
        <div className="empty-block">
          <p className="eyebrow">Repository</p>
          <h3>{shellState.repository.title}</h3>
          <p>{shellState.repository.description}</p>
        </div>
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
