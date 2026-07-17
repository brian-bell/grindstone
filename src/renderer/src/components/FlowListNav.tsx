import {
  Circle,
  CircleAlert,
  CircleCheck,
  Play,
  TriangleAlert
} from 'lucide-react'
import type { ReactElement } from 'react'
import type { FlowListRow, FlowPaneState, InitialWorkspaceState } from '@shared/workspace'
import { formatFailureSummary } from '../utils/flowFormat'
import { formatPhaseProgress, getFlowHealth, type FlowHealth } from '../utils/flowHealth'
import { FlowCreatePanel } from './FlowCreatePanel'

const healthIcons: Record<FlowHealth, ReactElement> = {
  failed: <CircleAlert aria-hidden="true" size={14} />,
  attention: <TriangleAlert aria-hidden="true" size={14} />,
  merged: <CircleCheck aria-hidden="true" size={14} />,
  running: <Play aria-hidden="true" size={14} />,
  idle: <Circle aria-hidden="true" size={14} />
}

export function FlowListNav({
  state,
  selectedFlowId,
  onSelectFlow,
  onWorkspaceUpdate
}: {
  state: FlowPaneState
  selectedFlowId: string | null
  onSelectFlow: (flowId: string) => void
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  if (state.status === 'loading') {
    return (
      <div className="flow-nav-status" role="status">
        Loading Flows
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flow-nav-status flow-nav-error" role="alert">
        Flow list unavailable
      </div>
    )
  }

  const create = state.status === 'ready' || state.status === 'empty' ? state.create : undefined

  if (state.status === 'empty') {
    return (
      <div className="flow-nav">
        {create === undefined ? null : (
          <FlowCreatePanel create={create} openRequest={0} onWorkspaceUpdate={onWorkspaceUpdate} />
        )}
        <p className="flow-nav-status">No Flows yet</p>
      </div>
    )
  }

  return (
    <div className="flow-nav">
      {create === undefined ? null : (
        <FlowCreatePanel create={create} openRequest={0} onWorkspaceUpdate={onWorkspaceUpdate} />
      )}
      <ul className="flow-nav-list" aria-label={`${state.repositoryName} Flow list`}>
        {state.flows.map((flow) => (
          <FlowNavItem
            flow={flow}
            isSelected={flow.id === selectedFlowId}
            key={flow.id}
            onSelect={onSelectFlow}
          />
        ))}
      </ul>
    </div>
  )
}

function FlowNavItem({
  flow,
  isSelected,
  onSelect
}: {
  flow: FlowListRow
  isSelected: boolean
  onSelect: (flowId: string) => void
}): ReactElement {
  const health = getFlowHealth(flow)

  return (
    <li>
      <button
        aria-pressed={isSelected}
        className={isSelected ? 'flow-nav-item flow-nav-item-selected' : 'flow-nav-item'}
        onClick={() => onSelect(flow.id)}
        type="button"
      >
        <span className="flow-nav-item-main">
          <span className={`flow-health flow-health-${health}`} aria-hidden="true">
            {healthIcons[health]}
          </span>
          <span className="flow-nav-title">{flow.title}</span>
          <span className="flow-nav-progress">{formatPhaseProgress(flow)}</span>
        </span>
        <span className="flow-nav-item-sub">
          <span className="flow-nav-status">{flow.status}</span>
          {flow.failure === undefined ? null : (
            <span className="flow-nav-failure">{formatFailureSummary(flow.failure)}</span>
          )}
        </span>
      </button>
    </li>
  )
}
