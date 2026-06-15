import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedFlowMetadata, PersistedFlowPhase } from '@shared/artifacts'
import { createDefaultFlowPhases } from '@shared/flowGraph'
import {
  ArtifactStoreError,
  assertSafeArtifactId,
  ensurePrivateDirectory,
  getErrorMessage,
  listSafeDirectories,
  readJsonArtifact,
  writeJsonAtomically
} from './artifactStore'
import { createPlanStore } from './planStore'
import { extractImplementationPhaseDrafts, type ImplementationPhaseDraft } from './planPhaseExtraction'

export type CreateFlowInput = {
  id?: string
  title: string
  instructions?: string
  repoPath: string
  worktreePath?: string
  branch?: string
  commit?: string
  now?: string
}

export type PhaseSetInput = {
  flowId: string
  phaseId: string
  status?: string
  outcome?: string
  summary?: string
  notes?: string
  order?: number
  title?: string
  kind?: string
  now?: string
}

export type FlowOperations = {
  createFlow: (input: CreateFlowInput) => Promise<PersistedFlowMetadata>
  listFlows: (filter?: { repoPath?: string }) => Promise<PersistedFlowMetadata[]>
  readFlow: (flowId: string) => Promise<PersistedFlowMetadata>
  setPhase: (input: PhaseSetInput) => Promise<PersistedFlowMetadata>
  completePhase: (input: Omit<PhaseSetInput, 'status'>) => Promise<PersistedFlowMetadata>
  blockPhase: (input: Omit<PhaseSetInput, 'status'>) => Promise<PersistedFlowMetadata>
  needsAttentionPhase: (input: Omit<PhaseSetInput, 'status'>) => Promise<PersistedFlowMetadata>
  restartPhase: (input: Omit<PhaseSetInput, 'status'>) => Promise<PersistedFlowMetadata>
  linkPlan: (input: { flowId: string; planId: string; now?: string }) => Promise<PersistedFlowMetadata>
  updatePhase: (input: PhaseEditInput) => Promise<PersistedFlowMetadata>
}

export type PhaseEditInput = {
  flowId: string
  phaseId: string
  title?: string
  order?: number
  notes?: string
  now?: string
}

