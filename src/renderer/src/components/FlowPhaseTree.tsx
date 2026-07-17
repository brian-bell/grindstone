import {
  Check,
  Play,
  Save,
  SkipForward,
  X
} from 'lucide-react'
import {
  useEffect,
  useState,
  type ReactElement
} from 'react'
import type {
  FlowHumanReviewOutcome,
  FlowPullRequestStatus
} from '@shared/artifacts'
import type {
  FlowListRow,
  FlowPhaseSummary,
  InitialWorkspaceState
} from '@shared/workspace'
import { getErrorMessage } from '../utils/errors'
import { formatHumanReviewOutcome, formatPhaseDetail } from '../utils/flowFormat'
import {
  createPullRequestDraft,
  createRecordHumanReviewRequest,
  createRecordMergeRequest,
  createRecordPullRequestRequest,
  implementationChildrenCanComplete,
  isExecutableWorkspacePhase,
  isHumanReviewPhase,
  isHumanReviewPhaseActionable,
  isImplementationChildPhase,
  isPrCreationPhase,
  type PullRequestDraft
} from '../utils/flowPhase'

export function FlowPhaseTree({
  flow,
  onWorkspaceUpdate
}: {
  flow: FlowListRow
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement | null {
  if (flow.phases === undefined || flow.phases.length === 0) {
    return null
  }

  const childrenByParent = new Map<string, FlowPhaseSummary[]>()
  for (const phase of flow.phases) {
    if (phase.parentPhaseId === undefined) {
      continue
    }
    childrenByParent.set(phase.parentPhaseId, [
      ...(childrenByParent.get(phase.parentPhaseId) ?? []),
      phase
    ])
  }

  const topLevel = flow.phases
    .filter((phase) => phase.parentPhaseId === undefined)
    .sort((left, right) => left.order - right.order)

  return (
    <div className="phase-tree" aria-label={`${flow.title} phase tree`}>
      {topLevel.map((phase) => (
        <FlowPhaseNode
          childrenByParent={childrenByParent}
          flow={flow}
          key={phase.id}
          level={0}
          onWorkspaceUpdate={onWorkspaceUpdate}
          phase={phase}
        />
      ))}
    </div>
  )
}

function FlowPhaseNode({
  childrenByParent,
  flow,
  level,
  onWorkspaceUpdate,
  phase
}: {
  childrenByParent: Map<string, FlowPhaseSummary[]>
  flow: FlowListRow
  level: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  phase: FlowPhaseSummary
}): ReactElement {
  const children = (childrenByParent.get(phase.id) ?? [])
    .sort((left, right) => left.order - right.order)

  return (
    <div className="phase-tree-node">
      <FlowPhaseRow
        flow={flow}
        level={level}
        onWorkspaceUpdate={onWorkspaceUpdate}
        phase={phase}
      />
      {children.length > 0 ? (
        <div className="phase-tree-children">
          {children.map((child) => (
            <FlowPhaseNode
              childrenByParent={childrenByParent}
              flow={flow}
              key={child.id}
              level={level + 1}
              onWorkspaceUpdate={onWorkspaceUpdate}
              phase={child}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FlowPhaseRow({
  flow,
  level,
  onWorkspaceUpdate,
  phase
}: {
  flow: FlowListRow
  level: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  phase: FlowPhaseSummary
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false)
  const [title, setTitle] = useState(phase.title)
  const [order, setOrder] = useState(String(phase.order))
  const [notes, setNotes] = useState(phase.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingAction, setPendingAction] = useState<
    'launch' | 'skip' | 'complete' | 'human-review' | 'merge' | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isSkipOpen, setIsSkipOpen] = useState(false)
  const [skipNotes, setSkipNotes] = useState('')
  const [skipError, setSkipError] = useState<string | null>(null)
  const [prDraft, setPrDraft] = useState<PullRequestDraft>(() => createPullRequestDraft(flow))
  const [prError, setPrError] = useState<string | null>(null)
  const [humanReviewNotes, setHumanReviewNotes] = useState(flow.humanReview?.notes ?? '')
  const [humanReviewError, setHumanReviewError] = useState<string | null>(null)
  const [mergeCommit, setMergeCommit] = useState(flow.merge.status === 'merged' ? flow.merge.commit : '')
  const [mergeNotes, setMergeNotes] = useState(flow.merge.status === 'blocked' ? flow.merge.notes : '')
  const [mergeError, setMergeError] = useState<string | null>(null)
  const canEdit = phase.generated === true &&
    phase.editable === true &&
    (phase.status === 'pending' || phase.status === 'ready')
  const isExecutablePhase = isExecutableWorkspacePhase(phase)
  const canLaunch = isExecutablePhase &&
    (phase.status === 'ready' || phase.status === 'needs_attention')
  const canComplete = isExecutablePhase &&
    phase.status === 'running' &&
    (phase.id !== 'implementation' || implementationChildrenCanComplete(flow.phases ?? []))
  const canSkip = isImplementationChildPhase(phase) &&
    (phase.status === 'pending' || phase.status === 'ready' || phase.status === 'running')
  const canRecordPr = isPrCreationPhase(phase) &&
    (phase.status === 'ready' || phase.status === 'running')
  const canRecordHumanReview = isHumanReviewPhase(phase) &&
    flow.pr !== undefined &&
    flow.merge.status !== 'merged' &&
    isHumanReviewPhaseActionable(phase)
  const showHumanReviewPanel = isHumanReviewPhase(phase) && flow.pr !== undefined
  const showMergePanel = showHumanReviewPanel && flow.humanReview?.outcome === 'approved'
  const canRecordMerge = showMergePanel && flow.merge.status !== 'merged'

  useEffect(() => {
    if (!isEditing) {
      setTitle(phase.title)
      setOrder(String(phase.order))
      setNotes(phase.notes ?? '')
      setError(null)
    }
  }, [isEditing, phase.notes, phase.order, phase.title])

  useEffect(() => {
    setActionError(null)
    setSkipError(null)
    setPrError(null)
    setHumanReviewError(null)
    setMergeError(null)
    setIsSkipOpen(false)
    setSkipNotes('')
  }, [phase.id, phase.status])

  useEffect(() => {
    setPrDraft(createPullRequestDraft(flow))
    setHumanReviewNotes(flow.humanReview?.notes ?? '')
    setMergeCommit(flow.merge.status === 'merged' ? flow.merge.commit : '')
    setMergeNotes(flow.merge.status === 'blocked' ? flow.merge.notes : '')
  }, [flow])

  async function handleSave(): Promise<void> {
    const parsedOrder = Number(order)
    if (title.trim() === '') {
      setError('Phase title cannot be empty.')
      return
    }
    if (!Number.isInteger(parsedOrder)) {
      setError('Phase order must be an integer.')
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const workspace = await window.grindstone.workspace.updateFlowPhase({
        flowId: flow.id,
        phaseId: phase.id,
        title: title.trim(),
        order: parsedOrder,
        notes
      })
      onWorkspaceUpdate(workspace)
      setIsEditing(false)
    } catch (saveError: unknown) {
      setError(getErrorMessage(saveError))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleLaunch(): Promise<void> {
    setPendingAction('launch')
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.launchFlowPhase({
        flowId: flow.id,
        phaseId: phase.id
      })
      onWorkspaceUpdate(workspace)
    } catch (launchError: unknown) {
      setActionError(getErrorMessage(launchError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleComplete(): Promise<void> {
    setPendingAction('complete')
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.completeFlowPhase({
        flowId: flow.id,
        phaseId: phase.id
      })
      onWorkspaceUpdate(workspace)
    } catch (completeError: unknown) {
      setActionError(getErrorMessage(completeError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleSkip(): Promise<void> {
    const trimmedNotes = skipNotes.trim()
    if (trimmedNotes === '') {
      setSkipError('Skip notes are required.')
      return
    }

    setPendingAction('skip')
    setSkipError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.skipFlowPhase({
        flowId: flow.id,
        phaseId: phase.id,
        notes: trimmedNotes
      })
      onWorkspaceUpdate(workspace)
      setIsSkipOpen(false)
      setSkipNotes('')
    } catch (skipActionError: unknown) {
      setActionError(getErrorMessage(skipActionError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordPullRequest(): Promise<void> {
    const request = createRecordPullRequestRequest(flow.id, prDraft)
    if (!request.ok) {
      setPrError(request.message)
      return
    }

    setPendingAction('complete')
    setPrError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowPullRequest(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordHumanReview(outcome: FlowHumanReviewOutcome): Promise<void> {
    const request = createRecordHumanReviewRequest(flow.id, outcome, humanReviewNotes)
    if (!request.ok) {
      setHumanReviewError(request.message)
      return
    }

    setPendingAction('human-review')
    setHumanReviewError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowHumanReview(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordMerge(status: 'merged' | 'blocked'): Promise<void> {
    const request = createRecordMergeRequest(flow.id, status, {
      commit: mergeCommit,
      notes: mergeNotes
    })
    if (!request.ok) {
      setMergeError(request.message)
      return
    }

    setPendingAction('merge')
    setMergeError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowMerge(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  if (isEditing) {
    return (
      <form
        aria-label={`Edit ${phase.title}`}
        className="phase-edit-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
        style={{ marginLeft: `${level * 18}px` }}
      >
        <label className="phase-edit-field">
          <span>Phase title</span>
          <input
            aria-label="Phase title"
            disabled={isSaving}
            onChange={(event) => setTitle(event.currentTarget.value)}
            value={title}
          />
        </label>
        <label className="phase-edit-field phase-order-field">
          <span>Order</span>
          <input
            aria-label="Order"
            disabled={isSaving}
            onChange={(event) => setOrder(event.currentTarget.value)}
            value={order}
          />
        </label>
        <label className="phase-edit-field phase-notes-field">
          <span>Notes</span>
          <textarea
            aria-label="Notes"
            disabled={isSaving}
            onChange={(event) => setNotes(event.currentTarget.value)}
            value={notes}
          />
        </label>
        {error === null ? null : (
          <div className="phase-edit-error" role="alert">
            {error}
          </div>
        )}
        <div className="phase-edit-actions">
          <button
            className="secondary-button"
            disabled={isSaving}
            onClick={() => setIsEditing(false)}
            type="button"
          >
            <X aria-hidden="true" size={15} />
            <span>Cancel</span>
          </button>
          <button
            className="primary-button"
            disabled={isSaving}
            type="submit"
          >
            <Save aria-hidden="true" size={15} />
            <span>{isSaving ? 'Saving' : 'Save'}</span>
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="phase-row-wrap">
      <div
        className={canLaunch
          ? 'phase-tree-row phase-tree-row-with-leading-action'
          : 'phase-tree-row'}
        style={{ marginLeft: `${level * 18}px` }}
      >
        {canLaunch ? (
          <button
            aria-label={`Launch ${phase.title}`}
            className="icon-button phase-action-button"
            disabled={pendingAction !== null}
            onClick={() => void handleLaunch()}
            title={`Launch ${phase.title}`}
            type="button"
          >
            <Play aria-hidden="true" size={14} />
          </button>
        ) : null}
        <span className="phase-tree-copy">
          <span>{formatPhaseDetail(phase)}</span>
          {phase.notes === undefined ? null : (
            <span className="phase-tree-notes">{phase.notes}</span>
          )}
        </span>
        <span className="phase-tree-actions">
          {canComplete ? (
            <button
              aria-label={`Complete ${phase.title}`}
              className="icon-button phase-action-button"
              disabled={pendingAction !== null}
              onClick={() => void handleComplete()}
              title={`Complete ${phase.title}`}
              type="button"
            >
              <Check aria-hidden="true" size={14} />
            </button>
          ) : null}
          {canSkip ? (
            <button
              aria-label={`Skip ${phase.title}`}
              className="icon-button phase-action-button"
              disabled={pendingAction !== null}
              onClick={() => {
                setIsSkipOpen((open) => !open)
                setSkipError(null)
                setActionError(null)
              }}
              title={`Skip ${phase.title}`}
              type="button"
            >
              <SkipForward aria-hidden="true" size={14} />
            </button>
          ) : null}
          {canEdit ? (
            <button
              className="secondary-button phase-edit-button"
              disabled={pendingAction !== null}
              onClick={() => setIsEditing(true)}
              type="button"
            >
              <span>Edit</span>
            </button>
          ) : null}
        </span>
      </div>
      {isSkipOpen ? (
        <form
          aria-label={`Skip ${phase.title}`}
          className="phase-skip-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSkip()
          }}
          style={{ marginLeft: `${level * 18}px` }}
        >
          <label className="phase-edit-field phase-notes-field">
            <span>Skip notes for {phase.title}</span>
            <textarea
              aria-label={`Skip notes for ${phase.title}`}
              disabled={pendingAction === 'skip'}
              onChange={(event) => setSkipNotes(event.currentTarget.value)}
              value={skipNotes}
            />
          </label>
          {skipError === null ? null : (
            <div className="phase-edit-error" role="alert">
              {skipError}
            </div>
          )}
          <div className="phase-edit-actions">
            <button
              className="secondary-button"
              disabled={pendingAction === 'skip'}
              onClick={() => {
                setIsSkipOpen(false)
                setSkipError(null)
                setSkipNotes('')
              }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
              <span>Cancel</span>
            </button>
            <button
              className="primary-button"
              disabled={pendingAction === 'skip'}
              type="submit"
            >
              <SkipForward aria-hidden="true" size={15} />
              <span>{pendingAction === 'skip' ? 'Skipping' : 'Skip phase'}</span>
            </button>
          </div>
        </form>
      ) : null}
      {canRecordPr ? (
        <form
          aria-label={`Record PR for ${flow.title}`}
          className="phase-pr-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleRecordPullRequest()
          }}
          style={{ marginLeft: `${level * 18}px` }}
        >
          <label className="phase-edit-field">
            <span>PR number</span>
            <input
              aria-label="PR number"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, number: event.currentTarget.value })}
              value={prDraft.number}
            />
          </label>
          <label className="phase-edit-field">
            <span>PR URL</span>
            <input
              aria-label="PR URL"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, url: event.currentTarget.value })}
              value={prDraft.url}
            />
          </label>
          <label className="phase-edit-field">
            <span>Head branch</span>
            <input
              aria-label="Head branch"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, head: event.currentTarget.value })}
              value={prDraft.head}
            />
          </label>
          <label className="phase-edit-field">
            <span>Base branch</span>
            <input
              aria-label="Base branch"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, base: event.currentTarget.value })}
              value={prDraft.base}
            />
          </label>
          <label className="phase-edit-field">
            <span>Status</span>
            <select
              aria-label="Status"
              disabled={pendingAction === 'complete'}
              onChange={(event) =>
                setPrDraft({
                  ...prDraft,
                  status: event.currentTarget.value as FlowPullRequestStatus
                })
              }
              value={prDraft.status}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="merged">Merged</option>
            </select>
          </label>
          {prError === null ? null : (
            <div className="phase-edit-error" role="alert">
              {prError}
            </div>
          )}
          <div className="phase-edit-actions">
            <button
              className="primary-button"
              disabled={pendingAction === 'complete'}
              type="submit"
            >
              <Check aria-hidden="true" size={15} />
              <span>{pendingAction === 'complete' ? 'Recording' : 'Record PR'}</span>
            </button>
          </div>
        </form>
      ) : null}
      {showHumanReviewPanel ? (
        <div
          aria-label={`Human Review for ${flow.title}`}
          className="phase-human-review-panel"
          role="region"
          style={{ marginLeft: `${level * 18}px` }}
        >
          <div className="phase-review-summary">
            <span>GitHub PR #{flow.pr?.number}</span>
            <a href={flow.pr?.url} rel="noreferrer" target="_blank">
              {flow.pr?.head} to {flow.pr?.base}
            </a>
            <span>{flow.pr?.status}</span>
          </div>
          {flow.humanReview === undefined ? null : (
            <div className="phase-review-summary">
              <span>Review {formatHumanReviewOutcome(flow.humanReview.outcome)}</span>
              <span>{flow.humanReview.reviewed_at}</span>
              {flow.humanReview.notes === undefined ? null : <span>{flow.humanReview.notes}</span>}
            </div>
          )}
          {canRecordHumanReview ? (
            <>
              <label className="phase-edit-field phase-notes-field">
                <span>Review notes</span>
                <textarea
                  aria-label="Review notes"
                  disabled={pendingAction === 'human-review'}
                  onChange={(event) => setHumanReviewNotes(event.currentTarget.value)}
                  value={humanReviewNotes}
                />
              </label>
              {humanReviewError === null ? null : (
                <div className="phase-edit-error" role="alert">
                  {humanReviewError}
                </div>
              )}
              <div className="phase-edit-actions">
                <button
                  className="primary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('approved')}
                  type="button"
                >
                  <Check aria-hidden="true" size={15} />
                  <span>Approve</span>
                </button>
                <button
                  className="secondary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('changes_requested')}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                  <span>Request changes</span>
                </button>
                <button
                  className="secondary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('blocked')}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                  <span>Block</span>
                </button>
              </div>
            </>
          ) : null}
          {showMergePanel ? (
            <div
              className="phase-merge-panel"
              aria-label={`Merge metadata for ${flow.title}`}
              role="region"
            >
              {flow.merge.status === 'merged' ? (
                <div className="phase-review-summary">
                  <span>Merged</span>
                  <span>{flow.merge.commit}</span>
                  <span>{flow.merge.merged_at}</span>
                </div>
              ) : (
                <>
                  {flow.merge.status === 'blocked' ? (
                    <div className="phase-review-summary">
                      <span>Merge blocked</span>
                      <span>{flow.merge.notes}</span>
                      <span>{flow.merge.updated_at}</span>
                    </div>
                  ) : null}
                  {canRecordMerge ? (
                    <>
                      <label className="phase-edit-field">
                        <span>Merge commit</span>
                        <input
                          aria-label="Merge commit"
                          disabled={pendingAction === 'merge'}
                          onChange={(event) => setMergeCommit(event.currentTarget.value)}
                          value={mergeCommit}
                        />
                      </label>
                      <label className="phase-edit-field phase-notes-field">
                        <span>Merge block notes</span>
                        <textarea
                          aria-label="Merge block notes"
                          disabled={pendingAction === 'merge'}
                          onChange={(event) => setMergeNotes(event.currentTarget.value)}
                          value={mergeNotes}
                        />
                      </label>
                      {mergeError === null ? null : (
                        <div className="phase-edit-error" role="alert">
                          {mergeError}
                        </div>
                      )}
                      <div className="phase-edit-actions">
                        <button
                          className="primary-button"
                          disabled={pendingAction === 'merge'}
                          onClick={() => void handleRecordMerge('merged')}
                          type="button"
                        >
                          <Check aria-hidden="true" size={15} />
                          <span>Record merge</span>
                        </button>
                        <button
                          className="secondary-button"
                          disabled={pendingAction === 'merge'}
                          onClick={() => void handleRecordMerge('blocked')}
                          type="button"
                        >
                          <X aria-hidden="true" size={15} />
                          <span>Block merge</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {actionError === null ? null : (
        <div
          className="phase-edit-error phase-action-error"
          role="alert"
          style={{ marginLeft: `${level * 18}px` }}
        >
          {actionError}
        </div>
      )}
    </div>
  )
}
