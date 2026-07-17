import type { ReactElement } from 'react'
import type { FlowListRow } from '@shared/workspace'
import { formatFailureSummary } from '../utils/flowFormat'
import { flowNeedsAttention } from '../utils/flowHealth'

export function FlowOverview({
  flows,
  repositoryName,
  onSelectFlow
}: {
  flows: FlowListRow[]
  repositoryName: string
  onSelectFlow: (flowId: string) => void
}): ReactElement {
  const statusCounts = flows.reduce<Map<string, number>>((counts, flow) => {
    counts.set(flow.status, (counts.get(flow.status) ?? 0) + 1)
    return counts
  }, new Map())
  const attentionFlows = flows.filter(flowNeedsAttention)

  return (
    <div className="flow-overview">
      <p className="eyebrow">Flow</p>
      <h1>{repositoryName} Flows</h1>
      <p>
        {flows.length} {flows.length === 1 ? 'Flow' : 'Flows'} found. Select a Flow from the
        sidebar to inspect phases, terminals, and review actions.
      </p>

      <div className="flow-overview-counts" aria-label="Flow status summary">
        {[...statusCounts.entries()].map(([status, count]) => (
          <span className="flow-overview-count" key={status}>
            {count} {status}
          </span>
        ))}
      </div>

      {attentionFlows.length === 0 ? null : (
        <section className="flow-attention-list" aria-label="Flows needing attention">
          <h2>Needs attention</h2>
          {attentionFlows.map((flow) => (
            <button
              className="flow-attention-item"
              key={flow.id}
              onClick={() => onSelectFlow(flow.id)}
              type="button"
            >
              <span className="flow-attention-title">{flow.title}</span>
              <span className="flow-attention-reason">
                {flow.failure === undefined ? flow.status : formatFailureSummary(flow.failure)}
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  )
}
