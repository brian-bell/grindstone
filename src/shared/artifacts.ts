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

export type FlowReviewBehavior = {
  id: string
  prompt: string
  runnerHint?: string
}

export type FlowPullRequestStatus = 'open' | 'closed' | 'merged'

export type FlowPullRequestMetadata = {
  provider: 'github'
  number: number
  url: string
  head: string
  base: string
  status: FlowPullRequestStatus
}

export type FlowHumanReviewOutcome = 'approved' | 'changes_requested' | 'blocked'

export type FlowHumanReviewMetadata = {
  outcome: FlowHumanReviewOutcome
  reviewed_at: string
  notes?: string
}

export type FlowMergeMetadata =
  | { status: 'pending' }
  | { status: 'merged'; commit: string; merged_at: string }
  | { status: 'blocked'; notes: string; updated_at: string }

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
  pr?: FlowPullRequestMetadata
  human_review?: FlowHumanReviewMetadata
  merge?: FlowMergeMetadata
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

export type FlowPullRequestMetadataValidationResult =
  | { ok: true; pr: FlowPullRequestMetadata }
  | { ok: false; message: string }

export type FlowHumanReviewMetadataValidationResult =
  | { ok: true; humanReview: FlowHumanReviewMetadata }
  | { ok: false; message: string }

export type FlowMergeMetadataValidationResult =
  | { ok: true; merge: FlowMergeMetadata }
  | { ok: false; message: string }

export function normalizeFlowPullRequestMetadata(value: unknown): FlowPullRequestMetadata | undefined {
  const result = validateFlowPullRequestMetadata(value)
  return result.ok ? result.pr : undefined
}

export function validateFlowPullRequestMetadata(value: unknown): FlowPullRequestMetadataValidationResult {
  if (!isRecord(value)) {
    return { ok: false, message: 'Pull request metadata is required.' }
  }

  if (value.provider !== 'github') {
    return { ok: false, message: 'Pull request provider must be github.' }
  }

  const number = value.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    return { ok: false, message: 'Pull request number must be a positive integer.' }
  }

  if (typeof value.url !== 'string' || !isHttpsUrl(value.url)) {
    return { ok: false, message: 'Pull request URL must be a valid HTTPS URL.' }
  }

  const head = normalizedNonEmptyString(value.head)
  if (head === undefined) {
    return { ok: false, message: 'Pull request head branch is required.' }
  }

  const base = normalizedNonEmptyString(value.base)
  if (base === undefined) {
    return { ok: false, message: 'Pull request base branch is required.' }
  }

  if (!isFlowPullRequestStatus(value.status)) {
    return { ok: false, message: 'Pull request status must be open, closed, or merged.' }
  }

  return {
    ok: true,
    pr: {
      provider: 'github',
      number,
      url: value.url,
      head,
      base,
      status: value.status
    }
  }
}

export function normalizeFlowHumanReviewMetadata(value: unknown): FlowHumanReviewMetadata | undefined {
  const result = validateFlowHumanReviewMetadata(value)
  return result.ok ? result.humanReview : undefined
}

export function validateFlowHumanReviewMetadata(value: unknown): FlowHumanReviewMetadataValidationResult {
  if (!isRecord(value)) {
    return { ok: false, message: 'Human Review metadata is required.' }
  }

  if (!isFlowHumanReviewOutcome(value.outcome)) {
    return {
      ok: false,
      message: 'Human Review outcome must be approved, changes_requested, or blocked.'
    }
  }

  if (typeof value.reviewed_at !== 'string' || !isIsoTimestamp(value.reviewed_at)) {
    return { ok: false, message: 'Human Review reviewed_at must be a valid ISO timestamp.' }
  }

  const notes = normalizedNonEmptyString(value.notes)
  if (
    (value.outcome === 'changes_requested' || value.outcome === 'blocked') &&
    notes === undefined
  ) {
    return { ok: false, message: `Human Review outcome ${value.outcome} requires notes.` }
  }

  return {
    ok: true,
    humanReview: withoutUndefined({
      outcome: value.outcome,
      reviewed_at: value.reviewed_at,
      notes
    })
  }
}

export function normalizeFlowMergeMetadata(value: unknown): FlowMergeMetadata {
  if (value === undefined) {
    return { status: 'pending' }
  }
  const result = validateFlowMergeMetadata(value)
  return result.ok ? result.merge : { status: 'pending' }
}

export function validateFlowMergeMetadata(value: unknown): FlowMergeMetadataValidationResult {
  if (!isRecord(value)) {
    return { ok: false, message: 'Merge metadata is required.' }
  }

  if (value.status === 'pending') {
    return { ok: true, merge: { status: 'pending' } }
  }

  if (value.status === 'merged') {
    const commit = normalizeFullGitObjectId(value.commit)
    if (commit === undefined) {
      return { ok: false, message: 'Merge commit must be a full 40-character hex object id.' }
    }
    if (typeof value.merged_at !== 'string' || !isIsoTimestamp(value.merged_at)) {
      return { ok: false, message: 'Merge merged_at must be a valid ISO timestamp.' }
    }
    return {
      ok: true,
      merge: {
        status: 'merged',
        commit,
        merged_at: value.merged_at
      }
    }
  }

  if (value.status === 'blocked') {
    const notes = normalizedNonEmptyString(value.notes)
    if (notes === undefined) {
      return { ok: false, message: 'Blocked merge metadata requires notes.' }
    }
    if (typeof value.updated_at !== 'string' || !isIsoTimestamp(value.updated_at)) {
      return { ok: false, message: 'Merge updated_at must be a valid ISO timestamp.' }
    }
    return {
      ok: true,
      merge: {
        status: 'blocked',
        notes,
        updated_at: value.updated_at
      }
    }
  }

  return { ok: false, message: 'Merge status must be pending, merged, or blocked.' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isFlowPullRequestStatus(value: unknown): value is FlowPullRequestStatus {
  return value === 'open' || value === 'closed' || value === 'merged'
}

function isFlowHumanReviewOutcome(value: unknown): value is FlowHumanReviewOutcome {
  return value === 'approved' || value === 'changes_requested' || value === 'blocked'
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value
}

function normalizeFullGitObjectId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : undefined
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T
}