const PERSISTED_PHASE_STATUSES = new Set([
  'pending',
  'ready',
  'running',
  'needs_attention',
  'completed',
  'blocked',
  'skipped',
  'done',
  'active'
])
const AGENT_PHASE_STATUSES = new Set(['running', 'needs_attention', 'completed', 'blocked', 'skipped'])
const ALLOWED_PHASE_TRANSITIONS = new Map<string, Set<string>>([
  ['pending', new Set(['skipped'])],
  ['ready', new Set(['running', 'needs_attention', 'completed', 'blocked', 'skipped'])],
  ['running', new Set(['needs_attention', 'completed', 'blocked', 'skipped'])],
  ['needs_attention', new Set(['running', 'skipped'])],
  ['blocked', new Set(['running', 'skipped'])],
  ['completed', new Set(['running'])],
  ['skipped', new Set(['running'])],
  ['active', new Set(['running', 'needs_attention', 'completed', 'blocked', 'skipped'])],
  ['done', new Set(['running'])]
])
const PLAN_REVIEW_OUTCOMES = new Set([
  'approved',
  'approved_with_concerns',
  'changes_requested',
  'blocked'
])
const PLAN_REVIEW_NOTES_REQUIRED = new Set([
  'approved_with_concerns',
  'changes_requested',
  'blocked'
])
const DEFAULT_PHASE_COMPLETION_PROMOTIONS = new Map([
  ['implementation', 'review-loop-1'],
  ['review-loop-1', 'review-loop-2'],
  ['review-loop-2', 'pr-creation'],
  ['pr-creation', 'human-review']
])
const PHASE_STATUSES_REQUIRING_NOTES = new Set(['blocked', 'needs_attention', 'skipped'])
const SAFE_PHASE_OUTCOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function createFlowOperations(options: { artifactRoot: string }): FlowOperations {
  const flowsRoot = join(options.artifactRoot, 'flows')
  const planStore = createPlanStore(options)

  async function writeFlow(flow: PersistedFlowMetadata): Promise<PersistedFlowMetadata> {
    assertSafeArtifactId('Flow', flow.flow_id)
    const flowDir = join(flowsRoot, flow.flow_id)
    await ensurePrivateDirectory(flowDir)
    await writeJsonAtomically(join(flowDir, 'meta.json'), flow)
    return flow
  }

  async function readFlow(flowId: string): Promise<PersistedFlowMetadata> {
    assertSafeArtifactId('Flow', flowId)
    const flow = await readJsonArtifact(join(flowsRoot, flowId, 'meta.json'), flowId, isPersistedFlowMetadata)
    if (flow.flow_id !== flowId) {
      throw new ArtifactStoreError('corrupt_artifact', `Flow id mismatch: ${flowId}`, flowId)
    }
    return flow
  }

  return {
    async createFlow(input) {
      const now = input.now ?? new Date().toISOString()
      const flowId = input.id ?? createFlowId(input.title, now)
      assertSafeArtifactId('Flow', flowId)
      const flowDir = join(flowsRoot, flowId)
      await ensurePrivateDirectory(flowsRoot)
      try {
        await mkdir(flowDir, { mode: 0o700 })
      } catch (error) {
        if (isNodeErrorWithCode(error, 'EEXIST')) {
          throw new ArtifactStoreError('validation_error', `Flow already exists: ${flowId}`, flowId)
        }
        throw new ArtifactStoreError('write_failed', `Flow directory create failed: ${getErrorMessage(error)}`, flowId)
      }
      const flow: PersistedFlowMetadata = withoutUndefined({
        schema_version: 1,
        flow_id: flowId,
        title: input.title,
        instructions: input.instructions ?? '',
        status: 'active',
        repo_path: input.repoPath,
        worktree_path: input.worktreePath,
        branch: input.branch,
        commit: input.commit,
        created_at: now,
        updated_at: now,
        phases: createDefaultFlowPhases(now)
      })
      return writeFlow(flow)
    },

    async listFlows(filter = {}) {
      const flows: PersistedFlowMetadata[] = []
      for (const flowId of await listSafeDirectories(flowsRoot)) {
        try {
          const flow = await readFlow(flowId)
          if (filter.repoPath !== undefined && flow.repo_path !== filter.repoPath) {
            continue
          }
          flows.push(flow)
        } catch {
          continue
        }
      }
      return flows.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    },

    readFlow,

    async setPhase(input) {
      assertSafeArtifactId('phase', input.phaseId)
      const flow = await readFlow(input.flowId)
      const now = input.now ?? new Date().toISOString()
      const phases = [...(flow.phases ?? [])]
      const index = phases.findIndex((phase) => phase.phase_id === input.phaseId)
      const existing = index === -1 ? undefined : phases[index]

      if (existing === undefined && (
        input.title === undefined ||
        input.status === undefined ||
        input.order === undefined
      )) {
        throw new ArtifactStoreError(
          'validation_error',
          `Unknown phase requires --title, --status, and --order: ${input.phaseId}`,
          input.phaseId
        )
      }

      const nextStatus = input.status ?? existing?.status
      if (typeof nextStatus !== 'string' || !PERSISTED_PHASE_STATUSES.has(nextStatus)) {
        throw new ArtifactStoreError('validation_error', `Invalid phase status: ${String(nextStatus)}`)
      }
      validateAgentPhaseStatus(input.status)
      validatePlanReviewGate({
        phases,
        phase: existing,
        phaseId: input.phaseId,
        nextStatus
      })
      validatePhaseTransition({
        currentStatus: existing?.status,
        nextStatus,
        notes: input.notes
      })

      const nextKind = input.kind ?? existing?.kind
      validatePhaseNotes({
        kind: nextKind,
        status: nextStatus,
        outcome: input.outcome ?? existing?.outcome,
        notes: input.notes ?? existing?.notes
      })
      const nextTitle = input.title ?? existing?.title
      const nextOrder = input.order ?? existing?.order
      if (nextTitle === undefined || nextOrder === undefined) {
        throw new ArtifactStoreError(
          'validation_error',
          `Phase requires title and order: ${input.phaseId}`,
          input.phaseId
        )
      }

      const previousNotes = existing?.note_history ?? []
      const note_history = input.notes === undefined
        ? previousNotes
        : [...previousNotes, { created_at: now, note: input.notes, source: 'cli' }]

      const phase: PersistedFlowPhase = withoutUndefined({
        ...(existing ?? {}),
        phase_id: input.phaseId,
        title: nextTitle,
        kind: nextKind,
        status: nextStatus,
        order: nextOrder,
        outcome: input.outcome ?? existing?.outcome,
        summary: input.summary ?? existing?.summary,
        notes: input.notes ?? existing?.notes,
        note_history: note_history.length === 0 ? undefined : note_history,
        sessions: existing?.sessions,
        created_at: existing?.created_at ?? now,
        updated_at: now
      })

      if (index === -1) {
        phases.push(phase)
      } else {
        phases[index] = phase
      }

      let nextPhases = phases
      if (input.phaseId === 'plan' && nextStatus === 'completed' && flow.plan_id !== undefined) {
        nextPhases = promotePhase(nextPhases, 'plan-review', 'ready', now)
      }
      if (isPlanReviewApproval(phase)) {
        const drafts = await readLinkedImplementationDrafts(flow, planStore.readPlan)
        nextPhases = mergeGeneratedImplementationChildren(
          promotePhase(nextPhases, 'implementation', 'ready', now),
          flow.plan_id as string,
          drafts,
          now
        )
      }
      if (input.phaseId === 'implementation' && nextStatus === 'running') {
        nextPhases = nextPhases.map((candidate) =>
          candidate.parent_phase_id === 'implementation' && candidate.status === 'pending'
            ? { ...candidate, status: 'ready', updated_at: now }
            : candidate
        )
      }
      if (nextStatus === 'completed') {
        const nextDefaultPhaseId = DEFAULT_PHASE_COMPLETION_PROMOTIONS.get(input.phaseId)
        if (nextDefaultPhaseId !== undefined) {
          nextPhases = promotePhase(nextPhases, nextDefaultPhaseId, 'ready', now)
        }
      }
      if (implementationChildrenAreSettled(nextPhases)) {
        nextPhases = promotePhase(nextPhases, 'review-loop-1', 'ready', now)
      }

      return writeFlow({
        ...flow,
        phases: sortPersistedPhases(nextPhases),
        updated_at: now
      })
    },

    async completePhase(input) {
      await assertPhaseExists(readFlow, input.flowId, input.phaseId)
      return this.setPhase({ ...input, status: 'completed' })
    },

    async blockPhase(input) {
      await assertPhaseExists(readFlow, input.flowId, input.phaseId)
      if (input.notes === undefined || input.notes.trim() === '') {
        throw new ArtifactStoreError('validation_error', 'Blocking a phase requires notes.')
      }
      return this.setPhase({ ...input, status: 'blocked' })
    },

    async needsAttentionPhase(input) {
      await assertPhaseExists(readFlow, input.flowId, input.phaseId)
      if (input.notes === undefined || input.notes.trim() === '') {
        throw new ArtifactStoreError('validation_error', 'Marking a phase needs_attention requires notes.')
      }
      return this.setPhase({ ...input, status: 'needs_attention' })
    },

    async restartPhase(input) {
      await assertPhaseExists(readFlow, input.flowId, input.phaseId)
      return this.setPhase({
        ...input,
        status: 'running',
        notes: input.notes ?? 'Phase restarted for rerun.'
      })
    },

    async linkPlan(input) {
      const now = input.now ?? new Date().toISOString()
      const flow = await readFlow(input.flowId)
      const { metadata: plan } = await planStore.readPlan(input.planId)

      if (flow.plan_id !== undefined && flow.plan_id !== input.planId) {
        throw new ArtifactStoreError('validation_error', `Flow already links plan: ${flow.plan_id}`)
      }
      if (plan.flow_id !== undefined && plan.flow_id !== input.flowId) {
        throw new ArtifactStoreError('validation_error', `Plan already links Flow: ${plan.flow_id}`)
      }

      const flowPath = join(flowsRoot, input.flowId, 'meta.json')
      await planStore.updatePlanMetadata(input.planId, {
        flow_id: input.flowId,
        flow_path: flowPath,
        linked_at: plan.linked_at ?? now,
        updated_at: now
      })

      const phases = flow.phases ?? []
      const nextPhases = phases.some((phase) =>
        phase.phase_id === 'plan' && phase.status === 'completed'
      )
        ? promotePhase(phases, 'plan-review', 'ready', now)
        : phases

      return writeFlow({
        ...flow,
        plan_id: input.planId,
        plan_path: plan.plan_path,
        phases: nextPhases,
        updated_at: now
      })
    },

    async updatePhase(input) {
      assertSafeArtifactId('phase', input.phaseId)
      const flow = await readFlow(input.flowId)
      const now = input.now ?? new Date().toISOString()
      const phases = [...(flow.phases ?? [])]
      const index = phases.findIndex((phase) => phase.phase_id === input.phaseId)
      const existing = index === -1 ? undefined : phases[index]
      if (existing === undefined) {
        throw new ArtifactStoreError('validation_error', `Unknown phase: ${input.phaseId}`, input.phaseId)
      }
      validateEditablePhaseUpdate(existing, phases, input)
      phases[index] = withoutUndefined({
        ...existing,
        title: input.title ?? existing.title,
        order: input.order ?? existing.order,
        notes: input.notes ?? existing.notes,
        updated_at: now
      })
      return writeFlow({
        ...flow,
        phases: sortPersistedPhases(phases),
        updated_at: now
      })
    }
  }
}

