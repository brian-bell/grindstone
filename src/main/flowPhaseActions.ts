export type FlowPhaseLaunchContext = {
  artifactRoot: string
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
