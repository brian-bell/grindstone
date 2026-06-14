import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import {
  getCurrentEditableConfig,
  loadInitialWorkspaceState,
  registerWorkspaceHandlers,
  selectRepository,
  updateCommonConfig
} from './workspaceHandlers'

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
          title: 'repo-epsilon Flow workspace'
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
      ipcChannels.config.getEditableConfig,
      expect.any(Function)
    )
    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.config.updateCommonConfig,
      expect.any(Function)
    )
  })
})
