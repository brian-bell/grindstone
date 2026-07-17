import type { ReactElement } from 'react'
import type { FlowListRow, FlowPaneState, InitialWorkspaceState } from '@shared/workspace'
import { FlowDetailView } from './FlowDetailView'
import { FlowOverview } from './FlowOverview'

export function FlowWorkspaceStateView({
  state,
  selectedFlow,
  onSelectFlow,
  onWorkspaceUpdate
}: {
  state: FlowPaneState
  selectedFlow: FlowListRow | null
  onSelectFlow: (flowId: string) => void
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
    if (selectedFlow !== null) {
      // Keying by flow id resets detail-local state (plan panel, terminal tab,
      // phase drafts) on selection change and guarantees in-flight plan reads
      // from a previously selected Flow resolve into an unmounted view.
      return (
        <FlowDetailView
          flow={selectedFlow}
          key={selectedFlow.id}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />
      )
    }

    return (
      <FlowOverview
        flows={state.flows}
        repositoryName={state.repositoryName}
        onSelectFlow={onSelectFlow}
      />
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
