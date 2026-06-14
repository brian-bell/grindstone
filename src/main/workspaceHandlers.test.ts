import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import {
  loadInitialWorkspaceState,
  registerWorkspaceHandlers,
  selectRepository
} from './workspaceHandlers'

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
  })
})
