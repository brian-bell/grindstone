import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  FlowFailureSummary,
  FlowListRow,
  FlowPhaseSummary,
  FlowTerminalSummary,
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
  terminals?: FlowTerminalSummary[]
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
  terminals?: FlowTerminalSummary[]
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
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    phases: mapPhases(metadata.phases),
    terminals: mapTerminals(metadata.terminals)
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
        kind: optionalString(phase.kind),
        outcome: optionalString(phase.outcome),
        summary: optionalString(phase.summary),
        updatedAt: optionalString(phase.updated_at)
      }
    ]
  })

  return phases.length === 0
    ? undefined
    : phases.sort((left, right) => left.order - right.order)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function mapTerminals(value: unknown): FlowTerminalSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const terminals = value.flatMap((terminal): FlowTerminalSummary[] => {
    if (
      !isRecord(terminal) ||
      typeof terminal.terminal_id !== 'string' ||
      !isSafeFlowId(terminal.terminal_id) ||
      typeof terminal.launch_id !== 'string' ||
      !isAgentProvider(terminal.provider) ||
      !isAgentLaunchMode(terminal.mode) ||
      typeof terminal.flow_id !== 'string' ||
      !isSafeFlowId(terminal.flow_id) ||
      typeof terminal.phase_id !== 'string' ||
      !isTerminalStatus(terminal.status) ||
      typeof terminal.command !== 'string' ||
      !Array.isArray(terminal.argv) ||
      !terminal.argv.every((entry) => typeof entry === 'string') ||
      typeof terminal.cwd !== 'string' ||
      typeof terminal.started_at !== 'string'
    ) {
      return []
    }

    return [
      {
        terminalId: terminal.terminal_id,
        launchId: terminal.launch_id,
        provider: terminal.provider,
        mode: terminal.mode,
        flowId: terminal.flow_id,
        phaseId: terminal.phase_id,
        planId: optionalString(terminal.plan_id),
        sessionId: optionalString(terminal.session_id),
        status: terminal.status,
        command: terminal.command,
        argv: terminal.argv,
        cwd: terminal.cwd,
        logPath: optionalString(terminal.log_path),
        startedAt: terminal.started_at,
        endedAt: optionalString(terminal.ended_at),
        exitCode: optionalNumber(terminal.exit_code),
        signal: optionalString(terminal.signal),
        recentOutput: optionalString(terminal.recent_output)
      }
    ]
  })

  return terminals.length === 0 ? undefined : terminals
}

function isAgentProvider(value: unknown): value is FlowTerminalSummary['provider'] {
  return value === 'codex' || value === 'claude'
}

function isAgentLaunchMode(value: unknown): value is FlowTerminalSummary['mode'] {
  return value === 'headless' ||
    value === 'interactive' ||
    value === 'resume' ||
    value === 'continue'
}

function isTerminalStatus(value: unknown): value is FlowTerminalSummary['status'] {
  return value === 'starting' ||
    value === 'running' ||
    value === 'exited' ||
    value === 'terminated' ||
    value === 'failed' ||
    value === 'dismissed'
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
    terminals: record.terminals === undefined ? undefined : record.terminals.map(toRawTerminal),
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
    terminals: update.terminals === undefined
      ? metadata.terminals
      : update.terminals.map(toRawTerminal),
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

function toRawTerminal(terminal: FlowTerminalSummary): RawFlowMetadata {
  return withoutUndefined({
    terminal_id: terminal.terminalId,
    launch_id: terminal.launchId,
    provider: terminal.provider,
    mode: terminal.mode,
    flow_id: terminal.flowId,
    phase_id: terminal.phaseId,
    plan_id: terminal.planId,
    session_id: terminal.sessionId,
    status: terminal.status,
    command: terminal.command,
    argv: terminal.argv,
    cwd: terminal.cwd,
    log_path: terminal.logPath,
    started_at: terminal.startedAt,
    ended_at: terminal.endedAt,
    exit_code: terminal.exitCode,
    signal: terminal.signal,
    recent_output: terminal.recentOutput
  })
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
