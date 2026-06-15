import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensurePrivateDirectory, writeJsonAtomically } from './artifactStore'

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
}

export type FlowPhaseRunner = (context: FlowPhaseLaunchContext) => Promise<void>

export const noopFlowPhaseRunner: FlowPhaseRunner = async () => undefined

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
    created_at: now,
    updated_at: now
  })
}

export function createFlowPhaseLaunchId(): string {
  return `phase-launch-${randomUUID()}`
}
