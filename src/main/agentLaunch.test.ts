import { describe, expect, it } from 'vitest'
import { buildAgentLaunchCommand } from './agentLaunch'

const baseContext = {
  provider: 'codex' as const,
  mode: 'interactive' as const,
  flowId: 'ship-flow',
  phaseId: 'plan',
  planId: 'plan-123',
  planPath: '/state/plans/plan-123/plan.md',
  launchId: 'launch-123',
  prompt: 'Implement the approved plan.',
  repositoryPath: '/repos/grindstone',
  worktreePath: '/worktrees/grindstone-flow-ship-flow',
  branch: 'flow/ship-flow',
  commit: 'abc123',
  artifactRoots: {
    flowStateRoot: '/state',
    planStateRoot: '/state',
    sessionStateRoot: '/state'
  }
}

describe('agent launch command builder', () => {
  it('builds codex interactive launches with prompt argv and wtui metadata env', () => {
    const command = buildAgentLaunchCommand(baseContext)

    expect(command).toEqual({
      executable: 'codex',
      argv: ['Implement the approved plan.'],
      cwd: '/worktrees/grindstone-flow-ship-flow',
      initialInput: null,
      env: {
        WTUI_AGENT: 'codex',
        WTUI_FLOW_ID: 'ship-flow',
        WTUI_FLOW_PHASE_ID: 'plan',
        WTUI_PLAN_ID: 'plan-123',
        WTUI_PLAN_PATH: '/state/plans/plan-123/plan.md',
        WTUI_LAUNCH_ID: 'launch-123',
        WTUI_REPO_PATH: '/repos/grindstone',
        WTUI_WORKTREE_PATH: '/worktrees/grindstone-flow-ship-flow',
        WTUI_BRANCH: 'flow/ship-flow',
        WTUI_COMMIT: 'abc123',
        WTUI_FLOW_STATE_ROOT: '/state',
        WTUI_PLAN_STATE_ROOT: '/state',
        WTUI_SESSION_STATE_ROOT: '/state'
      }
    })
  })

  it.each([
    ['codex', 'headless', undefined, ['exec', 'Implement the approved plan.']],
    ['codex', 'resume', 'session-1', ['resume', 'session-1']],
    ['claude', 'headless', undefined, ['--print', 'Implement the approved plan.']],
    ['claude', 'interactive', undefined, ['Implement the approved plan.']],
    ['claude', 'resume', 'session-2', ['--resume', 'session-2']],
    ['claude', 'continue', undefined, ['--continue']]
  ] as const)('builds %s %s argv without stdin prompts', (provider, mode, sessionId, argv) => {
    expect(buildAgentLaunchCommand({
      ...baseContext,
      provider,
      mode,
      sessionId
    })).toMatchObject({
      executable: provider,
      argv,
      initialInput: null
    })
  })

  it('requires explicit session ids for resume launches', () => {
    expect(() => buildAgentLaunchCommand({
      ...baseContext,
      mode: 'resume'
    })).toThrow('Resume launches require a session id.')
  })

  it('rejects unsupported providers before spawn command construction', () => {
    expect(() => buildAgentLaunchCommand({
      ...baseContext,
      provider: 'codex-app' as never
    })).toThrow('Unsupported agent provider: codex-app')
  })
})
