export type PersistedFlowPhaseStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'needs_attention'
  | 'completed'
  | 'blocked'
  | 'skipped'
  | 'done'
  | 'active'

export type FlowPhaseSessionReference = {
  provider: 'codex' | 'claude'
  session_id: string
  launch_id?: string
  status: string
  attachment_status: 'attached' | 'pending'
  started_at: string
  ended_at?: string
  transcript_path: string
}

export type PersistedFlowPhase = {
  phase_id: string
  title: string
  kind?: string
  status: PersistedFlowPhaseStatus | string
  order: number
  parent_phase_id?: string
  outcome?: string
  summary?: string
  notes?: string
  generated?: boolean
  editable?: boolean
  source_plan_id?: string
  launch_ids?: string[]
  note_history?: Array<{
    created_at: string
    note: string
    source: string
  }>
  sessions?: FlowPhaseSessionReference[]
  created_at?: string
  updated_at?: string
}

export type PersistedFlowMetadata = {
  schema_version: 1
  flow_id: string
  title: string
  instructions?: string
  status: string
  repo_path: string
  branch?: string
  worktree_path?: string
  base_ref?: string
  commit?: string
  start?: Record<string, unknown>
  failure?: Record<string, unknown>
  plan_id?: string
  plan_path?: string
  phases?: PersistedFlowPhase[]
  created_at: string
  updated_at: string
}

export type SavedPlanStatus =
  | 'draft'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'superseded'
  | 'archived'

export type SavedPlanMetadata = {
  schema_version: 1
  plan_id: string
  title: string
  status: SavedPlanStatus
  repo_path?: string
  worktree_path?: string
  branch?: string
  plan_path?: string
  flow_id?: string
  flow_path?: string
  linked_at?: string
  created_at: string
  updated_at: string
}

export type NormalizedTranscriptEvent = {
  event_id: string
  provider: 'codex' | 'claude'
  session_id: string
  flow_id: string
  phase_id: string
  launch_id?: string
  repo_path?: string
  worktree_path?: string
  branch?: string
  commit?: string
  source_ordinal: number
  timestamp?: string
  type: string
  role?: string
  actor?: string
  text: string
  truncated?: true
  original_bytes?: number
}

export type NormalizedSessionMetadata = {
  schema_version: 1
  provider: 'codex' | 'claude'
  session_id: string
  flow_id: string
  phase_id: string
  launch_id?: string
  repo_path?: string
  worktree_path?: string
  branch?: string
  commit?: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  attachment_status: 'attached' | 'pending'
  last_attachment_error?: string
  transcript_path: string
  source_summary: {
    provider: 'codex' | 'claude'
    input_format: string
    event_count: number
    warnings: string[]
  }
  truncated?: true
  created_at: string
  updated_at: string
}

export type LinkedFlowPlanResponse =
  | {
      status: 'ready'
      metadata: SavedPlanMetadata
      body: string
    }
  | {
      status: 'missing'
      flowId: string
      planId?: string
      message: string
    }
  | {
      status: 'corrupt'
      flowId: string
      planId?: string
      message: string
    }
