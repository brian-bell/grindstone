import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { scanRepositoryCatalog } from './repositoryCatalog'
import type { ConfiguredPath } from './config'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-catalog-'))
}

async function makeGitRepository(path: string, gitEntry: 'dir' | 'file' = 'dir'): Promise<void> {
  await mkdir(path, { recursive: true })
  if (gitEntry === 'dir') {
    await mkdir(join(path, '.git'))
  } else {
    await writeFile(join(path, '.git'), 'gitdir: ../.git/worktrees/repo\n')
  }
}

function configuredPath(path: string): ConfiguredPath {
  return {
    configuredPath: path,
    resolvedPath: path
  }
}

describe('repository catalog scanner', () => {
  const chmodRestores: string[] = []

  afterEach(async () => {
    await Promise.all(chmodRestores.splice(0).map((path) => chmod(path, 0o700)))
  })

  it('discovers Git repositories under scan roots and prunes generated worktree directories', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'projects')
    const alpha = join(scanRoot, 'alpha')
    const beta = join(scanRoot, 'nested', 'beta')
    const worktreeRepo = join(scanRoot, 'grindstone-worktrees', 'ignored-repo')
    const dependencyRepo = join(scanRoot, 'node_modules', 'ignored-dep')
    await makeGitRepository(alpha)
    await makeGitRepository(beta, 'file')
    await makeGitRepository(worktreeRepo)
    await makeGitRepository(dependencyRepo)

    const catalog = await scanRepositoryCatalog({
      scanRoots: [configuredPath(scanRoot)],
      repos: []
    })

    expect(catalog.diagnostics).toEqual([])
    expect(catalog.repositories.map((repo) => repo.path)).toEqual([alpha, beta])
    expect(catalog.repositories.map((repo) => repo.sources)).toEqual([
      ['scan_root'],
      ['scan_root']
    ])
    expect(catalog.repositories.map((repo) => repo.name)).toEqual(['alpha', 'beta'])
  })

  it('includes explicit repositories under generated worktree directories and reports missing explicit repos', async () => {
    const root = await makeTempDir()
    const explicitRepo = join(root, 'grindstone-worktrees', 'valid-repo')
    const missingRepo = join(root, 'grindstone-worktrees', 'missing-repo')
    await makeGitRepository(explicitRepo)

    const catalog = await scanRepositoryCatalog({
      scanRoots: [configuredPath(root)],
      repos: [configuredPath(explicitRepo), configuredPath(missingRepo)]
    })

    expect(catalog.repositories).toHaveLength(1)
    expect(catalog.repositories[0]).toMatchObject({
      id: await realpath(explicitRepo),
      name: basename(explicitRepo),
      path: explicitRepo,
      canonicalPath: await realpath(explicitRepo),
      sources: ['explicit']
    })
    expect(catalog.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'explicit_repo_missing',
        message: `Explicit repository does not exist or is not a Git repository: ${missingRepo}`,
        configuredPath: missingRepo,
        resolvedPath: missingRepo
      }
    ])
  })

  it('canonicalizes, sorts, and deduplicates scanned and explicit repository paths', async () => {
    const root = await makeTempDir()
    const scanRoot = join(root, 'scan')
    const explicitRepo = join(scanRoot, 'zeta')
    const scannedRepo = join(scanRoot, 'alpha')
    const symlinkPath = join(root, 'linked-zeta')
    await makeGitRepository(explicitRepo)
    await makeGitRepository(scannedRepo)
    await symlink(explicitRepo, symlinkPath)

    const catalog = await scanRepositoryCatalog({
      scanRoots: [configuredPath(scanRoot)],
      repos: [configuredPath(symlinkPath)]
    })

    expect(catalog.repositories.map((repo) => repo.canonicalPath)).toEqual(
      [await realpath(scannedRepo), await realpath(explicitRepo)].sort()
    )
    expect(catalog.repositories[1]).toMatchObject({
      id: await realpath(explicitRepo),
      path: explicitRepo,
      canonicalPath: await realpath(explicitRepo),
      sources: ['scan_root', 'explicit']
    })
  })

  it('reports missing and unreadable scan roots without blocking valid repositories', async () => {
    const root = await makeTempDir()
    const validRoot = join(root, 'valid')
    const validRepo = join(validRoot, 'repo')
    const missingRoot = join(root, 'missing')
    const unreadableRoot = join(root, 'unreadable')
    await makeGitRepository(validRepo)
    await mkdir(unreadableRoot)
    await chmod(unreadableRoot, 0)
    chmodRestores.push(unreadableRoot)

    const catalog = await scanRepositoryCatalog({
      scanRoots: [
        configuredPath(missingRoot),
        configuredPath(unreadableRoot),
        configuredPath(validRoot)
      ],
      repos: []
    })

    expect(catalog.repositories.map((repo) => repo.path)).toEqual([validRepo])
    expect(catalog.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'scan_root_missing',
        message: `Scan root does not exist: ${missingRoot}`,
        configuredPath: missingRoot,
        resolvedPath: missingRoot
      },
      {
        severity: 'warning',
        code: 'scan_root_unreadable',
        message: `Scan root is not readable: ${unreadableRoot}`,
        configuredPath: unreadableRoot,
        resolvedPath: unreadableRoot
      }
    ])
  })
})
