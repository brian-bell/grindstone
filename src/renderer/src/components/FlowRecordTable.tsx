import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState, type ReactElement } from 'react'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import type { FlowListRow, InitialWorkspaceState } from '@shared/workspace'
import { getErrorMessage } from '../utils/errors'
import {
  formatFailureSummary,
  formatFlowTooltip,
  formatPhaseSummary
} from '../utils/flowFormat'
import { FlowPhaseTree } from './FlowPhaseTree'
import { FlowTerminalTabs } from './FlowTerminalTabs'

export type FlowPlanViewState =
  | { status: 'loading'; planId: string }
  | { status: 'ready'; planId: string; title: string; body: string }
  | { status: 'missing' | 'corrupt'; planId: string; message: string }

export function FlowRecordTable({
  flows,
  onWorkspaceUpdate,
  repositoryName
}: {
  flows: FlowListRow[]
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  repositoryName: string
}): ReactElement {
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null)
  const [planViews, setPlanViews] = useState<Record<string, FlowPlanViewState>>({})

  async function handlePlanOpen(flow: FlowListRow): Promise<void> {
    if (flow.planId === undefined) {
      return
    }

    const current = planViews[flow.id]
    if (current?.status === 'ready' || current?.status === 'missing' || current?.status === 'corrupt') {
      setPlanViews((views) => {
        const nextViews = { ...views }
        delete nextViews[flow.id]
        return nextViews
      })
      return
    }

    setPlanViews((views) => ({
      ...views,
      [flow.id]: { status: 'loading', planId: flow.planId ?? '' }
    }))

    try {
      const response = await window.grindstone.workspace.readFlowPlan({ flowId: flow.id })
      setPlanViews((views) => ({
        ...views,
        [flow.id]: toFlowPlanViewState(flow.planId ?? '', response)
      }))
    } catch (error: unknown) {
      setPlanViews((views) => ({
        ...views,
        [flow.id]: {
          status: 'missing',
          planId: flow.planId ?? '',
          message: getErrorMessage(error)
        }
      }))
    }
  }

  return (
    <div className="flow-table-wrap">
      <table className="flow-table" aria-label={`${repositoryName} Flow records`}>
        <thead>
          <tr>
            <th scope="col">Flow</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">Branch</th>
            <th scope="col">Plan</th>
            <th scope="col">Phases</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow) => {
            const details = formatFlowTooltip(flow)
            const detailsId = `flow-details-${flow.id}`
            const planDetailsId = `flow-plan-${flow.id}`
            const isExpanded = expandedFlowId === flow.id
            const planView = planViews[flow.id]

            return (
              <Fragment key={flow.id}>
                <tr>
                  <td>
                    <span className="flow-title-cell">
                      <button
                        aria-controls={detailsId}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${flow.title} details`}
                        className="flow-disclosure-button"
                        onClick={() => setExpandedFlowId(isExpanded ? null : flow.id)}
                        title={details}
                        type="button"
                      >
                        {isExpanded ? (
                          <ChevronDown aria-hidden="true" size={14} />
                        ) : (
                          <ChevronRight aria-hidden="true" size={14} />
                        )}
                      </button>
                      <span className="flow-title">{flow.title}</span>
                    </span>
                  </td>
                  <td>
                    <span className="flow-status">{flow.status}</span>
                    {flow.failure === undefined ? null : (
                      <span className="flow-failure-summary">
                        {formatFailureSummary(flow.failure)}
                      </span>
                    )}
                  </td>
                  <td>{flow.updatedAt}</td>
                  <td>
                    {flow.branch === undefined ? '-' : flow.branch}
                  </td>
                  <td>
                    {flow.planId === undefined ? '-' : (
                      <button
                        aria-controls={planDetailsId}
                        aria-expanded={planView !== undefined}
                        aria-label={`Open plan ${flow.planId} for ${flow.title}`}
                        className="flow-plan-button"
                        onClick={() => void handlePlanOpen(flow)}
                        type="button"
                      >
                        {flow.planId}
                      </button>
                    )}
                  </td>
                  <td>
                    {formatPhaseSummary(flow)}
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="flow-detail-row">
                    <td colSpan={6}>
                      <div
                        className="flow-detail-panel"
                        id={detailsId}
                        role="region"
                        aria-label={`${flow.title} details`}
                      >
                        <FlowDetailBadges details={details} />
                        <FlowPhaseTree
                          flow={flow}
                          onWorkspaceUpdate={onWorkspaceUpdate}
                        />
                      </div>
                    </td>
                  </tr>
                ) : null}
                {planView === undefined ? null : (
                  <tr className="flow-detail-row">
                    <td colSpan={6}>
                      <FlowPlanPanel
                        flow={flow}
                        id={planDetailsId}
                        view={planView}
                      />
                    </td>
                  </tr>
                )}
                {flow.terminals !== undefined && flow.terminals.length > 0 ? (
                  <tr className="flow-terminal-row">
                    <td colSpan={6}>
                      <FlowTerminalTabs
                        flow={flow}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FlowDetailBadges({ details }: { details: string }): ReactElement {
  return (
    <div className="flow-detail-badges">
      {details
        .split('\n')
        .filter((line) => !line.startsWith('Phase: '))
        .map((line, index) => (
          <span key={`${index}:${line}`}>{line}</span>
        ))}
    </div>
  )
}

function FlowPlanPanel({
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

function toFlowPlanViewState(planId: string, response: LinkedFlowPlanResponse): FlowPlanViewState {
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
