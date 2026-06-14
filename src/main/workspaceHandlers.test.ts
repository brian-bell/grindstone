import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import {
  createRepositoryInWorkspace,
  loadInitialWorkspaceState,
  registerWorkspaceHandlers,
  retryRepositoryRemoteInWorkspace,
  selectRepository
} from './workspaceHandlers'
import { CommandRunError, type CommandRunner } from './repositoryCreation'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-workspace-'))
}

async function makeGitRepository(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
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
      create: {
        available: false,
        scanRoots: []
      },
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

  it('selects a repository and scopes the Flow workspace state', async () => {
    const root = await makeTempDir()
    const repoPath = join(root, 'repo-beta')
    await makeGitRepository(repoPath)
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `repos = ["${repoPath}"]\n`)

    const state = await loadInitialWorkspaceState({ configPath })
    const repositoryId = state.repository.repositories[0]?.id ?? ''

    await expect(selectRepository({ repositoryId })).resolves.toMatchObject({
      repository: {
        selectedRepositoryId: repositoryId
      },
      flow: {
        title: 'repo-beta Flow workspace',
        description: `Flow context is scoped to ${repoPath}.`
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

  it('retries remote setup from stored retry metadata', async () => {
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

    expect(state.repository.create.remoteRetries).toEqual([
      expect.objectContaining({
        id: retryId,
        status: 'succeeded',
        lastError: ''
      })
    ])
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
      ipcChannels.workspace.createRepository,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.retryRepositoryRemote,
      expect.any(Function)
    )
  })
})
