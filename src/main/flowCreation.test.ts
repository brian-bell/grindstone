import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryRow } from '@shared/workspace'
import { createFlow, type FlowCommandRunner } from './flowCreation'
import { createFlowStore } from './flowStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-flow-create-'))
}

async function makeRepository(root: string, name: string): Promise<RepositoryRow> {
  const repositoryPath = join(root, name)
  await mkdir(join(repositoryPath, '.git'), { recursive: true })
  const canonicalPath = await realpath(repositoryPath)
  return {
    id: canonicalPath,
    name,
    path: canonicalPath,
    canonicalPath,
    sources: ['explicit']
  }
}

function gitRunner(): FlowCommandRunner {
  return async (_command, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
      throw new Error('branch not found')
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { stdout: 'abc123\n' }
    }
    return { stdout: '' }
  }
}

describe('Flow creation engine', () => {
  it('rejects unsafe base refs before creating records or running commands', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-validation')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    const runCommand = vi.fn<FlowCommandRunner>()

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Unsafe base',
        instructions: 'Do not run commands.',
        baseRef: '--bad'
      },
      store,
      runCommand
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Base ref is not safe to resolve.'
      }
    })
    expect(runCommand).not.toHaveBeenCalled()
    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([])
  })

  it('uses a deterministic suffix when the requested Flow id already exists', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-collision')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    await store.createFlowRecord({
      id: 'duplicate-title',
      title: 'Duplicate title',
      instructions: 'Existing record.',
      status: 'active',
      repositoryPath: repository.path,
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z'
    })

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Duplicate title',
        instructions: 'Create the suffixed record.'
      },
      store,
      runCommand: gitRunner(),
      now: () => '2026-06-14T11:00:00.000Z'
    })).resolves.toMatchObject({
      ok: true,
      flow: {
        id: 'duplicate-title-2',
        branch: 'flow/duplicate-title-2',
        worktreePath: join(`${repository.path}-worktrees`, 'flow-duplicate-title-2')
      }
    })
  })

  it('persists launch preparation failures after worktree metadata exists', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-launch-failure')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })

    const result = await createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Launch failure',
        instructions: 'Prepare launch metadata.'
      },
      store,
      runCommand: gitRunner(),
      prepareLaunch: async () => {
        throw new Error('launch unavailable')
      },
      now: () => '2026-06-14T12:00:00.000Z'
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'launch_prep_failed',
        message: 'launch unavailable'
      },
      flow: {
        id: 'launch-failure',
        status: 'failed',
        commit: 'abc123',
        failure: {
          stage: 'launch_prep',
          message: 'launch unavailable'
        }
      }
    })
    await expect(store.readFlow('launch-failure')).resolves.toMatchObject({
      start: {
        branch: 'flow/launch-failure',
        commit: 'abc123'
      },
      failure: {
        stage: 'launch_prep'
      }
    })
  })

  it('rejects bootstrap hook cwd values that escape the worktree', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-hook-cwd')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [
        {
          command: 'npm install',
          cwd: '..'
        }
      ],
      request: {
        title: 'Escaping hook',
        instructions: 'Reject unsafe cwd.'
      },
      store,
      runCommand: gitRunner()
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'bootstrap_failed',
        message: 'Bootstrap hook cwd escapes the worktree: ..'
      },
      flow: {
        status: 'failed',
        failure: {
          stage: 'bootstrap',
          command: 'npm install'
        }
      }
    })
  })
})
