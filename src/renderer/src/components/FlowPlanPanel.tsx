import type { ReactElement } from 'react'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import type { FlowListRow } from '@shared/workspace'

export type FlowPlanViewState =
  | { status: 'loading'; planId: string }
  | { status: 'ready'; planId: string; title: string; body: string }
  | { status: 'missing' | 'corrupt'; planId: string; message: string }

export function FlowPlanPanel({
  flow,
  id,
  view
}: {
  flow: FlowListRow
  id: string
  view: FlowPlanViewState
}): ReactElement {
  switch (view.status) {
    case 'loading':
      return (
        <div className="flow-detail-panel" id={id} role="status" aria-label={`${flow.title} linked plan`}>
          <span>Loading linked plan {view.planId}</span>
        </div>
      )
    case 'missing':
    case 'corrupt':
      return (
        <div className="flow-detail-panel" id={id} role="alert" aria-label={`${flow.title} linked plan`}>
          <span>{view.status === 'missing' ? 'Linked plan missing' : 'Linked plan corrupt'}</span>
          <span>{view.message}</span>
        </div>
      )
    case 'ready':
      return (
        <div className="flow-detail-panel flow-plan-panel" id={id} role="region" aria-label={`${flow.title} linked plan`}>
          <span>Plan: {view.title}</span>
          <pre>{view.body}</pre>
        </div>
      )
  }
}

export function toFlowPlanViewState(planId: string, response: LinkedFlowPlanResponse): FlowPlanViewState {
  if (response.status === 'ready') {
    return {
      status: 'ready',
      planId,
      title: response.metadata.title,
      body: response.body
    }
  }

  return {
    status: response.status,
    planId,
    message: response.message
  }
}