export function validatePhaseNotes({
  kind,
  status,
  outcome,
  notes
}: {
  kind?: string
  status: string
  outcome?: string
  notes?: string
}): void {
  if (PHASE_STATUSES_REQUIRING_NOTES.has(status) && (notes === undefined || notes.trim() === '')) {
    throw new ArtifactStoreError('validation_error', `Phase status ${status} requires notes.`)
  }

  if (outcome === undefined) {
    return
  }

  if (kind === 'plan_review') {
    if (outcome !== undefined && !PLAN_REVIEW_OUTCOMES.has(outcome)) {
      throw new ArtifactStoreError('validation_error', `Invalid Plan Review outcome: ${outcome}`)
    }
    if (
      outcome !== undefined &&
      PLAN_REVIEW_NOTES_REQUIRED.has(outcome) &&
      (notes === undefined || notes.trim() === '')
    ) {
      throw new ArtifactStoreError('validation_error', `Plan Review outcome ${outcome} requires notes.`)
    }
    return
  }

  if (!SAFE_PHASE_OUTCOME.test(outcome)) {
    throw new ArtifactStoreError('validation_error', `Invalid phase outcome: ${outcome}`)
  }
}

function validatePlanReviewGate({
  phases,
  phase,
  phaseId,
  nextStatus
}: {
  phases: PersistedFlowPhase[]
  phase?: PersistedFlowPhase
  phaseId: string
  nextStatus: string
}): void {
  if (
    (phaseId !== 'implementation' && phase?.parent_phase_id !== 'implementation') ||
    (nextStatus !== 'running' && nextStatus !== 'completed')
  ) {
    return
  }

  const planReview = phases.find((candidate) => candidate.phase_id === 'plan-review')
  if (planReview === undefined) {
    if (phases.some((candidate) => candidate.phase_id === 'plan')) {
      throw new ArtifactStoreError(
        'validation_error',
        'Implementation requires a completed approving Plan Review.'
      )
    }
    return
  }
  if (isApprovingPlanReview(planReview)) {
    if (phase?.parent_phase_id === 'implementation') {
      const parent = phases.find((candidate) => candidate.phase_id === 'implementation')
      if (parent?.status !== 'running' && parent?.status !== 'completed') {
        throw new ArtifactStoreError(
          'validation_error',
          'Generated implementation phases cannot run before Implementation starts.'
        )
      }
    }
    return
  }

  throw new ArtifactStoreError(
    'validation_error',
    'Implementation requires a completed approving Plan Review.'
  )
}

