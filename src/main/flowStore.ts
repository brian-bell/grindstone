import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeFlowPullRequestMetadata, type PersistedFlowPhase } from '@shared/artifacts'
import type {
  FlowFailureSummary,
  FlowListRow,
  FlowPhaseSummary,
  FlowStartMetadata,
  RepositoryRow
} from '@shared/workspace'

export type FlowStore = {
  listFlowsForRepository: (repository: RepositoryRow) => Promise<FlowListRow[]>
  readFlow: (flowId: string) => Promise<FlowListRow | undefined>
  flowArtifactExists: (flowId: string) => Promise<boolean>
  createFlowRecord: (record: FlowRecordInput) => Promise<FlowListRow>
  updateFlowRecord: (flowId: string, update: FlowRecordUpdate) => Promise<FlowListRow>
}

export type CreateFlowStoreOptions = {
  artifactRoot: string
}

type RawFlowMetadata = Record<string, unknown>

export type FlowRecordInput = {
  id: string
  title: string
  instructions: string
  status: string
  repositoryPath: string
  branch?: string
  worktreePath?: string
  baseRef?: string
  commit?: string
  start?: FlowStartMetadata
  failure?: FlowFailureSummary
  phases?: PersistedFlowPhase[]
  createdAt: string
  updatedAt: string
}

export type FlowRecordUpdate = Partial<
  Pick<
    FlowRecordInput,
    'status' | 'branch' | 'worktreePath' | 'baseRef' | 'commit' | 'start' | 'updatedAt'
  >
> & {
  failure?: FlowFailureSummary | null
}

const SAFE_FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function createFlowStore(options: CreateFlowStoreOptions): Promise<FlowStore> {
  const artifactRoot = resolve(options.artifactRoot)
  const flowsRoot = join(artifactRoot, 'flows')

  try {
    await mkdir(flowsRoot, { recursive: true })
  } catch (error) {
    throw createFatalStoreError(error)
  }

  return {
    async listFlowsForRepository(repository) {
      let entries
      try {
        entries = await readdir(flowsRoot, { withFileTypes: true })
      } catch (error) {
        throw createFatalStoreError(error)
      }

      const flows: FlowListRow[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !isSafeFlowId(entry.name)) {
          continue
        }

        const flow = await readFlowFromDirectory(flowsRoot, entry.name)
        if (flow === undefined || !(await flowMatchesRepository(flow, repository))) {
          continue
        }

        flows.push(flow)
      }

      return flows.sort(compareFlowsByUpdatedAtDescending)
    },

    async readFlow(flowId) {
      if (!isSafeFlowId(flowId)) {
        return undefined
      }

      return readFlowFromDirectory(flowsRoot, flowId)
    },

    async flowArtifactExists(flowId) {
      if (!isSafeFlowId(flowId)) {
        return false
      }

      try {
        await stat(join(flowsRoot, flowId))
        return true
      } catch {
        return false
      }
    },

    async createFlowRecord(record) {
      if (!isSafeFlowId(record.id)) {
        throw new Error(`Unsafe Flow id: ${record.id}`)
      }

      const flowDir = join(flowsRoot, record.id)
      try {
        await mkdir(flowDir)
      } catch (error) {
        throw new Error(`Flow record already exists or cannot be created: ${getErrorMessage(error)}`)
      }

      const metadata = toRawMetadata(record)
      try {
        await writeMetadataAtomically(flowDir, metadata)
      } catch (error) {
        throw createFatalStoreError(error)
      }

      const row = await mapFlowMetadata(record.id, metadata)
      if (row === undefined) {
        throw new Error(`Created Flow record is unreadable: ${record.id}`)
      }

      return row
    },

    async updateFlowRecord(flowId, update) {
      if (!isSafeFlowId(flowId)) {
        throw new Error(`Unsafe Flow id: ${flowId}`)
      }

      const flowDir = join(flowsRoot, flowId)
      const existing = await readRawFlowFromDirectory(flowsRoot, flowId)
      if (existing === undefined) {
        throw new Error(`Flow record not found: ${flowId}`)
      }

      const metadata = applyMetadataUpdate(existing, update)
      try {
        await writeMetadataAtomically(flowDir, metadata)
      } catch (error) {
        throw createFatalStoreError(error)
      }

      const row = await mapFlowMetadata(flowId, metadata)
      if (row === undefined) {
        throw new Error(`Updated Flow record is unreadable: ${flowId}`)
      }

      return row
    }
  }
}

async function readFlowFromDirectory(
  flowsRoot: string,
  flowId: string
): Promise<FlowListRow | undefined> {
  const rawMetadata = await readRawFlowFromDirectory(flowsRoot, flowId)
  if (rawMetadata === undefined) {
    return undefined
  }

  return mapFlowMetadata(flowId, rawMetadata)
}

