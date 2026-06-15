import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { FlowReviewBehavior } from '@shared/artifacts'
import { ensurePrivateDirectory, writeJsonAtomically } from './artifactStore'

export type FlowReviewBehaviorRegistry = {
  byPhaseId?: Record<string, FlowReviewBehavior>
  byKind?: Record<string, FlowReviewBehavior>
  defaultBehavior?: FlowReviewBehavior
}

export type FlowPhaseLaunchContext = {
  artifactRoot: string
  launchId: string
  flowId: string
  phaseId: string
  phaseTitle: string
  phaseKind?: string
  repositoryPath: string
  worktreePath?: string
  branch?: string
  commit?: string
  planId?: string
  planPath?: string
  reviewBehavior?: FlowReviewBehavior
}

export type FlowPhaseRunner = (context: FlowPhaseLaunchContext) => Promise<void>

// The current app shell records a launch and transitions the phase to running.
// A real terminal/session runner is injected here when that integration exists.
export const noopFlowPhaseRunner: FlowPhaseRunner = async () => undefined

export const DEFAULT_REVIEW_BEHAVIOR: FlowReviewBehavior = {
  id: 'generic-review',
  prompt: 'Review the completed work for correctness, regressions, missing tests, and maintainability. Report blocking findings first.',
  runnerHint: 'generic-review'
}

export function resolveFlowReviewBehavior({
  phaseId,
  phaseKind,
  behaviors = {}
}: {
  phaseId: string
  phaseKind?: string
  behaviors?: FlowReviewBehaviorRegistry
}): FlowReviewBehavior {
  return behaviors.byPhaseId?.[phaseId] ??
    (phaseKind === undefined ? undefined : behaviors.byKind?.[phaseKind]) ??
    behaviors.defaultBehavior ??
    DEFAULT_REVIEW_BEHAVIOR
}

export async function createFlowPhaseLaunchRecord(
  context: FlowPhaseLaunchContext,
  now: string = new Date().toISOString()
): Promise<void> {
  const launchDir = join(context.artifactRoot, 'launches', context.launchId)
  await ensurePrivateDirectory(launchDir)
  await writeJsonAtomically(join(launchDir, 'meta.json'), {
    schema_version: 1,
    launch_id: context.launchId,
    flow_id: context.flowId,
    phase_id: context.phaseId,
    phase_title: context.phaseTitle,
    phase_kind: context.phaseKind,
    repo_path: context.repositoryPath,
    worktree_path: context.worktreePath,
    branch: context.branch,
    commit: context.commit,
    plan_id: context.planId,
    plan_path: context.planPath,
    review_behavior: context.reviewBehavior === undefined
      ? undefined
      : {
          id: context.reviewBehavior.id,
          prompt: context.reviewBehavior.prompt,
          runner_hint: context.reviewBehavior.runnerHint
        },
    created_at: now,
    updated_at: now
  })
}

export function createFlowPhaseLaunchId(): string {
  return `phase-launch-${randomUUID()}`
}
