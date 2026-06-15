import type { PersistedFlowPhase } from './artifacts'

export type DefaultFlowPhaseDefinition = {
  phase_id: string
  title: string
  kind: string
  status: 'pending' | 'ready'
  order: number
}

export const defaultFlowGraph: DefaultFlowPhaseDefinition[] = [
  { phase_id: 'plan', title: 'Plan', kind: 'plan', status: 'ready', order: 1 },
  { phase_id: 'plan-review', title: 'Plan Review', kind: 'plan_review', status: 'pending', order: 2 },
  { phase_id: 'implementation', title: 'Implementation', kind: 'implementation', status: 'pending', order: 3 },
  { phase_id: 'review-loop-1', title: 'Review Loop 1', kind: 'review_loop', status: 'pending', order: 4 },
  { phase_id: 'review-loop-2', title: 'Review Loop 2', kind: 'review_loop', status: 'pending', order: 5 },
  { phase_id: 'pr-creation', title: 'PR Creation', kind: 'pr_creation', status: 'pending', order: 6 },
  { phase_id: 'human-review', title: 'Human Review', kind: 'human_review', status: 'pending', order: 7 }
]

export function createDefaultFlowPhases(now: string): PersistedFlowPhase[] {
  return defaultFlowGraph.map((phase) => ({
    ...phase,
    created_at: now,
    updated_at: now
  }))
}