async function readRawFlowFromDirectory(
  flowsRoot: string,
  flowId: string
): Promise<RawFlowMetadata | undefined> {
  try {
    const parsedMetadata = JSON.parse(await readFile(join(flowsRoot, flowId, 'meta.json'), 'utf8'))
    return isRecord(parsedMetadata) ? parsedMetadata : undefined
  } catch {
    return undefined
  }
}

async function mapFlowMetadata(
  directoryFlowId: string,
  metadata: RawFlowMetadata
): Promise<FlowListRow | undefined> {
  if (
    metadata.schema_version !== 1 ||
    metadata.flow_id !== directoryFlowId ||
    !isSafeFlowId(directoryFlowId) ||
    typeof metadata.title !== 'string' ||
    typeof metadata.status !== 'string' ||
    typeof metadata.repo_path !== 'string' ||
    typeof metadata.created_at !== 'string' ||
    typeof metadata.updated_at !== 'string'
  ) {
    return undefined
  }

  let repositoryId: string
  try {
    repositoryId = await realpath(metadata.repo_path)
  } catch {
    return undefined
  }

  return {
    id: directoryFlowId,
    title: metadata.title,
    status: metadata.status,
    repositoryId,
    repositoryPath: repositoryId,
    instructions: optionalString(metadata.instructions),
    branch: optionalString(metadata.branch),
    worktreePath: optionalString(metadata.worktree_path),
    baseRef: optionalString(metadata.base_ref),
    commit: optionalString(metadata.commit),
    start: mapStartMetadata(metadata.start),
    failure: mapFailureSummary(metadata.failure),
    planId: optionalString(metadata.plan_id),
    planPath: optionalString(metadata.plan_path),
    pr: normalizeFlowPullRequestMetadata(metadata.pr),
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    phases: mapPhases(metadata.phases)
  }
}

function mapStartMetadata(value: unknown): FlowStartMetadata | undefined {
  if (
    !isRecord(value) ||
    typeof value.repository_path !== 'string' ||
    typeof value.worktree_path !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.base_ref !== 'string' ||
    typeof value.commit !== 'string'
  ) {
    return undefined
  }

  return {
    repositoryPath: value.repository_path,
    worktreePath: value.worktree_path,
    branch: value.branch,
    baseRef: value.base_ref,
    commit: value.commit
  }
}

function mapFailureSummary(value: unknown): FlowFailureSummary | undefined {
  if (
    !isRecord(value) ||
    !isFailureStage(value.stage) ||
    typeof value.message !== 'string'
  ) {
    return undefined
  }

  return {
    stage: value.stage,
    message: value.message,
    command: optionalString(value.command),
    output: optionalString(value.output)
  }
}

function isFailureStage(value: unknown): value is FlowFailureSummary['stage'] {
  return value === 'validation' ||
    value === 'worktree' ||
    value === 'bootstrap' ||
    value === 'launch_prep'
}

function mapPhases(value: unknown): FlowPhaseSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const phases = value.flatMap((phase): FlowPhaseSummary[] => {
    if (
      !isRecord(phase) ||
      typeof phase.phase_id !== 'string' ||
      typeof phase.title !== 'string' ||
      typeof phase.status !== 'string' ||
      typeof phase.order !== 'number'
    ) {
      return []
    }

    return [
      {
        id: phase.phase_id,
        title: phase.title,
        status: phase.status,
        order: phase.order,
        parentPhaseId: optionalString(phase.parent_phase_id),
        kind: normalizedPhaseKind(phase),
        outcome: optionalString(phase.outcome),
        summary: optionalString(phase.summary),
        notes: optionalString(phase.notes),
        launchIds: launchIdsFromPhase(phase),
        generated: optionalBoolean(phase.generated),
        editable: optionalBoolean(phase.editable),
        sourcePlanId: optionalString(phase.source_plan_id),
        updatedAt: optionalString(phase.updated_at)
      }
    ]
  })

  return phases.length === 0
    ? undefined
    : sortPhaseSummaries(phases)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizedPhaseKind(phase: Record<string, unknown>): string | undefined {
  if (
    phase.parent_phase_id === 'implementation' &&
    optionalBoolean(phase.generated) === true &&
    optionalBoolean(phase.editable) === true
  ) {
    return 'implementation_child'
  }
  return optionalString(phase.kind)
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return undefined
  }

  return value
}

