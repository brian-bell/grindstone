import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SavedPlanMetadata, SavedPlanStatus } from '@shared/artifacts'
import {
  ArtifactStoreError,
  assertSafeArtifactId,
  ensurePrivateDirectory,
  getErrorMessage,
  listSafeDirectories,
  readJsonArtifact,
  readTextArtifact,
  writeJsonAtomically,
  writeTextAtomically
} from './artifactStore'

export type SavePlanInput = {
  planId?: string
  title: string
  status?: SavedPlanStatus
  repoPath?: string
  worktreePath?: string
  branch?: string
  body: string
  now?: string
}

export type SavedPlanRecord = {
  metadata: SavedPlanMetadata
  body: string
}

export type PlanStore = {
  savePlan: (input: SavePlanInput) => Promise<SavedPlanMetadata>
  readPlan: (planId: string) => Promise<SavedPlanRecord>
  listPlans: (filter?: { repoPath?: string; flowId?: string }) => Promise<SavedPlanMetadata[]>
  updatePlanMetadata: (planId: string, update: Partial<SavedPlanMetadata>) => Promise<SavedPlanMetadata>
}

export function createPlanStore(options: { artifactRoot: string }): PlanStore {
  const plansRoot = join(options.artifactRoot, 'plans')

  return {
    async savePlan(input) {
      const now = input.now ?? new Date().toISOString()
      const planId = input.planId ?? createPlanId(input.title, now)
      assertSafeArtifactId('plan', planId)
      const status = input.status ?? 'draft'
      validatePlanStatus(status)
      const planDir = join(plansRoot, planId)
      await ensurePrivateDirectory(plansRoot)
      try {
        await mkdir(planDir, { mode: 0o700 })
      } catch (error) {
        if (isNodeErrorWithCode(error, 'EEXIST')) {
          throw new ArtifactStoreError('validation_error', `Plan already exists: ${planId}`, planId)
        }
        throw new ArtifactStoreError('write_failed', `Plan directory create failed: ${getErrorMessage(error)}`, planId)
      }
      const planPath = join(planDir, 'plan.md')
      const metadata: SavedPlanMetadata = withoutUndefined({
        schema_version: 1,
        plan_id: planId,
        title: input.title,
        status,
        repo_path: input.repoPath,
        worktree_path: input.worktreePath,
        branch: input.branch,
        plan_path: planPath,
        created_at: now,
        updated_at: now
      })

      await writeTextAtomically(planPath, input.body)
      await writeJsonAtomically(join(planDir, 'meta.json'), metadata)
      return metadata
    },

    async readPlan(planId) {
      assertSafeArtifactId('plan', planId)
      const planDir = join(plansRoot, planId)
      const metadata = await readJsonArtifact(
        join(planDir, 'meta.json'),
        planId,
        isSavedPlanMetadata
      )
      if (metadata.plan_id !== planId) {
        throw new ArtifactStoreError('corrupt_artifact', `Plan id mismatch: ${planId}`, planId)
      }
      const planPath = join(planDir, 'plan.md')
      const body = await readTextArtifact(planPath, planId)
      return {
        metadata: {
          ...metadata,
          plan_path: planPath
        },
        body
      }
    },

    async listPlans(filter = {}) {
      const plans: SavedPlanMetadata[] = []
      for (const planId of await listSafeDirectories(plansRoot)) {
        try {
          const { metadata } = await this.readPlan(planId)
          if (filter.repoPath !== undefined && metadata.repo_path !== filter.repoPath) {
            continue
          }
          if (filter.flowId !== undefined && metadata.flow_id !== filter.flowId) {
            continue
          }
          plans.push(metadata)
        } catch {
          continue
        }
      }

      return plans.sort(compareUpdatedAtDescending)
    },

    async updatePlanMetadata(planId, update) {
      const { metadata } = await this.readPlan(planId)
      const nextMetadata = withoutUndefined({
        ...metadata,
        ...update,
        plan_id: planId,
        schema_version: 1 as const
      }) as SavedPlanMetadata
      await writeJsonAtomically(join(plansRoot, planId, 'meta.json'), nextMetadata)
      return nextMetadata
    }
  }
}

export function createPlanId(title: string, salt: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'plan'
  const hash = createHash('sha256').update(`${title}\0${salt}`).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

export function validatePlanStatus(status: string): asserts status is SavedPlanStatus {
  if (!isSavedPlanStatus(status)) {
    throw new ArtifactStoreError('validation_error', `Invalid plan status: ${status}`)
  }
}

function isSavedPlanMetadata(value: unknown): value is SavedPlanMetadata {
  if (!isRecord(value)) {
    return false
  }

  return value.schema_version === 1 &&
    typeof value.plan_id === 'string' &&
    typeof value.title === 'string' &&
    isSavedPlanStatus(value.status) &&
    (value.plan_path === undefined || typeof value.plan_path === 'string') &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
}

function isSavedPlanStatus(status: unknown): status is SavedPlanStatus {
  return status === 'draft' ||
    status === 'approved' ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'blocked' ||
    status === 'superseded' ||
    status === 'archived'
}

function compareUpdatedAtDescending(left: SavedPlanMetadata, right: SavedPlanMetadata): number {
  return Date.parse(right.updated_at) - Date.parse(left.updated_at)
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
