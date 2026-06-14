import { mkdir, mkdtemp, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryRow } from '@shared/workspace'
import { createFlow, FlowCommandRunError, runFlowProcess, type FlowCommandRunner } from './flowCreation'
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
    if (args[0] === 'worktree' && args[1] === 'add' && args[2] !== undefined) {
      await mkdir(args[2], { recursive: true })
    }
    return { stdout: '' }
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Process ${pid} is still running.`)
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

describe('Flow creation engine', () => {
  it('kills shell hook process groups before returning timeout failures', async () => {
    const root = await makeTempDir()
    const childPidFile = join(root, 'child.pid')
    const script = [
      'const { spawn } = require("node:child_process")',
      'const fs = require("node:fs")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)'
    ].join(';')
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

    await expect(runFlowProcess(command, [], {
      cwd: root,
      shell: true,
      timeoutMs: 300
    })).rejects.toMatchObject({
      message: 'Command timed out.'
    })

    const childPid = Number(await readFile(childPidFile, 'utf8'))
    await expect(waitForProcessExit(childPid)).resolves.toBeUndefined()
  })

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

  it('rejects non-string base refs before creating records or running commands', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-base-ref-type')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    const runCommand = vi.fn<FlowCommandRunner>()

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Invalid base type',
        instructions: 'Do not throw.',
        baseRef: 123
      } as unknown as Parameters<typeof createFlow>[0]['request'],
      store,
      runCommand
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Create Flow request is invalid.'
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
        worktreePath: join(
          dirname(repository.path),
          'grindstone-worktrees',
          `${basename(repository.path)}-flow-duplicate-title-2`
        )
      }
    })
  })

  it('returns a structured worktree error when no collision-free allocation is available', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-allocation-exhausted')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    const runCommand: FlowCommandRunner = async (_command, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        return { stdout: 'existing\n' }
      }

      return { stdout: 'abc123\n' }
    }

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Busy title',
        instructions: 'Return a normal creation error.'
      },
      store,
      runCommand
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'worktree_creation_failed',
        message: 'Could not allocate a collision-free Flow for Busy title.'
      }
    })
    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([])
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

  it('persists quoted worktree command details when Git worktree setup fails', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo with spaces')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    const runCommand: FlowCommandRunner = async (command, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/heads/')) {
        throw new Error('branch not found')
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'abc123\n' }
      }
      if (args[0] === 'worktree') {
        throw new FlowCommandRunError(command, args, 'worktree failed', 'worktree stdout', 'worktree stderr')
      }

      return { stdout: '' }
    }

    const result = await createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [],
      request: {
        title: 'Worktree failure',
        instructions: 'Persist command context.'
      },
      store,
      runCommand
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree_creation_failed',
        message: 'worktree failed'
      },
      flow: {
        status: 'failed',
        failure: {
          stage: 'worktree',
          message: 'worktree failed',
          command: `git worktree add '${join(
            dirname(repository.path),
            'grindstone-worktrees',
            `${basename(repository.path)}-flow-worktree-failure`
          )}' flow/worktree-failure`,
          output: 'worktree stdout\nworktree stderr'
        }
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

  it('rejects bootstrap hook cwd symlinks that resolve outside the worktree', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-hook-symlink')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })
    const outside = join(root, 'outside')
    await mkdir(outside)
    const runCommand = gitRunner()
    const create = createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [
        {
          command: 'npm install',
          cwd: 'escape'
        }
      ],
      request: {
        title: 'Symlink hook',
        instructions: 'Reject symlink cwd escape.'
      },
      store,
      runCommand: async (command, args, options) => {
        const result = await runCommand(command, args, options)
        if (args[0] === 'worktree' && args[1] === 'add') {
          await symlink(outside, join(args[2] ?? '', 'escape'))
        }
        return result
      }
    })

    await expect(create).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'bootstrap_failed',
        message: 'Bootstrap hook cwd escapes the worktree: escape'
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

  it('reports bootstrap hook cwd values that cannot be resolved', async () => {
    const root = await makeTempDir()
    const repository = await makeRepository(root, 'repo-hook-missing-cwd')
    const store = await createFlowStore({ artifactRoot: join(root, 'artifacts') })

    await expect(createFlow({
      repository,
      artifactRoot: join(root, 'artifacts'),
      bootstrapHooks: [
        {
          command: 'npm install',
          cwd: 'missing'
        }
      ],
      request: {
        title: 'Missing hook cwd',
        instructions: 'Report unavailable cwd.'
      },
      store,
      runCommand: gitRunner()
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'bootstrap_failed',
        message: expect.stringContaining('Bootstrap hook cwd is unavailable:')
      },
      flow: {
        status: 'failed',
        failure: {
          stage: 'bootstrap',
          command: 'npm install',
          message: expect.stringContaining('flow-missing-hook-cwd/missing')
        }
      }
    })
  })
})
