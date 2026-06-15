import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedFlowMetadata, PersistedFlowPhase } from '@shared/artifacts'
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
}

const PERSISTED_PHASE_STATUSES = new Set([
  'running',
  'needs_attention',
  'completed',
  'blocked',
  'skipped',
  'done',
  'active'
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
    return readJsonArtifact(join(flowsRoot, flowId, 'meta.json'), flowId, isPersistedFlowMetadata)
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
        phases: []
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

      return writeFlow({
        ...flow,
        phases: phases.sort((left, right) => left.order - right.order),
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

      return writeFlow({
        ...flow,
        plan_id: input.planId,
        plan_path: plan.plan_path,
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
