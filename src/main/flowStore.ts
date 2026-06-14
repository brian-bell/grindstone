import { mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FlowListRow, FlowPhaseSummary, RepositoryRow } from '@shared/workspace'

export type FlowStore = {
  listFlowsForRepository: (repository: RepositoryRow) => Promise<FlowListRow[]>
  readFlow: (flowId: string) => Promise<FlowListRow | undefined>
}

export type CreateFlowStoreOptions = {
  artifactRoot: string
}

type RawFlowMetadata = Record<string, unknown>

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
        if (flow === undefined || flow.repositoryId !== repository.id) {
          continue
        }

        flows.push(flow)
      }

      return flows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    },

    async readFlow(flowId) {
      if (!isSafeFlowId(flowId)) {
        return undefined
      }

      return readFlowFromDirectory(flowsRoot, flowId)
    }
  }
}

async function readFlowFromDirectory(
  flowsRoot: string,
  flowId: string
): Promise<FlowListRow | undefined> {
  let metadata: RawFlowMetadata
  try {
    metadata = JSON.parse(await readFile(join(flowsRoot, flowId, 'meta.json'), 'utf8')) as RawFlowMetadata
  } catch {
    return undefined
  }

  return mapFlowMetadata(flowId, metadata)
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
    repositoryPath: metadata.repo_path,
    branch: optionalString(metadata.branch),
    worktreePath: optionalString(metadata.worktree_path),
    commit: optionalString(metadata.commit),
    planId: optionalString(metadata.plan_id),
    planPath: optionalString(metadata.plan_path),
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    phases: mapPhases(metadata.phases)
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeFlowId(flowId: string): boolean {
  return SAFE_FLOW_ID.test(flowId)
}

function createFatalStoreError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : 'Unknown error'
  return new Error(`Flow artifact store unavailable: ${detail}`)
}
