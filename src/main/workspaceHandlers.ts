import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { handleTypedIpc, ipcChannels } from '@shared/ipc'
import {
  defaultInitialWorkspaceState,
  type CatalogDiagnostic,
  type CreateRepositoryRequest,
  type InitialWorkspaceState,
  type RepositoryCreateError,
  type RepositoryPaneState
} from '@shared/workspace'
import { loadGrindstoneConfig, type ConfiguredPath, type LoadGrindstoneConfigOptions } from './config'
import { scanRepositoryCatalog, type RepositoryCatalogResult } from './repositoryCatalog'
import {
  createRepository,
  retryRepositoryRemote,
  type CommandRunner
} from './repositoryCreation'

type WorkspaceContext = {
  configOptions: LoadGrindstoneConfigOptions
  catalogInput: {
    scanRoots: ConfiguredPath[]
    repos: ConfiguredPath[]
  }
  scanRoots: RepositoryPaneState['create']['scanRoots']
  catalog: RepositoryCatalogResult
  selectedRepositoryId: string | null
  remoteRetries: RepositoryPaneState['create']['remoteRetries']
  state: InitialWorkspaceState
}

let currentWorkspaceContext: WorkspaceContext | undefined

export async function loadInitialWorkspaceState(
  options: LoadGrindstoneConfigOptions = {}
): Promise<InitialWorkspaceState> {
  const config = await loadGrindstoneConfig(options)

  if (!config.ok) {
    const state = {
      ...defaultInitialWorkspaceState,
      repository: createRepositoryErrorState(config.diagnostics)
    }
    currentWorkspaceContext = {
      configOptions: options,
      catalogInput: {
        scanRoots: [],
        repos: []
      },
      scanRoots: [],
      catalog: {
        repositories: [],
        diagnostics: config.diagnostics
      },
      selectedRepositoryId: null,
      remoteRetries: [],
      state
    }
    return state
  }

  const catalog = await scanRepositoryCatalog({
    scanRoots: config.scanRoots,
    repos: config.repos
  })
  const scanRoots = createRepositoryScanRoots(config.scanRoots)

  const state: InitialWorkspaceState = {
    ...defaultInitialWorkspaceState,
    repository: createRepositoryReadyState({
      catalog,
      scanRoots,
      selectedRepositoryId: null,
      remoteRetries: [],
      error: null
    })
  }
  currentWorkspaceContext = {
    configOptions: options,
    catalogInput: {
      scanRoots: config.scanRoots,
      repos: config.repos
    },
    scanRoots,
    catalog,
    selectedRepositoryId: null,
    remoteRetries: [],
    state
  }
  return state
}

export async function selectRepository(request: {
  repositoryId: string
}): Promise<InitialWorkspaceState> {
  const context = await getWorkspaceContext()
  const workspaceState = context.state
  const repository = workspaceState.repository.repositories.find(
    (row) => row.id === request.repositoryId
  )

  if (repository === undefined) {
    throw new Error(`Repository not found: ${request.repositoryId}`)
  }

  const state: InitialWorkspaceState = {
    ...workspaceState,
    repository: {
      ...workspaceState.repository,
      title: repository.name,
      description: repository.path,
      selectedRepositoryId: repository.id
    },
    flow: {
      status: 'empty',
      title: `${repository.name} Flow workspace`,
      description: `Flow context is scoped to ${repository.path}.`
    }
  }
  context.selectedRepositoryId = repository.id
  context.state = state
  return state
}

export async function createRepositoryInWorkspace(
  request: CreateRepositoryRequest,
  options: { runCommand?: CommandRunner } = {}
): Promise<InitialWorkspaceState> {
  const context = await getWorkspaceContext()
  const result = await createRepository({
    scanRoots: context.scanRoots,
    request,
    runCommand: options.runCommand
  })

  if (!result.ok) {
    context.state = updateRepositoryCreateState(context, result.error)
    return context.state
  }

  if (result.retry !== null) {
    context.remoteRetries = upsertRetry(context.remoteRetries, result.retry)
  }

  const catalog = await scanRepositoryCatalog(context.catalogInput)
  context.catalog = mergeCreatedRepository(catalog, result.repository)
  context.state = createWorkspaceState(context, null)
  return context.state
}

export async function retryRepositoryRemoteInWorkspace(
  request: { retryId: string },
  options: { runCommand?: CommandRunner } = {}
): Promise<InitialWorkspaceState> {
  const context = await getWorkspaceContext()
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.retryId !== 'string' ||
    request.retryId.trim() === ''
  ) {
    const error: RepositoryCreateError = {
      code: 'remote_creation_failed',
      message: 'Remote retry request is invalid.'
    }
    context.state = updateRepositoryCreateState(context, error)
    return context.state
  }

  const retry = context.remoteRetries.find((candidate) => candidate.id === request.retryId)
  if (retry === undefined) {
    const error: RepositoryCreateError = {
      code: 'remote_creation_failed',
      message: `Remote retry not found: ${request.retryId}`
    }
    context.state = updateRepositoryCreateState(context, error)
    return context.state
  }

  const result = await retryRepositoryRemote({
    retry,
    runCommand: options.runCommand
  })

  context.remoteRetries = result.ok
    ? context.remoteRetries.filter((candidate) => candidate.id !== result.retry.id)
    : upsertRetry(context.remoteRetries, result.retry)
  context.state = createWorkspaceState(
    context,
    result.ok
      ? null
      : {
          code:
            result.retry.status === 'origin_conflict'
              ? 'remote_origin_conflict'
              : 'remote_creation_failed',
          message: result.retry.lastError
        }
  )
  return context.state
}

