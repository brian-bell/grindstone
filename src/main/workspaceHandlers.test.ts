import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import type { FlowListRow, RepositoryRow } from '@shared/workspace'
import {
  createFlowInWorkspace,
  createRepositoryInWorkspace,
  getCurrentEditableConfig,
  launchFlowPhaseInWorkspace,
  loadInitialWorkspaceState,
  readLinkedFlowPlan,
  registerWorkspaceHandlers,
  retryRepositoryRemoteInWorkspace,
  selectRepository,
  updateCommonConfig,
  completeFlowPhaseInWorkspace,
  skipFlowPhaseInWorkspace,
  updateFlowPhaseInWorkspace
} from './workspaceHandlers'
import type { FlowStore } from './flowStore'
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
    }, { runPhase })).rejects.toThrow('Phase is already running: implementation')
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
      { runCommand }
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
      ipcChannels.config.getEditableConfig,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.config.updateCommonConfig,
      expect.any(Function)
    )
  })
})
