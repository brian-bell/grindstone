import { describe, expect, it } from 'vitest'
import {
  normalizeFlowHumanReviewMetadata,
  normalizeFlowMergeMetadata,
  validateFlowHumanReviewMetadata,
  validateFlowMergeMetadata
} from './artifacts'

describe('Flow artifact metadata validators', () => {
  it('normalizes valid Human Review metadata and requires notes for non-approval outcomes', () => {
    expect(validateFlowHumanReviewMetadata({
      outcome: 'approved',
      reviewed_at: '2026-06-15T12:00:00.000Z',
      notes: 'Looks good.'
    })).toEqual({
      ok: true,
      humanReview: {
        outcome: 'approved',
        reviewed_at: '2026-06-15T12:00:00.000Z',
        notes: 'Looks good.'
      }
    })

    expect(validateFlowHumanReviewMetadata({
      outcome: 'changes_requested',
      reviewed_at: '2026-06-15T12:00:00.000Z',
      notes: 'Fix the failing check.'
    })).toMatchObject({ ok: true })
    expect(validateFlowHumanReviewMetadata({
      outcome: 'blocked',
      reviewed_at: '2026-06-15T12:00:00.000Z',
      notes: 'Waiting on approval.'
    })).toMatchObject({ ok: true })

    expect(validateFlowHumanReviewMetadata({
      outcome: 'changes_requested',
      reviewed_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: false,
      message: 'Human Review outcome changes_requested requires notes.'
    })
    expect(validateFlowHumanReviewMetadata({
      outcome: 'blocked',
      reviewed_at: '2026-06-15T12:00:00.000Z',
      notes: '   '
    })).toEqual({
      ok: false,
      message: 'Human Review outcome blocked requires notes.'
    })
  })

  it('rejects invalid Human Review outcomes and timestamps when normalizing persisted metadata', () => {
    expect(validateFlowHumanReviewMetadata({
      outcome: 'commented',
      reviewed_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: false,
      message: 'Human Review outcome must be approved, changes_requested, or blocked.'
    })
    expect(validateFlowHumanReviewMetadata({
      outcome: 'approved',
      reviewed_at: 'not-a-date'
    })).toEqual({
      ok: false,
      message: 'Human Review reviewed_at must be a valid ISO timestamp.'
    })
    expect(validateFlowHumanReviewMetadata({
      outcome: 'approved',
      reviewed_at: '2026-06-15'
    })).toEqual({
      ok: false,
      message: 'Human Review reviewed_at must be a valid ISO timestamp.'
    })
    expect(normalizeFlowHumanReviewMetadata({
      outcome: 'approved',
      reviewed_at: 'not-a-date'
    })).toBeUndefined()
  })

  it('normalizes missing merge metadata to pending and validates persisted merge variants', () => {
    expect(normalizeFlowMergeMetadata(undefined)).toEqual({ status: 'pending' })
    expect(validateFlowMergeMetadata({ status: 'pending' })).toEqual({
      ok: true,
      merge: { status: 'pending' }
    })
    expect(validateFlowMergeMetadata({
      status: 'merged',
      commit: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
      merged_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: true,
      merge: {
        status: 'merged',
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        merged_at: '2026-06-15T12:00:00.000Z'
      }
    })
    expect(validateFlowMergeMetadata({
      status: 'blocked',
      notes: 'Merge queue is closed.',
      updated_at: '2026-06-15T12:00:00.000Z'
    })).toMatchObject({ ok: true })
  })

  it('rejects invalid merge commits, timestamps, statuses, and blocked notes', () => {
    expect(validateFlowMergeMetadata({
      status: 'merged',
      commit: 'abcdef1',
      merged_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: false,
      message: 'Merge commit must be a full 40-character hex object id.'
    })
    expect(validateFlowMergeMetadata({
      status: 'merged',
      commit: 'zzzzzz1234567890abcdef1234567890abcdef12',
      merged_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: false,
      message: 'Merge commit must be a full 40-character hex object id.'
    })
    expect(validateFlowMergeMetadata({
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      merged_at: 'not-a-date'
    })).toEqual({
      ok: false,
      message: 'Merge merged_at must be a valid ISO timestamp.'
    })
    expect(validateFlowMergeMetadata({
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      merged_at: '2026-06-15'
    })).toEqual({
      ok: false,
      message: 'Merge merged_at must be a valid ISO timestamp.'
    })
    expect(validateFlowMergeMetadata({
      status: 'blocked',
      notes: '',
      updated_at: '2026-06-15T12:00:00.000Z'
    })).toEqual({
      ok: false,
      message: 'Blocked merge metadata requires notes.'
    })
    expect(validateFlowMergeMetadata({ status: 'open' })).toEqual({
      ok: false,
      message: 'Merge status must be pending, merged, or blocked.'
    })
  })
})