export function registerWorkspaceHandlers(ipcMain: Pick<IpcMain, 'handle'>): void {
  handleTypedIpc(ipcMain, ipcChannels.workspace.getInitialState, () =>
    loadInitialWorkspaceState()
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.selectRepository, (request) =>
    selectRepository(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.createRepository, (request) =>
    createRepositoryInWorkspace(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.retryRepositoryRemote, (request) =>
    retryRepositoryRemoteInWorkspace(request)
  )
}

function createRepositoryReadyState({
  catalog,
  scanRoots,
  selectedRepositoryId,
  remoteRetries,
  error
}: {
  catalog: RepositoryCatalogResult
  scanRoots: RepositoryPaneState['create']['scanRoots']
  selectedRepositoryId: string | null
  remoteRetries: RepositoryPaneState['create']['remoteRetries']
  error: RepositoryCreateError | null
}): RepositoryPaneState {
  const repositoryCount = catalog.repositories.length

  return {
    status: 'ready',
    title: repositoryCount === 0 ? 'No repositories configured' : 'Repository catalog',
    description:
      repositoryCount === 0
        ? 'Add scan_roots or repos to Grindstone config to populate this pane.'
        : `${repositoryCount} ${pluralize('repository', repositoryCount)} configured.`,
    repositories: catalog.repositories,
    selectedRepositoryId,
    diagnostics: catalog.diagnostics,
    create: {
      scanRoots,
      available: scanRoots.length > 0,
      error,
      remoteRetries
    }
  }
}

function createRepositoryErrorState(diagnostics: CatalogDiagnostic[]): RepositoryPaneState {
  return {
    status: 'error',
    title: 'Repository catalog unavailable',
    description: firstDiagnosticMessage(diagnostics),
    repositories: [],
    selectedRepositoryId: null,
    diagnostics,
    create: {
      scanRoots: [],
      available: false,
      error: null,
      remoteRetries: []
    }
  }
}

async function getWorkspaceContext(): Promise<WorkspaceContext> {
  if (currentWorkspaceContext === undefined) {
    await loadInitialWorkspaceState()
  }

  return currentWorkspaceContext as WorkspaceContext
}

function createWorkspaceState(
  context: WorkspaceContext,
  error: RepositoryCreateError | null
): InitialWorkspaceState {
  const selectedRepository = context.catalog.repositories.find(
    (repository) => repository.id === context.selectedRepositoryId
  )
  const repositoryState = createRepositoryReadyState({
    catalog: context.catalog,
    scanRoots: context.scanRoots,
    selectedRepositoryId: selectedRepository?.id ?? null,
    remoteRetries: context.remoteRetries,
    error
  })

  if (selectedRepository === undefined) {
    context.selectedRepositoryId = null
    return {
      ...defaultInitialWorkspaceState,
      repository: repositoryState
    }
  }

  return {
    ...defaultInitialWorkspaceState,
    repository: {
      ...repositoryState,
      title: selectedRepository.name,
      description: selectedRepository.path
    },
    flow: {
      status: 'empty',
      title: `${selectedRepository.name} Flow workspace`,
      description: `Flow context is scoped to ${selectedRepository.path}.`
    }
  }
}

function updateRepositoryCreateState(
  context: WorkspaceContext,
  error: RepositoryCreateError
): InitialWorkspaceState {
  return {
    ...context.state,
    repository: {
      ...context.state.repository,
      create: {
        ...context.state.repository.create,
        error
      }
    }
  }
}

function createRepositoryScanRoots(scanRoots: ConfiguredPath[]): RepositoryPaneState['create']['scanRoots'] {
  const usedIds = new Map<string, number>()

  return scanRoots.map((scanRoot, index) => {
    const baseId = `scan-root:${index}:${hashScanRoot(scanRoot)}`
    const collisionCount = usedIds.get(baseId) ?? 0
    usedIds.set(baseId, collisionCount + 1)
    const id = collisionCount === 0 ? baseId : `${baseId}:${collisionCount + 1}`

    return {
      id,
      configuredPath: scanRoot.configuredPath,
      resolvedPath: scanRoot.resolvedPath,
      displayPath:
        scanRoot.configuredPath === scanRoot.resolvedPath
          ? scanRoot.resolvedPath
          : `${scanRoot.configuredPath} -> ${scanRoot.resolvedPath}`
    }
  })
}

function hashScanRoot(scanRoot: ConfiguredPath): string {
  return createHash('sha256')
    .update(`${scanRoot.configuredPath}\0${scanRoot.resolvedPath}`)
    .digest('hex')
    .slice(0, 12)
}

function mergeCreatedRepository(
  catalog: RepositoryCatalogResult,
  repository: RepositoryCatalogResult['repositories'][number]
): RepositoryCatalogResult {
  if (catalog.repositories.some((row) => row.canonicalPath === repository.canonicalPath)) {
    return catalog
  }

  return {
    ...catalog,
    repositories: [...catalog.repositories, repository].sort((left, right) =>
      left.canonicalPath.localeCompare(right.canonicalPath)
    )
  }
}

function upsertRetry(
  retries: RepositoryPaneState['create']['remoteRetries'],
  retry: RepositoryPaneState['create']['remoteRetries'][number]
): RepositoryPaneState['create']['remoteRetries'] {
  return [...retries.filter((candidate) => candidate.id !== retry.id), retry]
}

function firstDiagnosticMessage(diagnostics: CatalogDiagnostic[]): string {
  return diagnostics[0]?.message ?? 'Unable to load repository catalog.'
}

function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`
}