function launchIdsFromPhase(phase: Record<string, unknown>): string[] | undefined {
  const ids = new Set(optionalStringArray(phase.launch_ids) ?? [])
  if (Array.isArray(phase.sessions)) {
    for (const session of phase.sessions) {
      if (isRecord(session) && typeof session.launch_id === 'string' && session.launch_id !== '') {
        ids.add(session.launch_id)
      }
    }
  }
  return ids.size === 0 ? undefined : [...ids]
}

function sortPhaseSummaries(phases: FlowPhaseSummary[]): FlowPhaseSummary[] {
  const topLevel = phases
    .filter((phase) => phase.parentPhaseId === undefined)
    .sort((left, right) => left.order - right.order)
  const children = new Map<string, FlowPhaseSummary[]>()
  for (const phase of phases) {
    if (phase.parentPhaseId === undefined) {
      continue
    }
    children.set(phase.parentPhaseId, [
      ...(children.get(phase.parentPhaseId) ?? []),
      phase
    ])
  }

  const sorted: FlowPhaseSummary[] = []
  const visit = (phase: FlowPhaseSummary): void => {
    sorted.push(phase)
    for (const child of (children.get(phase.id) ?? []).sort((left, right) => left.order - right.order)) {
      visit(child)
    }
  }
  for (const phase of topLevel) {
    visit(phase)
  }
  const emitted = new Set(sorted.map((phase) => phase.id))
  return [
    ...sorted,
    ...phases
      .filter((phase) => !emitted.has(phase.id))
      .sort((left, right) => left.order - right.order)
  ]
}

async function flowMatchesRepository(
  flow: FlowListRow,
  repository: RepositoryRow
): Promise<boolean> {
  if (flow.repositoryId === repository.id) {
    return true
  }

  if (flow.worktreePath === undefined) {
    return false
  }

  try {
    return await realpath(flow.worktreePath) === repository.id
  } catch {
    return false
  }
}

function compareFlowsByUpdatedAtDescending(left: FlowListRow, right: FlowListRow): number {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  const leftTimeIsValid = !Number.isNaN(leftTime)
  const rightTimeIsValid = !Number.isNaN(rightTime)

  if (leftTimeIsValid && rightTimeIsValid && leftTime !== rightTime) {
    return rightTime - leftTime
  }

  if (leftTimeIsValid !== rightTimeIsValid) {
    return leftTimeIsValid ? -1 : 1
  }

  return right.updatedAt.localeCompare(left.updatedAt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeFlowId(flowId: string): boolean {
  return SAFE_FLOW_ID.test(flowId)
}

function toRawMetadata(record: FlowRecordInput): RawFlowMetadata {
  return withoutUndefined({
    schema_version: 1,
    flow_id: record.id,
    title: record.title,
    instructions: record.instructions,
    status: record.status,
    repo_path: record.repositoryPath,
    branch: record.branch,
    worktree_path: record.worktreePath,
    base_ref: record.baseRef,
    commit: record.commit,
    start: record.start === undefined ? undefined : toRawStart(record.start),
    failure: record.failure === undefined ? undefined : withoutUndefined(record.failure),
    phases: record.phases,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  })
}

function applyMetadataUpdate(
  metadata: RawFlowMetadata,
  update: FlowRecordUpdate
): RawFlowMetadata {
  return withoutUndefined({
    ...metadata,
    status: update.status ?? metadata.status,
    branch: update.branch ?? metadata.branch,
    worktree_path: update.worktreePath ?? metadata.worktree_path,
    base_ref: update.baseRef ?? metadata.base_ref,
    commit: update.commit ?? metadata.commit,
    start: update.start === undefined ? metadata.start : toRawStart(update.start),
    failure: update.failure === undefined
      ? metadata.failure
      : update.failure === null
        ? undefined
        : withoutUndefined(update.failure),
    updated_at: update.updatedAt ?? metadata.updated_at
  })
}

function toRawStart(start: FlowStartMetadata): RawFlowMetadata {
  return {
    repository_path: start.repositoryPath,
    worktree_path: start.worktreePath,
    branch: start.branch,
    base_ref: start.baseRef,
    commit: start.commit
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T
}

async function writeMetadataAtomically(flowDir: string, metadata: RawFlowMetadata): Promise<void> {
  const tempPath = join(flowDir, `.meta.json.${process.pid}.${randomUUID()}.tmp`)
  let tempFile: Awaited<ReturnType<typeof open>> | undefined

  try {
    tempFile = await open(tempPath, 'w', 0o600)
    await tempFile.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    await tempFile.sync()
    await tempFile.close()
    tempFile = undefined
    await rename(tempPath, join(flowDir, 'meta.json'))
    await syncDirectory(flowDir)
  } catch (error) {
    await tempFile?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

function createFatalStoreError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : 'Unknown error'
  return new Error(`Flow artifact store unavailable: ${detail}`)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
