import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import type { FlowListRow, FlowTerminalSummary, RepositoryRow } from '@shared/workspace'
import {
  createFlowInWorkspace,
  createRepositoryInWorkspace,
  getCurrentEditableConfig,
  launchFlowPhaseInWorkspace,
  listFlowTerminals,
  loadInitialWorkspaceState,
  readLinkedFlowPlan,
  recordFlowHumanReviewInWorkspace,
  recordFlowMergeInWorkspace,
  recordFlowPullRequestInWorkspace,
  registerWorkspaceHandlers,
  retryRepositoryRemoteInWorkspace,
  selectRepository,
  updateCommonConfig,
  completeFlowPhaseInWorkspace,
  skipFlowPhaseInWorkspace,
  updateFlowPhaseInWorkspace
} from './workspaceHandlers'
import { createFlowStore, type FlowStore } from './flowStore'
import type { FlowCommandRunner } from './flowCreation'
import type { FlowPhaseRunner } from './flowPhaseActions'
import { CommandRunError, type CommandRunner } from './repositoryCreation'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-workspace-'))
}

async function makeGitRepository(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
}

async function writeFlowMeta(
  artifactRoot: string,
  flowId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const flowDir = join(artifactRoot, 'flows', flowId)
  await mkdir(flowDir, { recursive: true })
  await writeFile(join(flowDir, 'meta.json'), JSON.stringify(metadata, null, 2))
}

function flowMeta(
  flowId: string,
  repositoryPath: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: 1,
    flow_id: flowId,
    title: `Flow ${flowId}`,
    status: 'active',
    repo_path: repositoryPath,
    created_at: '2026-06-10T10:00:00.000Z',
    updated_at: '2026-06-10T10:00:00.000Z',
    ...overrides
  }
}

function flowRow(flowId: string, repository: RepositoryRow): FlowListRow {
  return {
    id: flowId,
    title: `Flow ${flowId}`,
    status: 'active',
    repositoryId: repository.id,
    repositoryPath: repository.id,
    merge: { status: 'pending' },
    createdAt: '2026-06-10T10:00:00.000Z',
    updatedAt: '2026-06-10T10:00:00.000Z'
  }
}

