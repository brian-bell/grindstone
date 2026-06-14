import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, sep } from 'node:path'
import type { ConfiguredPath } from './config'
import type { CatalogDiagnostic, RepositoryRow, RepositorySource } from '@shared/workspace'

export type RepositoryCatalogInput = {
  scanRoots: ConfiguredPath[]
  repos: ConfiguredPath[]
}

export type RepositoryCatalogResult = {
  repositories: RepositoryRow[]
  diagnostics: CatalogDiagnostic[]
}

const PRUNED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'grindstone-worktrees'
])

export async function scanRepositoryCatalog(
  input: RepositoryCatalogInput
): Promise<RepositoryCatalogResult> {
  const repositoryMap = new Map<string, RepositoryRow>()
  const diagnostics: CatalogDiagnostic[] = []

  for (const scanRoot of input.scanRoots) {
    await scanRootForRepositories(scanRoot, repositoryMap, diagnostics)
  }

  for (const repo of input.repos) {
    await addExplicitRepository(repo, repositoryMap, diagnostics)
  }

  return {
    repositories: [...repositoryMap.values()].sort((left, right) =>
      left.canonicalPath.localeCompare(right.canonicalPath)
    ),
    diagnostics
  }
}

async function scanRootForRepositories(
  scanRoot: ConfiguredPath,
  repositoryMap: Map<string, RepositoryRow>,
  diagnostics: CatalogDiagnostic[]
): Promise<void> {
  const rootStat = await safeStat(scanRoot.resolvedPath)
  if (rootStat === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'scan_root_missing',
      message: `Scan root does not exist: ${scanRoot.resolvedPath}`,
      configuredPath: scanRoot.configuredPath,
      resolvedPath: scanRoot.resolvedPath
    })
    return
  }

  if (!rootStat.isDirectory()) {
    diagnostics.push({
      severity: 'warning',
      code: 'scan_root_unreadable',
      message: `Scan root is not readable: ${scanRoot.resolvedPath}`,
      configuredPath: scanRoot.configuredPath,
      resolvedPath: scanRoot.resolvedPath
    })
    return
  }

  await walk(scanRoot.resolvedPath, scanRoot, repositoryMap, diagnostics)
}

async function walk(
  currentPath: string,
  scanRoot: ConfiguredPath,
  repositoryMap: Map<string, RepositoryRow>,
  diagnostics: CatalogDiagnostic[]
): Promise<void> {
  let entries
  try {
    entries = await readdir(currentPath, { withFileTypes: true })
  } catch {
    if (currentPath === scanRoot.resolvedPath) {
      diagnostics.push({
        severity: 'warning',
        code: 'scan_root_unreadable',
        message: `Scan root is not readable: ${scanRoot.resolvedPath}`,
        configuredPath: scanRoot.configuredPath,
        resolvedPath: scanRoot.resolvedPath
      })
    }
    return
  }

  if (entries.some((entry) => entry.name === '.git') && await isGitRepository(currentPath)) {
    await addRepository(currentPath, 'scan_root', repositoryMap)
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    if (shouldPruneDirectory(entry.name)) {
      continue
    }

    await walk(`${currentPath}${sep}${entry.name}`, scanRoot, repositoryMap, diagnostics)
  }
}

async function addExplicitRepository(
  repo: ConfiguredPath,
  repositoryMap: Map<string, RepositoryRow>,
  diagnostics: CatalogDiagnostic[]
): Promise<void> {
  if (!(await isGitRepository(repo.resolvedPath))) {
    diagnostics.push({
      severity: 'warning',
      code: 'explicit_repo_missing',
      message: `Explicit repository does not exist or is not a Git repository: ${repo.resolvedPath}`,
      configuredPath: repo.configuredPath,
      resolvedPath: repo.resolvedPath
    })
    return
  }

  await addRepository(repo.resolvedPath, 'explicit', repositoryMap)
}

async function addRepository(
  repositoryPath: string,
  source: RepositorySource,
  repositoryMap: Map<string, RepositoryRow>
): Promise<void> {
  const canonicalPath = await realpath(repositoryPath)
  const existing = repositoryMap.get(canonicalPath)

  if (existing !== undefined) {
    existing.sources = mergeSources(existing.sources, source)
    return
  }

  repositoryMap.set(canonicalPath, {
    id: canonicalPath,
    name: basename(canonicalPath),
    path: repositoryPath,
    canonicalPath,
    sources: [source]
  })
}

async function isGitRepository(path: string): Promise<boolean> {
  const pathStat = await safeStat(path)
  if (pathStat === undefined || !pathStat.isDirectory()) {
    return false
  }

  const gitStat = await safeStat(`${path}${sep}.git`)
  return gitStat !== undefined && (gitStat.isDirectory() || gitStat.isFile())
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

function shouldPruneDirectory(name: string): boolean {
  return PRUNED_DIRECTORY_NAMES.has(name)
}

function mergeSources(existingSources: RepositorySource[], newSource: RepositorySource): RepositorySource[] {
  const sources = new Set<RepositorySource>(existingSources)
  sources.add(newSource)

  const orderedSources: RepositorySource[] = ['scan_root', 'explicit']
  return orderedSources.filter((source) => sources.has(source))
}
