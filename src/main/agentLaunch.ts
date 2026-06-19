import type { AgentLaunchMode, AgentProvider } from '@shared/workspace'

export type AgentLaunchContext = {
  provider: AgentProvider
  mode: AgentLaunchMode
  flowId: string
  phaseId: string
  planId?: string
  planPath?: string
  sessionId?: string
  launchId: string
  prompt: string
  repositoryPath: string
  worktreePath: string
  branch: string
  commit: string
  artifactRoots: {
    flowStateRoot?: string
    planStateRoot?: string
    sessionStateRoot?: string
  }
}

export type AgentLaunchCommand = {
  executable: AgentProvider
  argv: string[]
  cwd: string
  initialInput: string | null
  env: Record<string, string>
}

export function buildAgentLaunchCommand(context: AgentLaunchContext): AgentLaunchCommand {
  assertSupportedProvider(context.provider)

  if (context.mode === 'resume' && isBlank(context.sessionId)) {
    throw new Error('Resume launches require a session id.')
  }

  return {
    executable: context.provider,
    argv: buildArgv(context),
    cwd: requireText(context.worktreePath, 'Flow worktree path is required.'),
    initialInput: null,
    env: buildMetadataEnv(context)
  }
}

function buildArgv(context: AgentLaunchContext): string[] {
  const prompt = requireText(context.prompt, 'Launch prompt is required.')

  if (context.provider === 'codex') {
    switch (context.mode) {
      case 'headless':
        return ['exec', prompt]
      case 'interactive':
        return [prompt]
      case 'resume':
        return ['resume', context.sessionId as string]
      case 'continue':
        throw new Error('Codex continue-most-recent launches are not supported.')
    }
  }

  switch (context.mode) {
    case 'headless':
      return ['--print', prompt]
    case 'interactive':
      return [prompt]
    case 'resume':
      return ['--resume', context.sessionId as string]
    case 'continue':
      return ['--continue']
  }
}

function buildMetadataEnv(context: AgentLaunchContext): Record<string, string> {
  return withoutBlank({
    GRINDSTONE_STATE_ROOT: context.artifactRoots.flowStateRoot,
    GRINDSTONE_AGENT: context.provider,
    GRINDSTONE_FLOW_ID: context.flowId,
    GRINDSTONE_PHASE_ID: context.phaseId,
    GRINDSTONE_PLAN_ID: context.planId,
    GRINDSTONE_PLAN_PATH: context.planPath,
    GRINDSTONE_LAUNCH_ID: context.launchId,
    GRINDSTONE_REPO_PATH: context.repositoryPath,
    GRINDSTONE_WORKTREE_PATH: context.worktreePath,
    GRINDSTONE_BRANCH: context.branch,
    GRINDSTONE_COMMIT: context.commit,
    WTUI_AGENT: context.provider,
    WTUI_FLOW_ID: context.flowId,
    WTUI_FLOW_PHASE_ID: context.phaseId,
    WTUI_PLAN_ID: context.planId,
    WTUI_PLAN_PATH: context.planPath,
    WTUI_LAUNCH_ID: context.launchId,
    WTUI_REPO_PATH: context.repositoryPath,
    WTUI_WORKTREE_PATH: context.worktreePath,
    WTUI_BRANCH: context.branch,
    WTUI_COMMIT: context.commit,
    WTUI_FLOW_STATE_ROOT: context.artifactRoots.flowStateRoot,
    WTUI_PLAN_STATE_ROOT: context.artifactRoots.planStateRoot,
    WTUI_SESSION_STATE_ROOT: context.artifactRoots.sessionStateRoot
  })
}

function assertSupportedProvider(provider: AgentProvider): void {
  if (provider !== 'codex' && provider !== 'claude') {
    throw new Error(`Unsupported agent provider: ${provider}`)
  }
}

function requireText(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(message)
  }

  return value.trim()
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

function withoutBlank(value: Record<string, string | undefined>): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue !== undefined && entryValue.trim() !== '') {
      entries.push([key, entryValue])
    }
  }

  return Object.fromEntries(entries)
}
