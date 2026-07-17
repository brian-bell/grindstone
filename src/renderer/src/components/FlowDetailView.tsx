import { useEffect, useState, type ReactElement } from 'react'
import type { FlowListRow, InitialWorkspaceState } from '@shared/workspace'
import { getErrorMessage } from '../utils/errors'
import { formatFailureSummary, formatFlowTooltip } from '../utils/flowFormat'
import { FlowPhaseTree } from './FlowPhaseTree'
import { FlowPlanPanel, toFlowPlanViewState, type FlowPlanViewState } from './FlowPlanPanel'
import { FlowTerminalTabs } from './FlowTerminalTabs'

export function FlowDetailView({
  flow,
  onWorkspaceUpdate
}: {
  flow: FlowListRow
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [planView, setPlanView] = useState<FlowPlanViewState | null>(null)
  const planDetailsId = `flow-plan-${flow.id}`
  const details = formatFlowTooltip(flow)

  useEffect(() => {
    setPlanView(null)
  }, [flow.id])

  async function handlePlanOpen(): Promise<void> {
    if (flow.planId === undefined) {
      return
    }

    if (planView !== null) {
      setPlanView(null)
      return
    }

    setPlanView({ status: 'loading', planId: flow.planId })

    try {
      const response = await window.grindstone.workspace.readFlowPlan({ flowId: flow.id })
      setPlanView(toFlowPlanViewState(flow.planId, response))
    } catch (error: unknown) {
      setPlanView({
        status: 'missing',
        planId: flow.planId ?? '',
        message: getErrorMessage(error)
      })
    }
  }

  return (
    <div className="flow-detail">
      <header className="flow-detail-header">
        <p className="eyebrow">Flow</p>
        <h1>{flow.title}</h1>
        <div className="flow-detail-meta">
          <span className="flow-status">{flow.status}</span>
          <span>Updated {flow.updatedAt}</span>
          {flow.branch === undefined ? null : <span>Branch {flow.branch}</span>}
          {flow.planId === undefined ? null : (
            <button
              aria-controls={planDetailsId}
              aria-expanded={planView !== null}
              aria-label={`Open plan ${flow.planId} for ${flow.title}`}
              className="flow-plan-button"
              onClick={() => void handlePlanOpen()}
              type="button"
            >
              Plan {flow.planId}
            </button>
          )}
        </div>
        {flow.failure === undefined ? null : (
          <div className="flow-failure-summary">
            {formatFailureSummary(flow.failure)}
          </div>
        )}
      </header>

      <FlowDetailBadges details={details} />

      {planView === null ? null : (
        <FlowPlanPanel flow={flow} id={planDetailsId} view={planView} />
      )}

      <FlowPhaseTree flow={flow} onWorkspaceUpdate={onWorkspaceUpdate} />

      {flow.terminals !== undefined && flow.terminals.length > 0 ? (
        <FlowTerminalTabs flow={flow} />
      ) : null}
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