function readOnlyFlowStore(
  listFlowsForRepository: FlowStore['listFlowsForRepository']
): FlowStore {
  return {
    async readFlow() {
      return undefined
    },
    async flowArtifactExists() {
      return false
    },
    listFlowsForRepository,
    async createFlowRecord() {
      throw new Error('createFlowRecord is not expected in this test.')
    },
    async updateFlowRecord() {
      throw new Error('updateFlowRecord is not expected in this test.')
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('workspace main handlers', () => {
  it('loads repository catalog state from configured explicit repos', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-alpha')
    const missingRepoPath = join(root, 'missing-repo')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}", "${missingRepoPath}"]\n`)

    const state = await loadInitialWorkspaceState({ configPath })

    expect(state.repository).toMatchObject({
      status: 'ready',
      selectedRepositoryId: null,
      repositories: [
        {
          name: 'repo-alpha',
          path: repoPath,
          sources: ['explicit']
        }
      ],
      diagnostics: [
        {
          severity: 'warning',
          code: 'explicit_repo_missing',
          configuredPath: missingRepoPath,
          resolvedPath: missingRepoPath
        }
      ]
    })
    expect(state.flow).toMatchObject({
      title: 'No Flow selected'
    })
  })

  it('surfaces config errors as repository catalog errors without scanning', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, 'repos = "not-an-array"\n')

    await expect(loadInitialWorkspaceState({ configPath })).resolves.toMatchObject({
      repository: {
        status: 'error',
        repositories: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'config_type_error',
            configuredPath: 'repos',
            resolvedPath: configPath
          }
        ]
      }
    })
  })

  it('selects a repository and returns its artifact-backed Flow list', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-beta')
    const otherRepoPath = join(root, 'repo-other')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(otherRepoPath)
    await writeFlowMeta(
      artifactRoot,
      'repo-beta-flow',
      flowMeta('repo-beta-flow', repoPath, {
        title: 'Repo beta delivery',
        updated_at: '2026-06-11T10:00:00.000Z'
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'repo-other-flow',
      flowMeta('repo-other-flow', otherRepoPath, {
        title: 'Other repo delivery',
        updated_at: '2026-06-12T10:00:00.000Z'
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}", "${otherRepoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''

    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: repositoryId
      },
      flow: {
        status: 'ready',
        repositoryId,
        repositoryName: 'repo-beta',
        flows: [
          {
            id: 'repo-beta-flow',
            title: 'Repo beta delivery',
            repositoryId
          }
        ]
      }
    })
  })

  it('reads a CLI-linked plan only through the selected Flow context', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-plan')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    const planDir = join(artifactRoot, 'plans', 'plan-one')
    await mkdir(planDir, { recursive: true })
    await writeFile(join(planDir, 'plan.md'), '# Linked Plan\n')
    await writeFile(join(planDir, 'meta.json'), JSON.stringify({
      schema_version: 1,
      plan_id: 'plan-one',
      title: 'Plan One',
      status: 'in_progress',
      created_at: '2026-06-15T10:00:00.000Z',
      updated_at: '2026-06-15T10:00:00.000Z'
    }))
    await writeFlowMeta(
      artifactRoot,
      'flow-one',
      flowMeta('flow-one', repoPath, {
        plan_id: 'plan-one',
        plan_path: join(artifactRoot, 'plans', 'plan-one', 'plan.md')
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(readLinkedFlowPlan({ flowId: 'flow-one' })).resolves.toMatchObject({
      status: 'ready',
      metadata: {
        plan_id: 'plan-one',
        title: 'Plan One'
      },
      body: '# Linked Plan\n'
    })
    await expect(readLinkedFlowPlan({ flowId: 'missing-flow' })).resolves.toMatchObject({
      status: 'missing',
      flowId: 'missing-flow'
    })
  })

  it('updates generated implementation child phases through the selected Flow context', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-edit-phase')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-edit-phase',
      flowMeta('flow-edit-phase', repoPath, {
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          },
          {
            phase_id: 'implementation-first-slice',
            title: 'First slice',
            kind: 'implementation_child',
            status: 'pending',
            order: 1,
            parent_phase_id: 'implementation',
            generated: true,
            editable: true,
            source_plan_id: 'plan-one'
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(updateFlowPhaseInWorkspace({
      flowId: 'flow-edit-phase',
      phaseId: 'implementation-first-slice',
      title: 'Edited slice',
      order: 2,
      notes: 'Edited notes'
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            id: 'flow-edit-phase',
            phases: [
              expect.objectContaining({ id: 'implementation' }),
              expect.objectContaining({
                id: 'implementation-first-slice',
                title: 'Edited slice',
                order: 2,
                parentPhaseId: 'implementation',
                generated: true,
                editable: true,
                notes: 'Edited notes',
                sourcePlanId: 'plan-one'
              })
            ]
          })
        ]
      }
    })
  })

  it('rejects malformed Flow phase edit payloads before updating artifacts', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-invalid-edit-phase')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-invalid-edit-phase',
      flowMeta('flow-invalid-edit-phase', repoPath, {
        phases: [
          {
            phase_id: 'implementation-first-slice',
            title: 'First slice',
            kind: 'implementation_child',
            status: 'pending',
            order: 1,
            parent_phase_id: 'implementation',
            generated: true,
            editable: true
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(updateFlowPhaseInWorkspace({
      flowId: 'flow-invalid-edit-phase',
      phaseId: 'implementation-first-slice',
      title: 42
    } as never)).rejects.toThrow('Update Flow phase request is invalid.')
    await expect(updateFlowPhaseInWorkspace({
      flowId: 'flow-invalid-edit-phase',
      phaseId: 'implementation-first-slice',
      order: '2'
    } as never)).rejects.toThrow('Update Flow phase request is invalid.')
    await expect(updateFlowPhaseInWorkspace({
      flowId: 'flow-invalid-edit-phase',
      phaseId: 'implementation-first-slice',
      order: 1.5
    })).rejects.toThrow('Update Flow phase request is invalid.')
    await expect(updateFlowPhaseInWorkspace({
      flowId: 'flow-invalid-edit-phase',
      phaseId: 'implementation-first-slice',
      notes: false
    } as never)).rejects.toThrow('Update Flow phase request is invalid.')
  })

  it('launches parent Implementation with the selected Flow context and returns refreshed state', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-implementation')
    const worktreePath = join(root, 'repo-launch-implementation-worktree')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-implementation',
      flowMeta('flow-launch-implementation', repoPath, {
        branch: 'flow/launch-implementation',
        worktree_path: worktreePath,
        commit: 'abc123',
        plan_id: 'plan-launch',
        plan_path: join(artifactRoot, 'plans', 'plan-launch', 'plan.md'),
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          },
          {
            phase_id: 'implementation-api',
            title: 'API slice',
            kind: 'implementation_child',
            status: 'pending',
            parent_phase_id: 'implementation',
            order: 1
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-launch-implementation',
      phaseId: 'implementation',
      summary: 'Do not complete before launch.'
    })).rejects.toThrow('Phase is not running: implementation')
    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-implementation',
      phaseId: 'implementation'
    }, { runPhase })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            id: 'flow-launch-implementation',
            phases: expect.arrayContaining([
              expect.objectContaining({ id: 'implementation', status: 'running' }),
              expect.objectContaining({ id: 'implementation-api', status: 'ready' })
            ])
          })
        ]
      }
    })
    expect(runPhase).toHaveBeenCalledWith({
      artifactRoot,
      launchId: expect.stringMatching(/^phase-launch-/),
      flowId: 'flow-launch-implementation',
      phaseId: 'implementation',
      phaseTitle: 'Implementation',
      phaseKind: 'implementation',
      repositoryPath: expect.any(String),
      worktreePath,
      branch: 'flow/launch-implementation',
      commit: 'abc123',
      planId: 'plan-launch',
      planPath: join(artifactRoot, 'plans', 'plan-launch', 'plan.md')
    })
    const launchId = runPhase.mock.calls[0]?.[0].launchId ?? ''
    const launchMetadata = JSON.parse(
      await readFile(join(artifactRoot, 'launches', launchId, 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(launchMetadata).toMatchObject({
      flow_id: 'flow-launch-implementation',
      phase_id: 'implementation',
      repo_path: expect.any(String),
      worktree_path: worktreePath,
      branch: 'flow/launch-implementation',
      commit: 'abc123',
      plan_id: 'plan-launch',
      plan_path: join(artifactRoot, 'plans', 'plan-launch', 'plan.md')
    })
  })

  it('launches implementation child phases with the child phase id', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-child')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-child',
      flowMeta('flow-launch-child', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'running',
            order: 3
          },
          {
            phase_id: 'implementation-api',
            title: 'API slice',
            kind: 'implementation_child',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 1
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-child',
      phaseId: 'implementation-api'
    }, { runPhase })

    expect(runPhase).toHaveBeenCalledWith(expect.objectContaining({
      flowId: 'flow-launch-child',
      phaseId: 'implementation-api',
      phaseTitle: 'API slice',
      launchId: expect.stringMatching(/^phase-launch-/)
    }))
  })

  it('uses an explicit phase runner instead of launching a terminal', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-explicit-runner')
    const worktreePath = join(root, 'worktree-launch-explicit-runner')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(worktreePath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-explicit-runner',
      flowMeta('flow-launch-explicit-runner', repoPath, {
        branch: 'flow/launch-explicit-runner',
        worktree_path: worktreePath,
        commit: 'abc123',
        start: {
          repository_path: repoPath,
          worktree_path: worktreePath,
          branch: 'flow/launch-explicit-runner',
          base_ref: 'main',
          commit: 'abc123'
        },
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)
    const terminalManager = {
      launchTerminal: vi.fn(async () => {
        throw new Error('terminal launch should not run')
      }),
      async listTerminals() {
        return []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-explicit-runner',
      phaseId: 'implementation'
    }, { runPhase, terminalManager })

    expect(runPhase).toHaveBeenCalledWith(expect.objectContaining({
      flowId: 'flow-launch-explicit-runner',
      phaseId: 'implementation'
    }))
    expect(terminalManager.launchTerminal).not.toHaveBeenCalled()
  })

  it('launches the parent Implementation phase in an embedded terminal by default', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-implementation-terminal')
    const worktreePath = join(root, 'worktree-launch-implementation-terminal')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(worktreePath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-implementation-terminal',
      flowMeta('flow-launch-implementation-terminal', repoPath, {
        branch: 'flow/launch-implementation-terminal',
        worktree_path: worktreePath,
        commit: 'abc123',
        start: {
          repository_path: repoPath,
          worktree_path: worktreePath,
          branch: 'flow/launch-implementation-terminal',
          base_ref: 'main',
          commit: 'abc123'
        },
        plan_id: 'plan-launch-terminal',
        plan_path: join(artifactRoot, 'plans', 'plan-launch-terminal', 'plan.md'),
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\ndefault_agent = "claude"\nartifact_root = "${artifactRoot}"\n`)
    const launched: Array<{
      flow: FlowListRow
      provider: string
      mode: string
      phaseId: string
      prompt: string
      launchId?: string
    }> = []
    const terminalManager = {
      async launchTerminal(request: {
        flow: FlowListRow
        provider: FlowTerminalSummary['provider']
        mode: FlowTerminalSummary['mode']
        phaseId: string
        prompt: string
        launchId?: string
      }) {
        launched.push(request)
        const store = await createFlowStore({ artifactRoot })
        const terminal: FlowTerminalSummary = {
          terminalId: 'terminal-implementation',
          launchId: request.launchId ?? 'missing-launch-id',
          provider: request.provider,
          mode: request.mode,
          flowId: request.flow.id,
          phaseId: request.phaseId,
          planId: request.flow.planId,
          status: 'running',
          command: request.provider,
          argv: [request.prompt],
          cwd: request.flow.worktreePath ?? '',
          startedAt: '2026-06-14T12:10:00.000Z',
          recentOutput: 'Implementation terminal ready.'
        }
        await store.updateFlowRecord(request.flow.id, {
          terminals: [terminal],
          updatedAt: '2026-06-14T12:10:00.000Z'
        })
        return terminal
      },
      async listTerminals(request: { flowId: string }) {
        const store = await createFlowStore({ artifactRoot })
        return (await store.readFlow(request.flowId))?.terminals ?? []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-implementation-terminal',
      phaseId: 'implementation'
    }, { terminalManager })

    expect(launched).toHaveLength(1)
    const launchedRequest = launched[0]
    expect(launchedRequest).toMatchObject({
      flow: expect.objectContaining({
        id: 'flow-launch-implementation-terminal',
        start: expect.objectContaining({ commit: 'abc123' }),
        phases: expect.arrayContaining([
          expect.objectContaining({
            id: 'implementation',
            status: 'running',
            launchIds: [expect.stringMatching(/^phase-launch-/)]
          })
        ])
      }),
      provider: 'claude',
      mode: 'headless',
      phaseId: 'implementation',
      launchId: expect.stringMatching(/^phase-launch-/)
    })
    expect(launchedRequest?.prompt).toContain('Implement the approved plan')
    expect(launchedRequest?.prompt).toContain('wtui-flow')
    const phaseLaunchId = launchedRequest?.flow.phases
      ?.find((phase) => phase.id === 'implementation')
      ?.launchIds?.[0]
    expect(launchedRequest?.launchId).toBe(phaseLaunchId)
    expect(result.flow).toMatchObject({
      status: 'ready',
      flows: [
        expect.objectContaining({
          id: 'flow-launch-implementation-terminal',
          phases: expect.arrayContaining([
            expect.objectContaining({
              id: 'implementation',
              status: 'running',
              launchIds: [launchedRequest?.launchId]
            })
          ]),
          terminals: [
            expect.objectContaining({
              terminalId: 'terminal-implementation',
              launchId: launchedRequest?.launchId,
              phaseId: 'implementation',
              mode: 'headless',
              provider: 'claude',
              status: 'running',
              recentOutput: 'Implementation terminal ready.'
            })
          ]
        })
      ]
    })
  })

  it('launches implementation child phases in an embedded terminal by default', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-child-terminal')
    const worktreePath = join(root, 'worktree-launch-child-terminal')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(worktreePath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-child-terminal',
      flowMeta('flow-launch-child-terminal', repoPath, {
        branch: 'flow/launch-child-terminal',
        worktree_path: worktreePath,
        commit: 'abc123',
        start: {
          repository_path: repoPath,
          worktree_path: worktreePath,
          branch: 'flow/launch-child-terminal',
          base_ref: 'main',
          commit: 'abc123'
        },
        plan_id: 'plan-child-terminal',
        plan_path: join(artifactRoot, 'plans', 'plan-child-terminal', 'plan.md'),
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'running',
            order: 3
          },
          {
            phase_id: 'implementation-api',
            title: 'API slice',
            kind: 'implementation_child',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 1
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const launched: Array<{
      flow: FlowListRow
      mode: string
      phaseId: string
      prompt: string
      launchId?: string
    }> = []
    const terminalManager = {
      async launchTerminal(request: {
        flow: FlowListRow
        provider: FlowTerminalSummary['provider']
        mode: FlowTerminalSummary['mode']
        phaseId: string
        prompt: string
        launchId?: string
      }) {
        launched.push(request)
        const store = await createFlowStore({ artifactRoot })
        const terminal: FlowTerminalSummary = {
          terminalId: 'terminal-child',
          launchId: request.launchId ?? 'missing-launch-id',
          provider: request.provider,
          mode: request.mode,
          flowId: request.flow.id,
          phaseId: request.phaseId,
          status: 'running',
          command: request.provider,
          argv: [request.prompt],
          cwd: request.flow.worktreePath ?? '',
          startedAt: '2026-06-14T12:15:00.000Z'
        }
        await store.updateFlowRecord(request.flow.id, {
          terminals: [terminal],
          updatedAt: '2026-06-14T12:15:00.000Z'
        })
        return terminal
      },
      async listTerminals(request: { flowId: string }) {
        const store = await createFlowStore({ artifactRoot })
        return (await store.readFlow(request.flowId))?.terminals ?? []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-child-terminal',
      phaseId: 'implementation-api'
    }, { terminalManager })

    expect(launched).toEqual([
      expect.objectContaining({
        mode: 'headless',
        phaseId: 'implementation-api',
        launchId: expect.stringMatching(/^phase-launch-/)
      })
    ])
    expect(launched[0]?.prompt).toContain('API slice')
    expect(launched[0]?.prompt).toContain('implementation-api')
    expect(result.flow).toMatchObject({
      flows: [
        expect.objectContaining({
          id: 'flow-launch-child-terminal',
          phases: expect.arrayContaining([
            expect.objectContaining({
              id: 'implementation-api',
              status: 'running',
              launchIds: [launched[0]?.launchId]
            })
          ]),
          terminals: [
            expect.objectContaining({
              terminalId: 'terminal-child',
              launchId: launched[0]?.launchId,
              phaseId: 'implementation-api',
              mode: 'headless'
            })
          ]
        })
      ]
    })
  })

  it('launches and completes Review Loop 2 with configured generic review behavior', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-review-two')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-review-two',
      flowMeta('flow-launch-review-two', repoPath, {
        phases: [
          {
            phase_id: 'review-loop-1',
            title: 'Review Loop 1',
            kind: 'review_loop',
            status: 'completed',
            outcome: 'review_completed',
            order: 4
          },
          {
            phase_id: 'review-loop-2',
            title: 'Review Loop 2',
            kind: 'review_loop',
            status: 'ready',
            order: 5
          },
          {
            phase_id: 'pr-creation',
            title: 'PR Creation',
            kind: 'pr_creation',
            status: 'pending',
            order: 6
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-review-two',
      phaseId: 'review-loop-2'
    }, {
      runPhase,
      reviewBehaviors: {
        byPhaseId: {
          'review-loop-2': {
            id: 'second-review',
            prompt: 'Run an independent generic second review.',
            runnerHint: 'generic'
          }
        },
        byKind: {
          review_loop: {
            id: 'kind-review',
            prompt: 'Run a generic review loop.'
          }
        }
      }
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            phases: expect.arrayContaining([
              expect.objectContaining({ id: 'review-loop-2', status: 'running' }),
              expect.objectContaining({ id: 'pr-creation', status: 'pending' })
            ])
          })
        ]
      }
    })
    expect(runPhase).toHaveBeenCalledWith(expect.objectContaining({
      phaseId: 'review-loop-2',
      phaseKind: 'review_loop',
      reviewBehavior: {
        id: 'second-review',
        prompt: 'Run an independent generic second review.',
        runnerHint: 'generic'
      }
    }))

    const launchId = runPhase.mock.calls[0]?.[0].launchId ?? ''
    const launchMetadata = JSON.parse(
      await readFile(join(artifactRoot, 'launches', launchId, 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(launchMetadata).toMatchObject({
      phase_id: 'review-loop-2',
      review_behavior: {
        id: 'second-review',
        prompt: 'Run an independent generic second review.',
        runner_hint: 'generic'
      }
    })
    expect(JSON.stringify(launchMetadata)).not.toMatch(/autoreview/i)

    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-launch-review-two',
      phaseId: 'review-loop-2',
      summary: 'Second review complete.'
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'review-loop-2',
                status: 'completed',
                outcome: 'review_completed',
                summary: 'Second review complete.'
              }),
              expect.objectContaining({ id: 'pr-creation', status: 'ready' })
            ])
          })
        ]
      }
    })
  })

  it('launches review loop phases in an embedded terminal with the resolved review prompt', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-review-terminal')
    const worktreePath = join(root, 'worktree-launch-review-terminal')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(worktreePath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-review-terminal',
      flowMeta('flow-launch-review-terminal', repoPath, {
        branch: 'flow/launch-review-terminal',
        worktree_path: worktreePath,
        commit: 'abc123',
        start: {
          repository_path: repoPath,
          worktree_path: worktreePath,
          branch: 'flow/launch-review-terminal',
          base_ref: 'main',
          commit: 'abc123'
        },
        phases: [
          {
            phase_id: 'review-loop-2',
            title: 'Review Loop 2',
            kind: 'review_loop',
            status: 'ready',
            order: 5
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const launched: Array<{
      mode: string
      phaseId: string
      prompt: string
      launchId?: string
    }> = []
    const terminalManager = {
      async launchTerminal(request: {
        flow: FlowListRow
        provider: FlowTerminalSummary['provider']
        mode: FlowTerminalSummary['mode']
        phaseId: string
        prompt: string
        launchId?: string
      }) {
        launched.push(request)
        const store = await createFlowStore({ artifactRoot })
        const terminal: FlowTerminalSummary = {
          terminalId: 'terminal-review',
          launchId: request.launchId ?? 'missing-launch-id',
          provider: request.provider,
          mode: request.mode,
          flowId: request.flow.id,
          phaseId: request.phaseId,
          status: 'running',
          command: request.provider,
          argv: [request.prompt],
          cwd: request.flow.worktreePath ?? '',
          startedAt: '2026-06-14T12:20:00.000Z'
        }
        await store.updateFlowRecord(request.flow.id, {
          terminals: [terminal],
          updatedAt: '2026-06-14T12:20:00.000Z'
        })
        return terminal
      },
      async listTerminals(request: { flowId: string }) {
        const store = await createFlowStore({ artifactRoot })
        return (await store.readFlow(request.flowId))?.terminals ?? []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-review-terminal',
      phaseId: 'review-loop-2'
    }, {
      terminalManager,
      reviewBehaviors: {
        byPhaseId: {
          'review-loop-2': {
            id: 'second-review',
            prompt: 'Run an independent terminal review.',
            runnerHint: 'generic'
          }
        }
      }
    })

    expect(launched).toEqual([
      {
        flow: expect.any(Object),
        provider: 'codex',
        mode: 'headless',
        phaseId: 'review-loop-2',
        prompt: [
          'Run an independent terminal review.',
          'Use wtui-flow to record the Review Loop result before finishing; the phase is not done until the result is persisted.'
        ].join('\n'),
        launchId: expect.stringMatching(/^phase-launch-/)
      }
    ])
    expect(result.flow).toMatchObject({
      flows: [
        expect.objectContaining({
          id: 'flow-launch-review-terminal',
          phases: expect.arrayContaining([
            expect.objectContaining({
              id: 'review-loop-2',
              status: 'running',
              launchIds: [launched[0]?.launchId]
            })
          ]),
          terminals: [
            expect.objectContaining({
              terminalId: 'terminal-review',
              launchId: launched[0]?.launchId,
              phaseId: 'review-loop-2',
              mode: 'headless'
            })
          ]
        })
      ]
    })
  })

  it('rejects overlapping launches for the same phase after the persisted phase is running', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-overlap')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-overlap',
      flowMeta('flow-launch-overlap', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    let releaseRun!: () => void
    let markStarted!: () => void
    const runStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const runPhase = vi.fn<FlowPhaseRunner>().mockImplementation(async () => {
      markStarted()
      await releaseRunPromise
    })

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const firstLaunch = launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-overlap',
      phaseId: 'implementation'
    }, { runPhase })
    await runStarted

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-overlap',
      phaseId: 'implementation'
    }, { runPhase })).rejects.toThrow('Phase is not ready to launch: implementation')
    expect(runPhase).toHaveBeenCalledTimes(1)
    releaseRun()
    await expect(firstLaunch).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-launch-overlap',
            phases: expect.arrayContaining([
              expect.objectContaining({ id: 'implementation', status: 'running' })
            ])
          })
        ]
      }
    })
    await expect(readdir(join(artifactRoot, 'launches'))).resolves.toHaveLength(1)
  })

  it('preserves concurrent launch updates for different implementation children', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-concurrent-children')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-concurrent-children',
      flowMeta('flow-launch-concurrent-children', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'running',
            order: 3
          },
          {
            phase_id: 'implementation-api',
            title: 'API slice',
            kind: 'implementation_child',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 1
          },
          {
            phase_id: 'implementation-ui',
            title: 'UI slice',
            kind: 'implementation_child',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 2
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await Promise.all([
      launchFlowPhaseInWorkspace({
        flowId: 'flow-launch-concurrent-children',
        phaseId: 'implementation-api'
      }, { runPhase }),
      launchFlowPhaseInWorkspace({
        flowId: 'flow-launch-concurrent-children',
        phaseId: 'implementation-ui'
      }, { runPhase })
    ])
    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-launch-concurrent-children',
            phases: expect.arrayContaining([
              expect.objectContaining({ id: 'implementation-api', status: 'running' }),
              expect.objectContaining({ id: 'implementation-ui', status: 'running' })
            ])
          })
        ]
      }
    })
    expect(runPhase).toHaveBeenCalledTimes(2)
    await expect(readdir(join(artifactRoot, 'launches'))).resolves.toHaveLength(2)
  })

  it('launches legacy generated implementation children as child phases', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-legacy-child')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-legacy-child',
      flowMeta('flow-launch-legacy-child', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'running',
            order: 3
          },
          {
            phase_id: 'implementation-legacy-child',
            title: 'Legacy child',
            kind: 'implementation',
            status: 'ready',
            parent_phase_id: 'implementation',
            generated: true,
            editable: true,
            order: 1
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-legacy-child',
      phaseId: 'implementation-legacy-child'
    }, { runPhase })

    expect(runPhase).toHaveBeenCalledWith(expect.objectContaining({
      flowId: 'flow-launch-legacy-child',
      phaseId: 'implementation-legacy-child',
      phaseTitle: 'Legacy child',
      phaseKind: 'implementation_child'
    }))
  })

  it('returns refreshed needs-attention state when a phase launch runner fails', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-failure')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-failure',
      flowMeta('flow-launch-failure', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>()
      .mockRejectedValueOnce(new Error('agent launch failed'))
      .mockResolvedValueOnce(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-failure',
      phaseId: 'implementation'
    }, { runPhase })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            id: 'flow-launch-failure',
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'implementation',
                status: 'needs_attention',
                notes: 'Phase launch failed: agent launch failed',
                launchIds: [expect.stringMatching(/^phase-launch-/)]
              })
            ])
          })
        ]
      }
    })
    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-failure',
      phaseId: 'implementation'
    }, { runPhase })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            id: 'flow-launch-failure',
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'implementation',
                status: 'running',
                launchIds: [
                  expect.stringMatching(/^phase-launch-/),
                  expect.stringMatching(/^phase-launch-/)
                ]
              })
            ])
          })
        ]
      }
    })
  })

  it('returns refreshed needs-attention state when the default terminal launch fails', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-terminal-failure')
    const worktreePath = join(root, 'worktree-launch-terminal-failure')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(worktreePath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-terminal-failure',
      flowMeta('flow-launch-terminal-failure', repoPath, {
        branch: 'flow/launch-terminal-failure',
        worktree_path: worktreePath,
        commit: 'abc123',
        start: {
          repository_path: repoPath,
          worktree_path: worktreePath,
          branch: 'flow/launch-terminal-failure',
          base_ref: 'main',
          commit: 'abc123'
        },
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const terminalManager = {
      async launchTerminal(request: {
        flow: FlowListRow
        provider: FlowTerminalSummary['provider']
        mode: FlowTerminalSummary['mode']
        phaseId: string
        prompt: string
        launchId?: string
      }) {
        const store = await createFlowStore({ artifactRoot })
        const terminal: FlowTerminalSummary = {
          terminalId: 'terminal-failed',
          launchId: request.launchId ?? 'missing-launch-id',
          provider: request.provider,
          mode: request.mode,
          flowId: request.flow.id,
          phaseId: request.phaseId,
          status: 'failed',
          command: request.provider,
          argv: [request.prompt],
          cwd: request.flow.worktreePath ?? '',
          startedAt: '2026-06-14T12:25:00.000Z',
          endedAt: '2026-06-14T12:25:01.000Z'
        }
        await store.updateFlowRecord(request.flow.id, {
          terminals: [terminal],
          updatedAt: '2026-06-14T12:25:01.000Z'
        })
        throw new Error('terminal spawn failed')
      },
      async listTerminals(request: { flowId: string }) {
        const store = await createFlowStore({ artifactRoot })
        return (await store.readFlow(request.flowId))?.terminals ?? []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-terminal-failure',
      phaseId: 'implementation'
    }, { terminalManager })
    const phase = result.flow.status === 'ready'
      ? result.flow.flows[0]?.phases?.find((candidate) => candidate.id === 'implementation')
      : undefined
    const launchId = phase?.launchIds?.[0]

    expect(result.flow).toMatchObject({
      flows: [
        expect.objectContaining({
          id: 'flow-launch-terminal-failure',
          phases: expect.arrayContaining([
            expect.objectContaining({
              id: 'implementation',
              status: 'needs_attention',
              notes: 'Phase launch failed: terminal spawn failed',
              launchIds: [expect.stringMatching(/^phase-launch-/)]
            })
          ]),
          terminals: [
            expect.objectContaining({
              terminalId: 'terminal-failed',
              launchId,
              phaseId: 'implementation',
              status: 'failed'
            })
          ]
        })
      ]
    })
  })

  it('marks a default terminal launch needs-attention when real launch validation fails', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-missing-start')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-missing-start',
      flowMeta('flow-launch-missing-start', repoPath, {
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-missing-start',
      phaseId: 'implementation'
    })).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-launch-missing-start',
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'implementation',
                status: 'needs_attention',
                notes: 'Phase launch failed: Flow start metadata is required before launching a terminal.',
                launchIds: [expect.stringMatching(/^phase-launch-/)]
              })
            ])
          })
        ]
      }
    })
  })

  it('does not overwrite a newer repository selection after a phase launch finishes', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-stale')
    const otherRepoPath = join(root, 'repo-launch-selected')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await makeGitRepository(otherRepoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-stale',
      flowMeta('flow-launch-stale', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'ready',
            order: 3
          }
        ]
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'flow-other-repo',
      flowMeta('flow-other-repo', otherRepoPath)
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      `repos = ["${repoPath}", "${otherRepoPath}"]\nartifact_root = "${artifactRoot}"\n`
    )

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories.find((repo) => repo.path === repoPath)?.id ?? ''
    const otherRepositoryId = state.repository.repositories.find((repo) => repo.path === otherRepoPath)?.id ?? ''
    await selectRepository({ repositoryId })
    const runPhase = vi.fn<FlowPhaseRunner>().mockImplementation(async () => {
      await selectRepository({ repositoryId: otherRepositoryId })
    })

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-stale',
      phaseId: 'implementation'
    }, { runPhase })).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: otherRepositoryId
      },
      flow: {
        status: 'ready',
        repositoryId: otherRepositoryId,
        flows: [
          expect.objectContaining({ id: 'flow-other-repo' })
        ]
      }
    })
  })

  it('rejects non-ready phase launches before mutating the selected Flow', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-launch-pending')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-launch-pending',
      flowMeta('flow-launch-pending', repoPath, {
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'pending',
            order: 3
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)
    const runPhase = vi.fn<FlowPhaseRunner>().mockResolvedValue(undefined)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(launchFlowPhaseInWorkspace({
      flowId: 'flow-launch-pending',
      phaseId: 'implementation'
    }, { runPhase })).rejects.toThrow('Phase is not ready to launch: implementation')
    expect(runPhase).not.toHaveBeenCalled()
    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-launch-pending',
      phaseId: 'implementation',
      summary: 'Do not complete a pending phase.'
    })).rejects.toThrow('Phase is not running: implementation')
    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            phases: [
              expect.objectContaining({ id: 'implementation', status: 'pending' })
            ]
          })
        ]
      }
    })
  })

  it('skips implementation children with required notes and completes Implementation', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-complete-phase')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-complete-phase',
      flowMeta('flow-complete-phase', repoPath, {
        phases: [
          {
            phase_id: 'plan-review',
            title: 'Plan Review',
            kind: 'plan_review',
            status: 'completed',
            outcome: 'approved',
            order: 2
          },
          {
            phase_id: 'implementation',
            title: 'Implementation',
            kind: 'implementation',
            status: 'running',
            order: 3
          },
          {
            phase_id: 'implementation-ui',
            title: 'UI slice',
            kind: 'implementation_child',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 1
          },
          {
            phase_id: 'implementation-legacy',
            title: 'Legacy slice',
            kind: 'implementation',
            status: 'ready',
            parent_phase_id: 'implementation',
            order: 2
          },
          {
            phase_id: 'review-loop-1',
            title: 'Review Loop 1',
            kind: 'review_loop',
            status: 'pending',
            order: 4
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(skipFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation',
      notes: 'Do not skip parent Implementation.'
    })).rejects.toThrow('Phase cannot be skipped from this workspace: implementation')
    await expect(skipFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation-legacy',
      notes: 'Do not skip non-child phases.'
    })).rejects.toThrow('Phase cannot be skipped from this workspace: implementation-legacy')
    await expect(skipFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation-ui',
      notes: ''
    })).rejects.toThrow('Skipping a phase requires notes.')
    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation',
      summary: 'Do not complete before children settle.'
    })).rejects.toThrow(
      'Implementation cannot complete until all generated implementation children are completed or skipped with notes.'
    )
    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation-ui',
      summary: 42
    } as never)).rejects.toThrow('Complete Flow phase request is invalid.')
    await expect(skipFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation-ui',
      notes: 'Covered by another slice.'
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'implementation-ui',
                status: 'skipped',
                notes: 'Covered by another slice.'
              }),
              expect.objectContaining({ id: 'review-loop-1', status: 'ready' })
            ])
          })
        ]
      }
    })
    await expect(completeFlowPhaseInWorkspace({
      flowId: 'flow-complete-phase',
      phaseId: 'implementation',
      summary: 'Implemented the parent phase.'
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'implementation',
                status: 'completed',
                summary: 'Implemented the parent phase.'
              }),
              expect.objectContaining({ id: 'review-loop-1', status: 'ready' })
            ])
          })
        ]
      }
    })
  })

  it('records PR metadata through PR Creation and rejects invalid metadata before promotion', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-record-pr')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-record-pr',
      flowMeta('flow-record-pr', repoPath, {
        branch: 'flow/record-pr',
        phases: [
          {
            phase_id: 'review-loop-2',
            title: 'Review Loop 2',
            kind: 'review_loop',
            status: 'completed',
            outcome: 'review_completed',
            order: 5
          },
          {
            phase_id: 'pr-creation',
            title: 'PR Creation',
            kind: 'pr_creation',
            status: 'ready',
            order: 6
          },
          {
            phase_id: 'human-review',
            title: 'Human Review',
            kind: 'human_review',
            status: 'pending',
            order: 7
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(recordFlowPullRequestInWorkspace({
      flowId: 'flow-record-pr',
      pr: {
        provider: 'github',
        number: 12,
        url: 'http://github.com/acme/grindstone/pull/12',
        head: 'flow/record-pr',
        base: 'main',
        status: 'open'
      }
    })).rejects.toThrow('Pull request URL must be a valid HTTPS URL.')
    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-record-pr',
            pr: undefined,
            phases: expect.arrayContaining([
              expect.objectContaining({ id: 'pr-creation', status: 'ready' }),
              expect.objectContaining({ id: 'human-review', status: 'pending' })
            ])
          })
        ]
      }
    })

    await expect(recordFlowPullRequestInWorkspace({
      flowId: 'flow-record-pr',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/record-pr',
        base: 'main',
        status: 'open'
      },
      summary: 'Opened GitHub PR #12.'
    })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          expect.objectContaining({
            id: 'flow-record-pr',
            pr: {
              provider: 'github',
              number: 12,
              url: 'https://github.com/acme/grindstone/pull/12',
              head: 'flow/record-pr',
              base: 'main',
              status: 'open'
            },
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'pr-creation',
                status: 'completed',
                outcome: 'pr_recorded',
                summary: 'Opened GitHub PR #12.'
              }),
              expect.objectContaining({ id: 'human-review', status: 'ready' })
            ])
          })
        ]
      }
    })
  })

  it('records Human Review and merge metadata through selected workspace actions', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-review-merge')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'flow-review-merge',
      flowMeta('flow-review-merge', repoPath, {
        pr: {
          provider: 'github',
          number: 13,
          url: 'https://github.com/acme/grindstone/pull/13',
          head: 'flow/review-merge',
          base: 'main',
          status: 'open'
        },
        phases: [
          {
            phase_id: 'human-review',
            title: 'Human Review',
            kind: 'human_review',
            status: 'ready',
            order: 7
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\nartifact_root = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(recordFlowHumanReviewInWorkspace({
      flowId: 'flow-review-merge',
      outcome: 'changes_requested'
    })).rejects.toThrow('Human Review outcome changes_requested requires notes.')

    await expect(recordFlowHumanReviewInWorkspace({
      flowId: 'flow-review-merge',
      outcome: 'approved',
      notes: 'Approved by reviewer.'
    })).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-review-merge',
            status: 'active',
            humanReview: expect.objectContaining({
              outcome: 'approved',
              notes: 'Approved by reviewer.'
            }),
            merge: { status: 'pending' },
            phases: expect.arrayContaining([
              expect.objectContaining({
                id: 'human-review',
                status: 'completed',
                outcome: 'approved'
              })
            ])
          })
        ]
      }
    })

    await expect(recordFlowMergeInWorkspace({
      flowId: 'flow-review-merge',
      status: 'blocked',
      notes: ''
    })).rejects.toThrow('Blocked merge metadata requires notes.')

    await expect(recordFlowMergeInWorkspace({
      flowId: 'flow-review-merge',
      status: 'merged',
      commit: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12'
    })).resolves.toMatchObject({
      flow: {
        flows: [
          expect.objectContaining({
            id: 'flow-review-merge',
            status: 'merged',
            merge: expect.objectContaining({
              status: 'merged',
              commit: 'abcdef1234567890abcdef1234567890abcdef12'
            })
          })
        ]
      }
    })
  })

  it('exposes configured scan roots as opaque create targets', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)

    const state = await loadInitialWorkspaceState({ configPath })

    expect(state.repository.create).toMatchObject({
      available: true,
      scanRoots: [
        {
          configuredPath: scanRoot,
          resolvedPath: scanRoot,
          displayPath: scanRoot
        }
      ],
      error: null,
      remoteRetries: []
    })
    expect(state.repository.create.scanRoots[0]?.id).toMatch(/^scan-root:0:/)
  })

  it('creates a repository through the authoritative scan-root context', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)
    const initialState = await loadInitialWorkspaceState({ configPath })
    const scanRootId = initialState.repository.create.scanRoots[0]?.id ?? ''
    const runCommand: CommandRunner = async (_command, _args, options) => {
      await makeGitRepository(options.cwd)
      return { stdout: '' }
    }

    const state = await createRepositoryInWorkspace(
      {
        scanRootId,
        name: 'created-repo',
        github: {
          enabled: false,
          visibility: 'private'
        }
      },
      { runCommand }
    )

    expect(state.repository.repositories).toEqual([
      expect.objectContaining({
        name: 'created-repo',
        sources: ['scan_root']
      })
    ])
    expect(state.repository.create.error).toBeNull()
  })

  it('rejects create requests when no scan roots are configured', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, 'repos = []\n')
    await loadInitialWorkspaceState({ configPath })

    const state = await createRepositoryInWorkspace(
      {
        scanRootId: 'scan-root:forged',
        name: 'created-repo',
        github: {
          enabled: false,
          visibility: 'private'
        }
      },
      { runCommand: vi.fn<CommandRunner>() }
    )

    expect(state.repository.repositories).toEqual([])
    expect(state.repository.create.error).toMatchObject({
      code: 'scan_root_unavailable'
    })
  })

  it('stores remote retry records after local success with GitHub failure', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)
    const initialState = await loadInitialWorkspaceState({ configPath })
    const scanRootId = initialState.repository.create.scanRoots[0]?.id ?? ''
    const runCommand: CommandRunner = async (command, _args, options) => {
      if (command === 'gh') {
        throw new CommandRunError('gh', ['repo', 'create'], 'gh auth failed')
      }
      await makeGitRepository(options.cwd)
      return { stdout: '' }
    }

    const state = await createRepositoryInWorkspace(
      {
        scanRootId,
        name: 'remote-fails',
        github: {
          enabled: true,
          visibility: 'public'
        }
      },
      { runCommand }
    )

    expect(state.repository.repositories).toEqual([
      expect.objectContaining({
        name: 'remote-fails'
      })
    ])
    expect(state.repository.create.remoteRetries).toEqual([
      expect.objectContaining({
        githubRepositoryName: 'remote-fails',
        status: 'remote_create_failed',
        lastError: 'gh auth failed'
      })
    ])
  })

  it('preserves remote retry records when the workspace catalog reloads', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)
    const initialState = await loadInitialWorkspaceState({ configPath })
    const scanRootId = initialState.repository.create.scanRoots[0]?.id ?? ''
    const runCommand: CommandRunner = async (command, _args, options) => {
      if (command === 'gh') {
        throw new CommandRunError('gh', ['repo', 'create'], 'gh auth failed')
      }
      await makeGitRepository(options.cwd)
      return { stdout: '' }
    }

    const partialState = await createRepositoryInWorkspace(
      {
        scanRootId,
        name: 'reload-retry',
        github: {
          enabled: true,
          visibility: 'private'
        }
      },
      { runCommand }
    )
    const retry = partialState.repository.create.remoteRetries[0]
    expect(retry).toBeDefined()

    await expect(loadInitialWorkspaceState({ configPath })).resolves.toMatchObject({
      repository: {
        create: {
          remoteRetries: [
            {
              id: retry?.id,
              repositoryPath: retry?.repositoryPath,
              githubRepositoryName: 'reload-retry',
              status: 'remote_create_failed'
            }
          ]
        }
      }
    })
  })

  it('returns structured errors for malformed remote retry requests', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)
    await loadInitialWorkspaceState({ configPath })

    const state = await retryRepositoryRemoteInWorkspace(
      null as unknown as { retryId: string },
      { runCommand: vi.fn<CommandRunner>() }
    )

    expect(state.repository.create.error).toMatchObject({
      code: 'remote_creation_failed',
      message: 'Remote retry request is invalid.'
    })
  })

  it('removes stored retry metadata after remote setup succeeds', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'repos')
    await mkdir(scanRoot)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `scan_roots = ["${scanRoot}"]\n`)
    const initialState = await loadInitialWorkspaceState({ configPath })
    const scanRootId = initialState.repository.create.scanRoots[0]?.id ?? ''
    const createRunCommand: CommandRunner = async (command, _args, options) => {
      if (command === 'gh') {
        throw new CommandRunError('gh', ['repo', 'create'], 'gh auth failed')
      }
      await makeGitRepository(options.cwd)
      return { stdout: '' }
    }
    const partialState = await createRepositoryInWorkspace(
      {
        scanRootId,
        name: 'retry-repo',
        github: {
          enabled: true,
          visibility: 'private'
        }
      },
      { runCommand: createRunCommand }
    )
    const retryId = partialState.repository.create.remoteRetries[0]?.id ?? ''
    const retryRunCommand: CommandRunner = async (command, args) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        throw new CommandRunError('git', args, 'No such remote')
      }
      return { stdout: '' }
    }

    const state = await retryRepositoryRemoteInWorkspace({ retryId }, { runCommand: retryRunCommand })

    expect(state.repository.create.remoteRetries).toEqual([])
  })

  it('returns a repo-scoped empty Flow state when the selected repo has no records', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-empty')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''

    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: repositoryId
      },
      flow: {
        status: 'empty',
        title: 'No Flows for repo-empty',
        description: `No Flow records were found for ${repoPath}.`,
        repositoryId,
        repositoryName: 'repo-empty'
      }
    })
  })

  it('creates a Flow worktree for the selected repository and refreshes the Flow list', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-flow-create')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)
    const commands: Array<{ command: string; args: string[]; cwd: string }> = []
    const runCommand: FlowCommandRunner = async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd })
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        throw new Error('branch not found')
      }
      if (args.join(' ') === 'rev-parse --verify main^{commit}') {
        return { stdout: 'abc123\n' }
      }
      return { stdout: '' }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    const canonicalRepoPath = await realpath(repoPath)
    await selectRepository({ repositoryId })

    await expect(createFlowInWorkspace(
      {
        title: 'Ship workspace creation',
        instructions: 'Build the end-to-end path.',
        baseRef: 'main'
      },
      { runCommand, prepareLaunch: async () => undefined }
    )).resolves.toMatchObject({
      flow: {
        status: 'ready',
        create: {
          error: null
        },
        flows: [
          {
            id: 'ship-workspace-creation',
            status: 'active',
            title: 'Ship workspace creation',
            branch: 'flow/ship-workspace-creation',
            baseRef: 'main',
            commit: 'abc123',
            worktreePath: join(
              dirname(canonicalRepoPath),
              'grindstone-worktrees',
              `${basename(canonicalRepoPath)}-flow-ship-workspace-creation`
            )
          }
        ]
      }
    })
    expect(commands.map((command) => [command.command, command.args])).toEqual([
      ['git', ['rev-parse', '--verify', 'refs/heads/flow/ship-workspace-creation']],
      ['git', ['rev-parse', '--verify', 'main^{commit}']],
      ['git', ['-c', 'core.hooksPath=/dev/null', 'branch', 'flow/ship-workspace-creation', 'abc123']],
      ['git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', join(
        dirname(canonicalRepoPath),
        'grindstone-worktrees',
        `${basename(canonicalRepoPath)}-flow-ship-workspace-creation`
      ), 'flow/ship-workspace-creation']]
    ])
  })

  it('persists bootstrap failures as selected repository Flow rows', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-bootstrap-failure')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n[[bootstrap_hooks]]\ncommand = "npm install"\n`
    )
    const runCommand: FlowCommandRunner = async (command, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        throw new Error('branch not found')
      }
      if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
        return { stdout: 'abc123\n' }
      }
      const worktreeIndex = args.indexOf('worktree')
      if (worktreeIndex !== -1 && args[worktreeIndex + 1] === 'add' && args[worktreeIndex + 2] !== undefined) {
        await mkdir(args[worktreeIndex + 2], { recursive: true })
      }
      if (command === 'npm install') {
        throw new Error('npm install failed')
      }
      return { stdout: '' }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await createFlowInWorkspace(
      {
        title: 'Broken bootstrap',
        instructions: 'Run hooks.'
      },
      { runCommand }
    )

    expect(result.flow).toMatchObject({
      status: 'ready',
      create: {
        error: {
          code: 'bootstrap_failed',
          message: 'npm install failed'
        }
      },
      flows: [
        {
          id: 'broken-bootstrap',
          status: 'failed',
          failure: {
            stage: 'bootstrap',
            message: 'npm install failed',
            command: 'npm install'
          }
        }
      ]
    })
  })

  it('maps fatal Flow store failures to a selected-repository Flow error state', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-error')
    const artifactRoot = join(root, 'artifact-root-file')
    await makeGitRepository(repoPath)
    await writeFile(artifactRoot, '')
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''

    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: repositoryId
      },
      flow: {
        status: 'error',
        repositoryId,
        repositoryName: 'repo-error',
        message: expect.stringContaining('Flow artifact store unavailable')
      }
    })
  })

  it('keeps the New Flow shortcut disabled when selected repository Flow creation is unavailable', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-shortcut-error')
    const artifactRoot = join(root, 'artifact-root-file')
    await makeGitRepository(repoPath)
    await writeFile(artifactRoot, '')
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    const selectedState = await selectRepository({ repositoryId })

    expect(selectedState.flow).toMatchObject({
      status: 'error'
    })
    expect(selectedState.shortcuts.find((shortcut) => shortcut.id === 'new-flow')).toMatchObject({
      disabled: true
    })
  })

  it('keeps main workspace memory on the latest repository when earlier selections finish later', async () => {
    const root = await makeTempDir()
    const alphaPath = join(root, 'repo-alpha')
    const betaPath = join(root, 'repo-beta')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(alphaPath)
    await makeGitRepository(betaPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${alphaPath}", "${betaPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    let resolveAlpha: ((flows: FlowListRow[]) => void) | undefined
    let resolveBeta: ((flows: FlowListRow[]) => void) | undefined
    const flowStoreFactory = vi.fn(async (): Promise<FlowStore> =>
      readOnlyFlowStore((repository) => {
        return new Promise<FlowListRow[]>((resolve) => {
          if (repository.name === 'repo-alpha') {
            resolveAlpha = resolve
          } else {
            resolveBeta = resolve
          }
        })
      })
    )

    const initialState = await loadInitialWorkspaceState({ configPath, flowStoreFactory })
    const alphaRepository = initialState.repository.repositories.find((repo) => repo.name === 'repo-alpha')
    const betaRepository = initialState.repository.repositories.find((repo) => repo.name === 'repo-beta')
    expect(alphaRepository).toBeDefined()
    expect(betaRepository).toBeDefined()

    const alphaSelection = selectRepository({ repositoryId: alphaRepository?.id ?? '' })
    const betaSelection = selectRepository({ repositoryId: betaRepository?.id ?? '' })
    await flushMicrotasks()

    expect(resolveAlpha).toBeDefined()
    expect(resolveBeta).toBeDefined()
    resolveBeta?.([flowRow('beta-flow', betaRepository as RepositoryRow)])
    await expect(betaSelection).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: betaRepository?.id
      },
      flow: {
        status: 'ready',
        repositoryId: betaRepository?.id,
        flows: [
          {
            id: 'beta-flow'
          }
        ]
      }
    })

    resolveAlpha?.([flowRow('alpha-flow', alphaRepository as RepositoryRow)])
    await expect(alphaSelection).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: betaRepository?.id
      },
      flow: {
        status: 'ready',
        repositoryId: betaRepository?.id,
        flows: [
          {
            id: 'beta-flow'
          }
        ]
      }
    })
  })

  it('invalidates pending repository selections as soon as initial workspace reload starts', async () => {
    const root = await makeTempDir()
    const alphaPath = join(root, 'repo-alpha')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(alphaPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${alphaPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    let resolveAlpha: ((flows: FlowListRow[]) => void) | undefined
    const flowStoreFactory = vi.fn(async (): Promise<FlowStore> =>
      readOnlyFlowStore((repository) => {
        return new Promise<FlowListRow[]>((resolve) => {
          resolveAlpha = (flows) => resolve(flows.length > 0 ? flows : [flowRow('alpha-flow', repository)])
        })
      })
    )

    const initialState = await loadInitialWorkspaceState({ configPath, flowStoreFactory })
    const alphaRepository = initialState.repository.repositories[0]
    expect(alphaRepository).toBeDefined()

    const alphaSelection = selectRepository({ repositoryId: alphaRepository?.id ?? '' })
    await flushMicrotasks()
    expect(resolveAlpha).toBeDefined()

    let resolveConfigReload: (() => void) | undefined
    const configReloadStarted = new Promise<void>((resolve) => {
      resolveConfigReload = resolve
    })
    const reload = loadInitialWorkspaceState({
      configLoader: async () => {
        await configReloadStarted
        return {
          ok: true,
          configPath,
          scanRoots: [],
          repos: [
            {
              configuredPath: alphaPath,
              resolvedPath: alphaPath
            }
          ],
          defaultAgent: null,
          artifactRoot: {
            configuredPath: artifactRoot,
            resolvedPath: artifactRoot
          },
          bootstrapHooks: [],
          diagnostics: []
        }
      },
      flowStoreFactory
    })
    await flushMicrotasks()

    resolveAlpha?.([flowRow('alpha-flow', alphaRepository as RepositoryRow)])
    await expect(alphaSelection).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: null
      },
      flow: {
        title: 'No Flow selected'
      }
    })

    resolveConfigReload?.()
    await expect(reload).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: null,
        repositories: [
          {
            id: alphaRepository?.id
          }
        ]
      }
    })
  })

  it('does not let a selection from an old catalog overwrite a completed reload', async () => {
    const root = await makeTempDir()
    const alphaPath = join(root, 'repo-alpha')
    const betaPath = join(root, 'repo-beta')
    const alphaArtifactRoot = join(root, 'alpha-artifacts')
    const betaArtifactRoot = join(root, 'beta-artifacts')
    await makeGitRepository(alphaPath)
    await makeGitRepository(betaPath)
    const alphaConfigPath = join(root, 'alpha-grindstone.toml')
    await writeFile(alphaConfigPath, `repos = ["${alphaPath}"]\n[artifacts]\nroot = "${alphaArtifactRoot}"\n`)

    let resolveAlpha: ((flows: FlowListRow[]) => void) | undefined
    const flowStoreFactory = vi.fn(async (): Promise<FlowStore> =>
      readOnlyFlowStore((repository) => {
        return new Promise<FlowListRow[]>((resolve) => {
          resolveAlpha = (flows) => resolve(flows.length > 0 ? flows : [flowRow('alpha-flow', repository)])
        })
      })
    )

    const initialState = await loadInitialWorkspaceState({
      configPath: alphaConfigPath,
      flowStoreFactory
    })
    const alphaRepository = initialState.repository.repositories[0]
    expect(alphaRepository).toBeDefined()

    let resolveReloadConfig: (() => void) | undefined
    const reloadConfigStarted = new Promise<void>((resolve) => {
      resolveReloadConfig = resolve
    })
    const reload = loadInitialWorkspaceState({
      configLoader: async () => {
        await reloadConfigStarted
        return {
          ok: true,
          configPath: join(root, 'beta-grindstone.toml'),
          scanRoots: [],
          repos: [
            {
              configuredPath: betaPath,
              resolvedPath: betaPath
            }
          ],
          defaultAgent: null,
          artifactRoot: {
            configuredPath: betaArtifactRoot,
            resolvedPath: betaArtifactRoot
          },
          bootstrapHooks: [],
          diagnostics: []
        }
      },
      flowStoreFactory
    })
    await flushMicrotasks()

    const alphaSelection = selectRepository({ repositoryId: alphaRepository?.id ?? '' })
    await flushMicrotasks()
    expect(resolveAlpha).toBeDefined()

    resolveReloadConfig?.()
    const reloadedState = await reload
    const betaRepository = reloadedState.repository.repositories[0]
    expect(betaRepository).toBeDefined()

    resolveAlpha?.([flowRow('alpha-flow', alphaRepository as RepositoryRow)])
    await expect(alphaSelection).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: null,
        repositories: [
          {
            id: betaRepository?.id
          }
        ]
      },
      flow: {
        title: 'No Flow selected'
      }
    })
  })

  it('loads editable common config for IPC consumers', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      'repos = ["./repo"]\ndefault_agent = "codex"\nartifact_root = "./artifacts"\n'
    )

    await expect(getCurrentEditableConfig({ configPath })).resolves.toMatchObject({
      configPath,
      repos: ['./repo'],
      default_agent: 'codex',
      artifact_root: './artifacts'
    })
  })

  it('saves common config and returns the refreshed repository catalog', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-delta')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, 'repos = []\n')

    await expect(
      updateCommonConfig(
        {
          scan_roots: [],
          repos: [repoPath],
          default_agent: 'claude',
          artifact_root: './artifacts',
          bootstrap_hooks: []
        },
        { configPath }
      )
    ).resolves.toMatchObject({
      ok: true,
      workspace: {
        repository: {
          status: 'ready',
          repositories: [
            {
              name: 'repo-delta',
              path: repoPath,
              sources: ['explicit']
            }
          ]
        }
      },
      config: {
        repos: [repoPath],
        default_agent: 'claude',
        artifact_root: './artifacts'
      }
    })
  })

  it('preserves selected repository when the same canonical repository remains after save', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-epsilon')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n`)
    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(
      updateCommonConfig(
        {
          scan_roots: [],
          repos: [repoPath],
          default_agent: null,
          artifact_root: null,
          bootstrap_hooks: []
        },
        { configPath }
      )
    ).resolves.toMatchObject({
      ok: true,
      workspace: {
        repository: {
          selectedRepositoryId: repositoryId
        },
        flow: {
          title: 'No Flows for repo-epsilon'
        }
      }
    })
  })

  it('clears selected repository and resets Flow when the saved config removes it', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-zeta')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n`)
    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    await expect(
      updateCommonConfig(
        {
          scan_roots: [],
          repos: [],
          default_agent: null,
          artifact_root: null,
          bootstrap_hooks: []
        },
        { configPath }
      )
    ).resolves.toMatchObject({
      ok: true,
      workspace: {
        repository: {
          selectedRepositoryId: null,
          repositories: []
        },
        flow: {
          title: 'No Flow selected'
        }
      }
    })
  })

  it('returns structured validation failures without reloading workspace state', async () => {
    await expect(
      updateCommonConfig({
        scan_roots: [''],
        repos: [],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: []
      })
    ).resolves.toEqual({
      ok: false,
      kind: 'validation',
      errors: [
        {
          field: 'scan_roots[0]',
          message: 'scan_roots entries must be non-empty strings.'
        }
      ]
    })
  })

  it('rejects selection for an unknown repository id', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-gamma')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n`)
    await loadInitialWorkspaceState({ configPath })

    await expect(selectRepository({ repositoryId: '/repos/missing' })).rejects.toThrow(
      'Repository not found: /repos/missing'
    )
  })


  it('reconciles stale persisted running terminals while selecting a repository', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-stale-terminal')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'stale-terminal-flow',
      flowMeta('stale-terminal-flow', repoPath, {
        terminals: [
          {
            terminal_id: 'terminal-stale',
            launch_id: 'launch-stale',
            provider: 'codex',
            mode: 'interactive',
            flow_id: 'stale-terminal-flow',
            phase_id: 'plan',
            status: 'running',
            command: 'codex',
            argv: ['Plan'],
            cwd: repoPath,
            started_at: '2026-06-14T12:00:00.000Z'
          }
        ]
      })
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''

    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      flow: {
        status: 'ready',
        flows: [
          {
            id: 'stale-terminal-flow',
            terminals: [
              {
                terminalId: 'terminal-stale',
                status: 'failed',
                endedAt: expect.any(String)
              }
            ]
          }
        ]
      }
    })
  })

  it('starts a Plan terminal after Flow creation succeeds', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-flow-terminal')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\ndefault_agent = "claude"\n[artifacts]\nroot = "${artifactRoot}"\n`)
    const runCommand: FlowCommandRunner = async (_command, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'abc123\n' }
      }
      return { stdout: '' }
    }
    const launched: FlowListRow[] = []
    const terminalManager = {
      async launchTerminal(request: { flow: FlowListRow }) {
        const flow = request.flow
        launched.push(flow)
        const store = await createFlowStore({ artifactRoot })
        const terminal = {
          terminalId: 'terminal-plan',
          launchId: 'launch-plan',
          provider: 'claude' as const,
          mode: 'interactive' as const,
          flowId: flow.id,
          phaseId: 'plan',
          status: 'running' as const,
          command: 'claude',
          argv: ['Build launch integration.'],
          cwd: flow.worktreePath ?? '',
          startedAt: '2026-06-14T12:10:00.000Z',
          recentOutput: 'Plan terminal ready.'
        }
        await store.updateFlowRecord(flow.id, {
          terminals: [terminal],
          updatedAt: '2026-06-14T12:10:00.000Z'
        })
        return terminal
      },
      async listTerminals(request: { flowId: string }) {
        const store = await createFlowStore({ artifactRoot })
        return (await store.readFlow(request.flowId))?.terminals ?? []
      },
      async writeInput() {
        throw new Error('not expected')
      },
      async resize() {
        throw new Error('not expected')
      },
      async terminate() {
        throw new Error('not expected')
      },
      async dismiss() {
        throw new Error('not expected')
      }
    }

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    await selectRepository({ repositoryId })

    const result = await createFlowInWorkspace(
      {
        title: 'Launch integration',
        instructions: 'Build launch integration.'
      },
      { runCommand, terminalManager }
    )

    expect(launched).toEqual([
      expect.objectContaining({
        id: 'launch-integration',
        start: expect.objectContaining({
          commit: 'abc123'
        })
      })
    ])
    expect(result.flow).toMatchObject({
      status: 'ready',
      flows: [
        {
          id: 'launch-integration',
          status: 'active',
          terminals: [
            {
              terminalId: 'terminal-plan',
              provider: 'claude',
              phaseId: 'plan',
              status: 'running',
              recentOutput: 'Plan terminal ready.'
            }
          ]
        }
      ]
    })
  })

  it('rejects terminal IPC before a usable artifact root is configured', async () => {
    const flowStoreFactory = vi.fn(async (): Promise<FlowStore> =>
      readOnlyFlowStore(async () => [])
    )
    await loadInitialWorkspaceState({
      configLoader: async () => ({
        ok: true,
        configPath: undefined,
        scanRoots: [],
        repos: [],
        artifactRoot: {
          configuredPath: '',
          resolvedPath: ''
        },
        defaultAgent: null,
        bootstrapHooks: [],
        diagnostics: []
      }),
      flowStoreFactory
    })

    await expect(listFlowTerminals({
      repositoryId: '/repo',
      flowId: 'flow'
    })).rejects.toThrow('Flow artifact root is not configured.')
    expect(flowStoreFactory).not.toHaveBeenCalled()
  })

  it('validates terminal event subscriptions against persisted Flow ownership', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-terminal-subscription')
    const artifactRoot = join(root, 'artifacts')
    await makeGitRepository(repoPath)
    await writeFlowMeta(
      artifactRoot,
      'subscription-flow',
      flowMeta('subscription-flow', repoPath)
    )
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n[artifacts]\nroot = "${artifactRoot}"\n`)
    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    registerWorkspaceHandlers(ipcMain)
    const subscribe = handlers.get(ipcChannels.workspace.subscribeTerminalEvents)
    const sender = {
      sender: {
        id: 1,
        send: vi.fn()
      }
    }

    await expect(subscribe?.(sender, {
      repositoryId,
      flowId: 'subscription-flow'
    })).resolves.toEqual({
      subscriptionId: expect.any(String)
    })
    await expect(subscribe?.(sender, {
      repositoryId: '/repos/other',
      flowId: 'subscription-flow'
    })).rejects.toThrow('Flow not found for terminal event subscription: subscription-flow')
    await expect(subscribe?.(sender, {
      repositoryId,
      flowId: 'missing-flow'
    })).rejects.toThrow('Flow not found for terminal event subscription: missing-flow')
  })

  it('registers workspace IPC handlers on shared channels', async () => {
    const ipcMain = {
      handle: vi.fn()
    }

    registerWorkspaceHandlers(ipcMain)

    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.getInitialState,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.selectRepository,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.readFlowPlan,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.createFlow,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.launchFlowPhase,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.skipFlowPhase,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.completeFlowPhase,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.createRepository,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.retryRepositoryRemote,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.listTerminals,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.writeTerminalInput,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.resizeTerminal,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.terminateTerminal,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.dismissTerminal,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.subscribeTerminalEvents,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.unsubscribeTerminalEvents,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.config.getEditableConfig,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.config.updateCommonConfig,
      expect.any(Function)
    )
  })
})