function isPlanReviewApproval(phase: PersistedFlowPhase): boolean {
  return phase.phase_id === 'plan-review' && isApprovingPlanReview(phase)
}

function isApprovingPlanReview(phase: PersistedFlowPhase): boolean {
  return phase.status === 'completed' &&
    (phase.outcome === 'approved' || phase.outcome === 'approved_with_concerns')
}

function promotePhase(
  phases: PersistedFlowPhase[],
  phaseId: string,
  status: 'ready',
  now: string
): PersistedFlowPhase[] {
  return phases.map((phase) =>
    phase.phase_id === phaseId && phase.status === 'pending'
      ? { ...phase, status, updated_at: now }
      : phase
    )
}

function implementationChildrenAreSettled(phases: PersistedFlowPhase[]): boolean {
  const implementationChildren = phases.filter((phase) =>
    phase.parent_phase_id === 'implementation'
  )
  return implementationChildren.length > 0 &&
    implementationChildren.every((phase) =>
      phase.status === 'completed' ||
        (phase.status === 'skipped' && phase.notes !== undefined && phase.notes.trim() !== '')
    )
}

async function readLinkedImplementationDrafts(
  flow: PersistedFlowMetadata,
  readPlan: ReturnType<typeof createPlanStore>['readPlan']
): Promise<ImplementationPhaseDraft[]> {
  if (flow.plan_id === undefined || flow.plan_id.trim() === '') {
    throw new ArtifactStoreError(
      'validation_error',
      'Approving Plan Review requires a linked plan.'
    )
  }
  const plan = await readPlan(flow.plan_id)
  if (
    flow.plan_path !== undefined &&
    plan.metadata.plan_path !== undefined &&
    flow.plan_path !== plan.metadata.plan_path
  ) {
    throw new ArtifactStoreError(
      'validation_error',
      `Linked plan path mismatch for ${flow.plan_id}.`
    )
  }
  return extractImplementationPhaseDrafts(plan.body)
}

