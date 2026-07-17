import type { FlowListRow } from '@shared/workspace'
import { isDonePhase } from './flowFormat'

export type FlowHealth = 'failed' | 'attention' | 'merged' | 'running' | 'idle'

export function getFlowHealth(flow: FlowListRow): FlowHealth {
  if (flow.failure !== undefined || flow.status === 'failed') {
    return 'failed'
  }

  if (flow.status === 'blocked' || flow.status === 'needs_attention') {
    return 'attention'
  }

  if (flow.merge.status === 'merged') {
    return 'merged'
  }

  if ((flow.phases ?? []).some((phase) => phase.status === 'running')) {
    return 'running'
  }

  return 'idle'
}

export function formatPhaseProgress(flow: FlowListRow): string {
  const phases = flow.phases ?? []
  if (phases.length === 0) {
    return '-'
  }

  const doneCount = phases.filter(isDonePhase).length
  return `${doneCount}/${phases.length}`
}

export function flowNeedsAttention(flow: FlowListRow): boolean {
  const health = getFlowHealth(flow)
  return health === 'failed' || health === 'attention'
}
