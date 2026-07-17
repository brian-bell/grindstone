import type { ReactElement } from 'react'
import type { FlowPaneState, InitialWorkspaceState } from '@shared/workspace'
import { FlowCreatePanel } from './FlowCreatePanel'
import { FlowRecordTable } from './FlowRecordTable'

export function FlowWorkspaceStateView({
  createOpenRequest,
  state,
  onWorkspaceUpdate
}: {
  createOpenRequest: number
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
          openRequest={createOpenRequest}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />

        <div className="flow-list-header">
          <p className="eyebrow">Flow</p>
          <h2>{state.repositoryName} Flows</h2>
          <p>{state.flows.length} {state.flows.length === 1 ? 'Flow' : 'Flows'} found.</p>
        </div>

        <FlowRecordTable
          flows={state.flows}
          onWorkspaceUpdate={onWorkspaceUpdate}
          repositoryName={state.repositoryName}
        />
      </div>
    )
  }

  return (
    <div className="empty-flow-view">
      {state.create === undefined ? null : (
        <FlowCreatePanel
          create={state.create}
          openRequest={createOpenRequest}
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
