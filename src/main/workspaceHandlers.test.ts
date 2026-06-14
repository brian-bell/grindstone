import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import type { FlowListRow, RepositoryRow } from '@shared/workspace'
import {
  createFlowInWorkspace,
  createRepositoryInWorkspace,
  getCurrentEditableConfig,
  loadInitialWorkspaceState,
  registerWorkspaceHandlers,
  retryRepositoryRemoteInWorkspace,
  selectRepository,
  updateCommonConfig
} from './workspaceHandlers'
import { createFlowStore, type FlowStore } from './flowStore'
import type { FlowCommandRunner } from './flowCreation'
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
          defaultAgent: null,
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
          defaultAgent: null,
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
      ipcChannels.workspace.createFlow,
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
})
