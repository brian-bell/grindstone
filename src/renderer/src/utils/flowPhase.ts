import type {
  FlowHumanReviewOutcome,
  FlowPullRequestStatus
} from '@shared/artifacts'
import type {
  FlowListRow,
  FlowPhaseSummary,
  RecordFlowHumanReviewRequest,
  RecordFlowMergeRequest,
  RecordFlowPullRequestRequest
} from '@shared/workspace'

export type PullRequestDraft = {
  number: string
  url: string
  head: string
  base: string
  status: FlowPullRequestStatus
}

export function implementationChildrenCanComplete(phases: FlowPhaseSummary[]): boolean {
  return phases
    .filter(isImplementationChildPhase)
    .every((phase) =>
      phase.status === 'completed' ||
        (phase.status === 'skipped' && phase.notes !== undefined && phase.notes.trim() !== '')
    )
}

export function isExecutableWorkspacePhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'implementation' ||
    isImplementationChildPhase(phase) ||
    phase.kind === 'review_loop'
}

export function isPrCreationPhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'pr-creation'
}

export function isHumanReviewPhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'human-review'
}

export function isHumanReviewPhaseActionable(phase: FlowPhaseSummary): boolean {
  return phase.status === 'ready' ||
    phase.status === 'running' ||
    phase.status === 'needs_attention' ||
    phase.status === 'blocked' ||
    phase.status === 'completed'
}

export function isImplementationChildPhase(phase: FlowPhaseSummary): boolean {
  return phase.parentPhaseId === 'implementation' &&
    (phase.kind === 'implementation_child' || (phase.generated === true && phase.editable === true))
}

export function createPullRequestDraft(flow: FlowListRow): PullRequestDraft {
  return {
    number: flow.pr?.number === undefined ? '' : String(flow.pr.number),
    url: flow.pr?.url ?? '',
    head: flow.pr?.head ?? flow.branch ?? '',
    base: flow.pr?.base ?? flow.baseRef ?? 'main',
    status: flow.pr?.status ?? 'open'
  }
}

export function createRecordPullRequestRequest(
  flowId: string,
  draft: PullRequestDraft
): { ok: true; request: RecordFlowPullRequestRequest } | { ok: false; message: string } {
  const number = Number(draft.number)
  const url = draft.url.trim()
  const head = draft.head.trim()
  const base = draft.base.trim()

  if (draft.number.trim() === '' || !Number.isInteger(number) || number <= 0) {
    return { ok: false, message: 'PR number must be a positive integer.' }
  }
  if (!isHttpsUrl(url)) {
    return { ok: false, message: 'PR URL must be a valid HTTPS URL.' }
  }
  if (head === '') {
    return { ok: false, message: 'Head branch is required.' }
  }
  if (base === '') {
    return { ok: false, message: 'Base branch is required.' }
  }

  return {
    ok: true,
    request: {
      flowId,
      pr: {
        provider: 'github',
        number,
        url,
        head,
        base,
        status: draft.status
      },
      summary: `Recorded GitHub PR #${number}.`
    }
  }
}

export function createRecordHumanReviewRequest(
  flowId: string,
  outcome: FlowHumanReviewOutcome,
  notes: string
): { ok: true; request: RecordFlowHumanReviewRequest } | { ok: false; message: string } {
  const trimmedNotes = notes.trim()
  if ((outcome === 'changes_requested' || outcome === 'blocked') && trimmedNotes === '') {
    return { ok: false, message: 'Review notes are required.' }
  }

  return {
    ok: true,
    request: {
      flowId,
      outcome,
      notes: trimmedNotes === '' ? undefined : trimmedNotes
    }
  }
}

export function createRecordMergeRequest(
  flowId: string,
  status: 'merged' | 'blocked',
  draft: { commit: string; notes: string }
): { ok: true; request: RecordFlowMergeRequest } | { ok: false; message: string } {
  if (status === 'blocked') {
    const notes = draft.notes.trim()
    if (notes === '') {
      return { ok: false, message: 'Merge block notes are required.' }
    }
    return {
      ok: true,
      request: {
        flowId,
        status: 'blocked',
        notes
      }
    }
  }

  const commit = draft.commit.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, message: 'Merge commit must be a full 40-character hex object id.' }
  }
  return {
    ok: true,
    request: {
      flowId,
      status: 'merged',
      commit
    }
  }
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
