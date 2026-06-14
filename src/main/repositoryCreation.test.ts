import { access, lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CreateRepositoryRequest, RepositoryScanRoot } from '@shared/workspace'
import {
  CommandRunError,
  createRepository,
  retryRepositoryRemote,
  type CommandRunner
} from './repositoryCreation'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-create-repo-'))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function scanRoot(root: string): RepositoryScanRoot {
  return {
    id: 'scan-root:0:test',
    configuredPath: root,
    resolvedPath: root,
    displayPath: root
  }
}

function request(
  overrides: Partial<CreateRepositoryRequest> = {}
): CreateRepositoryRequest {
  return {
    scanRootId: 'scan-root:0:test',
    name: 'new-repo',
    github: {
      enabled: false,
      visibility: 'public'
    },
    ...overrides
  }
}

describe('repository creation service', () => {
  it.each(['', '.', '..', '-repo', '--help', '../escape', 'nested/repo', 'nested\\repo'])(
    'rejects invalid repository name %j before filesystem mutation',
    async (name) => {
      const root = await makeTempDir()
      const runCommand = vi.fn<CommandRunner>()

      await expect(
        createRepository({
          scanRoots: [scanRoot(root)],
          request: request({ name }),
          runCommand
        })
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'validation_error'
        }
      })

      expect(runCommand).not.toHaveBeenCalled()
      expect(await readdir(root)).toEqual([])
    }
  )

  it.each(['.git', 'node_modules', 'dist', 'build', 'coverage', 'grindstone-worktrees'])(
    'rejects catalog-reserved repository name %j before filesystem mutation',
    async (name) => {
      const root = await makeTempDir()
      const runCommand = vi.fn<CommandRunner>()

      await expect(
        createRepository({
          scanRoots: [scanRoot(root)],
          request: request({ name }),
          runCommand
        })
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Repository name is reserved by the catalog scanner.'
        }
      })

      expect(runCommand).not.toHaveBeenCalled()
      expect(await readdir(root)).toEqual([])
    }
  )

  it('rejects forged scan-root ids instead of accepting renderer paths', async () => {
    const root = await makeTempDir()
    const runCommand = vi.fn<CommandRunner>()

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: request({ scanRootId: 'scan-root:forged' }),
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'scan_root_unavailable'
      }
    })

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects scan roots that are already Git repositories before filesystem mutation', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '.git'))
    const runCommand = vi.fn<CommandRunner>()

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: request(),
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Cannot create repositories inside a scan root that is already a Git repository.'
      }
    })

    expect(runCommand).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['.git'])
  })

  it('rejects malformed create requests before filesystem mutation', async () => {
    const root = await makeTempDir()
    const runCommand = vi.fn<CommandRunner>()

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: {
          scanRootId: 'scan-root:0:test',
          name: 'new-repo',
          github: {
            enabled: true,
            visibility: 'internal'
          }
        } as unknown as CreateRepositoryRequest,
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'GitHub visibility must be public or private.'
      }
    })

    expect(runCommand).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('rejects existing target directories before running git', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'new-repo'))
    const runCommand = vi.fn<CommandRunner>()

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: request(),
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'target_exists'
      }
    })

    expect(runCommand).not.toHaveBeenCalled()
  })

  it('creates the local Git repository before optional GitHub setup', async () => {
    const root = await makeTempDir()
    const commands: string[] = []
    const runCommand: CommandRunner = vi.fn(async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')} cwd=${options.cwd}`)
      return { stdout: '' }
    })

    const result = await createRepository({
      scanRoots: [scanRoot(root)],
      request: request({
        github: {
          enabled: true,
          visibility: 'private'
        }
      }),
      runCommand
    })

    const targetPath = join(root, 'new-repo')
    const canonicalTargetPath = await realpath(targetPath)
    await expect(lstat(targetPath)).resolves.toMatchObject({})
    expect(result).toMatchObject({
      ok: true,
      repository: {
        id: canonicalTargetPath,
        name: 'new-repo',
        path: canonicalTargetPath,
        canonicalPath: canonicalTargetPath,
        sources: ['scan_root']
      },
      retry: null
    })
    expect(commands).toEqual([
      `git init cwd=${canonicalTargetPath}`,
      `gh repo create new-repo --source ${canonicalTargetPath} --remote origin --private cwd=${canonicalTargetPath}`
    ])
  })

  it('keeps local success and returns retry metadata when GitHub setup fails', async () => {
    const root = await makeTempDir()
    const runCommand: CommandRunner = vi.fn(async (command) => {
      if (command === 'gh') {
        throw new CommandRunError('gh', ['repo', 'create'], 'authentication required')
      }
      return { stdout: '' }
    })

    const result = await createRepository({
      scanRoots: [scanRoot(root)],
      request: request({
        github: {
          enabled: true,
          visibility: 'public'
        }
      }),
      runCommand
    })

    const targetPath = join(root, 'new-repo')
    const canonicalTargetPath = await realpath(targetPath)
    expect(await pathExists(targetPath)).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      repository: {
        path: canonicalTargetPath
      },
      retry: {
        id: `remote-retry:${canonicalTargetPath}`,
        repositoryId: canonicalTargetPath,
        repositoryPath: canonicalTargetPath,
        githubRepositoryName: 'new-repo',
        visibility: 'public',
        status: 'remote_create_failed',
        lastError: 'authentication required'
      }
    })
  })

  it('captures a verified GitHub URL when repository creation may have succeeded without origin wiring', async () => {
    const root = await makeTempDir()
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo create new-repo') {
        throw new CommandRunError('gh', ['repo', 'create'], 'could not add origin')
      }

      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo view new-repo') {
        return { stdout: 'https://github.com/example/new-repo\n' }
      }

      return { stdout: '' }
    })

    const result = await createRepository({
      scanRoots: [scanRoot(root)],
      request: request({
        github: {
          enabled: true,
          visibility: 'private'
        }
      }),
      runCommand
    })

    expect(result).toMatchObject({
      ok: true,
      retry: {
        status: 'remote_maybe_created_origin_failed',
        lastError: 'could not add origin',
        expectedOriginUrl: 'https://github.com/example/new-repo'
      }
    })
  })

  it('does not reuse an existing GitHub repository after create reports a name conflict', async () => {
    const root = await makeTempDir()
    const commands: string[] = []
    const runCommand: CommandRunner = vi.fn(async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')} cwd=${options.cwd}`)
      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo create new-repo') {
        throw new CommandRunError(
          'gh',
          ['repo', 'create'],
          'GraphQL: Name already exists on this account'
        )
      }

      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo view new-repo') {
        return { stdout: 'https://github.com/example/new-repo\n' }
      }

      return { stdout: '' }
    })

    const result = await createRepository({
      scanRoots: [scanRoot(root)],
      request: request({
        github: {
          enabled: true,
          visibility: 'private'
        }
      }),
      runCommand
    })

    const targetPath = join(root, 'new-repo')
    const canonicalTargetPath = await realpath(targetPath)
    expect(result).toMatchObject({
      ok: true,
      retry: {
        status: 'remote_create_failed',
        lastError: 'GraphQL: Name already exists on this account',
        expectedOriginUrl: null
      }
    })
    expect(commands).toEqual([
      `git init cwd=${canonicalTargetPath}`,
      `gh repo create new-repo --source ${canonicalTargetPath} --remote origin --private cwd=${canonicalTargetPath}`
    ])
  })

  it('removes the target directory when git init fails after mkdir', async () => {
    const root = await makeTempDir()
    const runCommand: CommandRunner = vi.fn(async () => {
      throw new CommandRunError('git', ['init'], 'git init failed')
    })

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: request(),
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'local_creation_failed',
        message: 'git init failed'
      }
    })

    expect(await pathExists(join(root, 'new-repo'))).toBe(false)
  })

  it('reports cleanup failures when git init leaves a partial target behind', async () => {
    const root = await makeTempDir()
    const runCommand: CommandRunner = vi.fn(async () => {
      throw new CommandRunError('git', ['init'], 'git init failed')
    })

    await expect(
      createRepository({
        scanRoots: [scanRoot(root)],
        request: request(),
        runCommand,
        removeTarget: async () => {
          throw new Error('permission denied')
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'local_creation_failed',
        message: 'git init failed Cleanup also failed: permission denied'
      }
    })
  })

  it('retries only the remote setup without recreating the local repository', async () => {
    const root = await makeTempDir()
    const repositoryPath = join(root, 'new-repo')
    await mkdir(repositoryPath)
    const commands: string[] = []
    const runCommand: CommandRunner = vi.fn(async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')} cwd=${options.cwd}`)
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        throw new CommandRunError('git', args, 'No such remote')
      }
      return { stdout: '' }
    })

    await expect(
      retryRepositoryRemote({
        retry: {
          id: `remote-retry:${repositoryPath}`,
          repositoryId: repositoryPath,
          repositoryPath,
          githubRepositoryName: 'new-repo',
          visibility: 'private',
          status: 'remote_create_failed',
          lastError: 'authentication required',
          expectedOriginUrl: null
        },
        runCommand
      })
    ).resolves.toMatchObject({
      ok: true,
      retry: {
        status: 'succeeded',
        lastError: ''
      }
    })

    expect(commands).toEqual([
      `git remote get-url origin cwd=${repositoryPath}`,
      `gh repo create new-repo --source ${repositoryPath} --remote origin --private cwd=${repositoryPath}`
    ])
  })

  it('adds a missing origin from verified retry metadata without re-running GitHub creation', async () => {
    const root = await makeTempDir()
    const repositoryPath = join(root, 'new-repo')
    await mkdir(repositoryPath)
    const commands: string[] = []
    const runCommand: CommandRunner = vi.fn(async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')} cwd=${options.cwd}`)
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        throw new CommandRunError('git', args, 'No such remote')
      }

      return { stdout: '' }
    })

    await expect(
      retryRepositoryRemote({
        retry: {
          id: `remote-retry:${repositoryPath}`,
          repositoryId: repositoryPath,
          repositoryPath,
          githubRepositoryName: 'new-repo',
          visibility: 'private',
          status: 'remote_maybe_created_origin_failed',
          lastError: 'origin add failed',
          expectedOriginUrl: 'https://github.com/example/new-repo'
        },
        runCommand
      })
    ).resolves.toMatchObject({
      ok: true,
      retry: {
        status: 'succeeded',
        lastError: ''
      }
    })

    expect(commands).toEqual([
      `git remote get-url origin cwd=${repositoryPath}`,
      `git remote add origin https://github.com/example/new-repo cwd=${repositoryPath}`
    ])
  })

  it('does not add an existing GitHub repository as origin after retry create reports a name conflict', async () => {
    const root = await makeTempDir()
    const repositoryPath = join(root, 'new-repo')
    await mkdir(repositoryPath)
    const commands: string[] = []
    const runCommand: CommandRunner = vi.fn(async (command, args, options) => {
      commands.push(`${command} ${args.join(' ')} cwd=${options.cwd}`)
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        throw new CommandRunError('git', args, 'No such remote')
      }

      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo create new-repo') {
        throw new CommandRunError(
          'gh',
          ['repo', 'create'],
          'GraphQL: Name already exists on this account'
        )
      }

      if (command === 'gh' && args.slice(0, 3).join(' ') === 'repo view new-repo') {
        return { stdout: 'https://github.com/example/new-repo\n' }
      }

      return { stdout: '' }
    })

    await expect(
      retryRepositoryRemote({
        retry: {
          id: `remote-retry:${repositoryPath}`,
          repositoryId: repositoryPath,
          repositoryPath,
          githubRepositoryName: 'new-repo',
          visibility: 'private',
          status: 'remote_create_failed',
          lastError: 'authentication required',
          expectedOriginUrl: null
        },
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      retry: {
        status: 'remote_create_failed',
        lastError: 'GraphQL: Name already exists on this account',
        expectedOriginUrl: null
      }
    })

    expect(commands).toEqual([
      `git remote get-url origin cwd=${repositoryPath}`,
      `gh repo create new-repo --source ${repositoryPath} --remote origin --private cwd=${repositoryPath}`
    ])
  })

  it('surfaces origin conflicts during remote retry without overwriting the existing remote', async () => {
    const root = await makeTempDir()
    const repositoryPath = join(root, 'new-repo')
    await mkdir(repositoryPath)
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        return { stdout: 'https://github.com/other/repo.git\n' }
      }
      return { stdout: '' }
    })

    await expect(
      retryRepositoryRemote({
        retry: {
          id: `remote-retry:${repositoryPath}`,
          repositoryId: repositoryPath,
          repositoryPath,
          githubRepositoryName: 'new-repo',
          visibility: 'private',
          status: 'remote_maybe_created_origin_failed',
          lastError: 'origin add failed',
          expectedOriginUrl: 'https://github.com/example/new-repo.git'
        },
        runCommand
      })
    ).resolves.toMatchObject({
      ok: false,
      retry: {
        status: 'origin_conflict',
        lastError: 'Existing origin points to https://github.com/other/repo.git.'
      }
    })

    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://github.com/example/new-repo.git',
    'git@github.com:example/new-repo.git',
    'ssh://git@github.com/example/new-repo.git'
  ])('treats equivalent GitHub origin %s as already matching', async (originUrl) => {
    const root = await makeTempDir()
    const repositoryPath = join(root, 'new-repo')
    await mkdir(repositoryPath)
    const runCommand: CommandRunner = vi.fn(async (command, args) => {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') {
        return { stdout: `${originUrl}\n` }
      }
      return { stdout: '' }
    })

    await expect(
      retryRepositoryRemote({
        retry: {
          id: `remote-retry:${repositoryPath}`,
          repositoryId: repositoryPath,
          repositoryPath,
          githubRepositoryName: 'new-repo',
          visibility: 'private',
          status: 'remote_maybe_created_origin_failed',
          lastError: 'origin add failed',
          expectedOriginUrl: 'https://github.com/example/new-repo'
        },
        runCommand
      })
    ).resolves.toMatchObject({
      ok: true,
      retry: {
        status: 'succeeded',
        lastError: ''
      }
    })

    expect(runCommand).toHaveBeenCalledTimes(1)
  })
})