function mergeGeneratedImplementationChildren(
  phases: PersistedFlowPhase[],
  planId: string,
  drafts: ImplementationPhaseDraft[],
  now: string
): PersistedFlowPhase[] {
  const byId = new Map(phases.map((phase) => [phase.phase_id, phase]))
  const next = phases.map((phase) => ({ ...phase }))
  for (const draft of drafts) {
    const phaseId = `implementation-${draft.idBase}`
    const existing = byId.get(phaseId)
    if (existing === undefined) {
      next.push(withoutUndefined({
        phase_id: phaseId,
        title: draft.title,
        kind: 'implementation',
        status: 'pending',
        order: draft.order,
        notes: draft.notes,
        parent_phase_id: 'implementation',
        generated: true,
        editable: true,
        source_plan_id: planId,
        created_at: now,
        updated_at: now
      }))
      continue
    }
    if (existing.generated !== true || existing.parent_phase_id !== 'implementation') {
      throw new ArtifactStoreError(
        'validation_error',
        `Generated implementation phase id conflicts with existing phase: ${phaseId}`,
        phaseId
      )
    }
    const index = next.findIndex((phase) => phase.phase_id === phaseId)
    next[index] = withoutUndefined({
      ...existing,
      kind: existing.kind ?? 'implementation',
      parent_phase_id: existing.parent_phase_id ?? 'implementation',
      generated: true,
      editable: true,
      source_plan_id: planId,
      updated_at: now
    })
  }
  return next
}

function validateEditablePhaseUpdate(
  phase: PersistedFlowPhase,
  phases: PersistedFlowPhase[],
  input: PhaseEditInput
): void {
  if (phase.generated !== true || phase.editable !== true || phase.parent_phase_id !== 'implementation') {
    throw new ArtifactStoreError('validation_error', `Phase is not editable: ${phase.phase_id}`, phase.phase_id)
  }
  if (phase.status !== 'pending' && phase.status !== 'ready') {
    throw new ArtifactStoreError('validation_error', `Phase is locked: ${phase.phase_id}`, phase.phase_id)
  }
  if (input.title !== undefined && input.title.trim() === '') {
    throw new ArtifactStoreError('validation_error', 'Phase title cannot be empty.')
  }
  if (input.order !== undefined && !Number.isInteger(input.order)) {
    throw new ArtifactStoreError('validation_error', 'Phase order must be an integer.')
  }

  const nextTitle = input.title?.trim() ?? phase.title
  const nextOrder = input.order ?? phase.order
  const normalizedTitle = normalizePhaseTitle(nextTitle)
  const conflict = phases.find((candidate) =>
    candidate.phase_id !== phase.phase_id &&
    candidate.parent_phase_id === phase.parent_phase_id &&
    (candidate.order === nextOrder || normalizePhaseTitle(candidate.title) === normalizedTitle)
  )
  if (conflict !== undefined) {
    throw new ArtifactStoreError(
      'validation_error',
      `Phase edit conflicts with sibling phase: ${conflict.title}`,
      phase.phase_id
    )
  }
}

function normalizePhaseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

function sortPersistedPhases(phases: PersistedFlowPhase[]): PersistedFlowPhase[] {
  const topLevel = phases
    .filter((phase) => phase.parent_phase_id === undefined)
    .sort((left, right) => left.order - right.order)
  const children = new Map<string, PersistedFlowPhase[]>()
  for (const phase of phases) {
    if (phase.parent_phase_id === undefined) {
      continue
    }
    children.set(phase.parent_phase_id, [
      ...(children.get(phase.parent_phase_id) ?? []),
      phase
    ])
  }

  const sorted: PersistedFlowPhase[] = []
  const visit = (phase: PersistedFlowPhase): void => {
    sorted.push(phase)
    for (const child of (children.get(phase.phase_id) ?? []).sort((left, right) => left.order - right.order)) {
      visit(child)
    }
  }
  for (const phase of topLevel) {
    visit(phase)
  }
  const emitted = new Set(sorted.map((phase) => phase.phase_id))
  const orphans = phases
    .filter((phase) => !emitted.has(phase.phase_id))
    .sort((left, right) => left.order - right.order)
  return [...sorted, ...orphans]
}

function validateAgentPhaseStatus(status: string | undefined): void {
  if (status !== undefined && !AGENT_PHASE_STATUSES.has(status)) {
    throw new ArtifactStoreError(
      'validation_error',
      `Unsupported agent-facing phase status "${status}"; valid statuses: ${[...AGENT_PHASE_STATUSES].join(', ')}`
    )
  }
}

function validatePhaseTransition({
  currentStatus,
  nextStatus,
  notes
}: {
  currentStatus?: string
  nextStatus: string
  notes?: string
}): void {
  if (currentStatus === undefined || currentStatus === nextStatus) {
    return
  }

  const allowed = ALLOWED_PHASE_TRANSITIONS.get(currentStatus)
  if (allowed?.has(nextStatus)) {
    if (
      nextStatus === 'running' &&
      (currentStatus === 'needs_attention' || currentStatus === 'blocked') &&
      (notes === undefined || notes.trim() === '')
    ) {
      throw new ArtifactStoreError(
        'validation_error',
        `Invalid phase transition ${currentStatus} -> running; restart with --status running --notes before completing.`
      )
    }
    return
  }

  const allowedStatuses = allowed === undefined ? [] : [...allowed]
  const suffix = allowedStatuses.length === 0
    ? 'no allowed next statuses'
    : `allowed from ${currentStatus}: ${allowedStatuses.join(', ')}`
  const recoveryHint = (currentStatus === 'needs_attention' || currentStatus === 'blocked') &&
    nextStatus === 'completed'
    ? '; restart with --status running --notes before completing'
    : ''
  throw new ArtifactStoreError(
    'validation_error',
    `Invalid phase transition ${currentStatus} -> ${nextStatus}; ${suffix}${recoveryHint}`
  )
}

async function assertPhaseExists(
  readFlow: (flowId: string) => Promise<PersistedFlowMetadata>,
  flowId: string,
  phaseId: string
): Promise<void> {
  assertSafeArtifactId('phase', phaseId)
  const flow = await readFlow(flowId)
  if (!flow.phases?.some((phase) => phase.phase_id === phaseId)) {
    throw new ArtifactStoreError('validation_error', `Unknown phase: ${phaseId}`, phaseId)
  }
}

function isPersistedFlowMetadata(value: unknown): value is PersistedFlowMetadata {
  if (!isRecord(value)) {
    return false
  }

  return value.schema_version === 1 &&
    typeof value.flow_id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.repo_path === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    (value.phases === undefined || Array.isArray(value.phases))
}

function createFlowId(title: string, salt: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'flow'
  return `${slug}-${Math.abs(hashString(`${title}\0${salt}`)).toString(36).slice(0, 8)}`
}

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T
}
