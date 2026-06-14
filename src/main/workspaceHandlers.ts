import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { handleTypedIpc, ipcChannels } from '@shared/ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse } from '@shared/config'
import {
  defaultInitialWorkspaceState,
  type CatalogDiagnostic,
  type CreateRepositoryRequest,
  type FlowPaneState,
  type InitialWorkspaceState,
  type RepositoryCreateError,
  type RepositoryPaneState,
  type RepositoryRow
} from '@shared/workspace'
import {
  getEditableConfig,
  loadGrindstoneConfig,
  updateCommonConfigFile,
  type ConfiguredPath,
  type GrindstoneConfigResult,
  type LoadGrindstoneConfigOptions
} from './config'
import { createFlowStore, type CreateFlowStoreOptions, type FlowStore } from './flowStore'
import { scanRepositoryCatalog, type RepositoryCatalogResult } from './repositoryCatalog'
import {
  createRepository,
  retryRepositoryRemote,
  type CommandRunner
} from './repositoryCreation'

type FlowStoreFactory = (options: CreateFlowStoreOptions) => Promise<FlowStore>
type ConfigLoader = (options: LoadGrindstoneConfigOptions) => Promise<GrindstoneConfigResult>

type WorkspaceContext = {
  catalogInput: {
    scanRoots: ConfiguredPath[]
    repos: ConfiguredPath[]
  }
  scanRoots: RepositoryPaneState['create']['scanRoots']
  catalog: RepositoryCatalogResult
  remoteRetries: RepositoryPaneState['create']['remoteRetries']
}

export type LoadWorkspaceStateOptions = LoadGrindstoneConfigOptions & {
  configLoader?: ConfigLoader
  flowStoreFactory?: FlowStoreFactory
}

let currentWorkspaceContext: WorkspaceContext | undefined
let currentWorkspaceState: InitialWorkspaceState | undefined
let currentArtifactRoot: string | undefined
let currentFlowStoreFactory: FlowStoreFactory = createFlowStore
let currentSelectionRequestId = 0

export async function loadInitialWorkspaceState(
  options: LoadWorkspaceStateOptions = {}
): Promise<InitialWorkspaceState> {
  currentSelectionRequestId += 1
  const {
    configLoader = loadGrindstoneConfig,
    flowStoreFactory = createFlowStore,
    ...configOptions
  } = options
  currentFlowStoreFactory = flowStoreFactory
  currentWorkspaceState = await buildWorkspaceState(configOptions, null, configLoader)
  return currentWorkspaceState
}

async function buildWorkspaceState(
  options: LoadGrindstoneConfigOptions = {},
  selectedRepositoryId: string | null = null,
  configLoader: ConfigLoader = loadGrindstoneConfig
): Promise<InitialWorkspaceState> {
  const config = await configLoader(options)
  currentArtifactRoot = config.artifactRoot.resolvedPath

  if (!config.ok) {
    currentWorkspaceContext = {
      catalogInput: {
        scanRoots: [],
        repos: []
      },
      scanRoots: [],
      catalog: {
        repositories: [],
        diagnostics: config.diagnostics
      },
      remoteRetries: []
    }

    return {
      ...defaultInitialWorkspaceState,
      repository: createRepositoryErrorState(config.diagnostics)
    }
  }

  const catalog = await scanRepositoryCatalog({
    scanRoots: config.scanRoots,
    repos: config.repos
  })
  const scanRoots = createRepositoryScanRoots(config.scanRoots)
  const remoteRetries: RepositoryPaneState['create']['remoteRetries'] = []
  currentWorkspaceContext = {
    catalogInput: {
      scanRoots: config.scanRoots,
      repos: config.repos
    },
    scanRoots,
    catalog,
    remoteRetries
  }

  const workspaceState: InitialWorkspaceState = {
    ...defaultInitialWorkspaceState,
    repository: createRepositoryReadyState({
      catalog,
      scanRoots,
      selectedRepositoryId: null,
      remoteRetries,
      error: null
    })
  }

  if (selectedRepositoryId === null) {
    return workspaceState
  }

  const selectedRepository = workspaceState.repository.repositories.find(
    (row) => row.id === selectedRepositoryId
  )

  return selectedRepository === undefined
    ? workspaceState
    : createSelectedRepositoryState(workspaceState, selectedRepository.id)
}

export async function selectRepository(request: {
  repositoryId: string
}): Promise<InitialWorkspaceState> {
  const workspaceState = currentWorkspaceState ?? (await loadInitialWorkspaceState())
  const repository = workspaceState.repository.repositories.find(
    (row) => row.id === request.repositoryId
  )

  if (repository === undefined) {
    throw new Error(`Repository not found: ${request.repositoryId}`)
  }

  const requestId = currentSelectionRequestId + 1
  currentSelectionRequestId = requestId

  const nextWorkspaceState = await createSelectedRepositoryState(workspaceState, repository.id)

  if (requestId !== currentSelectionRequestId || workspaceState !== currentWorkspaceState) {
    return currentWorkspaceState ?? nextWorkspaceState
  }

  currentWorkspaceState = nextWorkspaceState
  return nextWorkspaceState
}

export async function updateCommonConfig(
  input: CommonConfigUpdateInput,
  options: LoadGrindstoneConfigOptions = {}
): Promise<ConfigUpdateResponse> {
  const previousSelectedRepositoryId = currentWorkspaceState?.repository.selectedRepositoryId ?? null
  const update = await updateCommonConfigFile(input, options)

  if (!update.ok) {
    return update
  }

  try {
    currentSelectionRequestId += 1
    const workspace = await buildWorkspaceState(
      {
        ...options,
        configPath: update.configPath
      },
      previousSelectedRepositoryId
    )

    if (workspace.repository.status === 'error') {
      return {
        ok: false,
        kind: 'reload_failed',
        configPath: update.configPath,
        message: workspace.repository.description,
        config: update.config
      }
    }

    currentWorkspaceState = workspace

    return {
      ok: true,
      workspace,
      config: update.config
    }
  } catch (error) {
    return {
      ok: false,
      kind: 'reload_failed',
      configPath: update.configPath,
      message: getErrorMessage(error),
      config: update.config
    }
  }
}

export function getCurrentEditableConfig(
  options: LoadGrindstoneConfigOptions = {}
): Promise<Awaited<ReturnType<typeof getEditableConfig>>> {
  return getEditableConfig(options)
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
    currentWorkspaceState = updateRepositoryCreateState(
      currentWorkspaceState ?? defaultInitialWorkspaceState,
      result.error
    )
    return currentWorkspaceState
  }

  if (result.retry !== null) {
    context.remoteRetries = upsertRetry(context.remoteRetries, result.retry)
  }

  const catalog = await scanRepositoryCatalog(context.catalogInput)
  context.catalog = mergeCreatedRepository(catalog, result.repository)
  currentWorkspaceState = await createWorkspaceStateFromContext(
    context,
    currentWorkspaceState?.repository.selectedRepositoryId ?? null,
    null
  )
  return currentWorkspaceState
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
    currentWorkspaceState = updateRepositoryCreateState(
      currentWorkspaceState ?? defaultInitialWorkspaceState,
      error
    )
    return currentWorkspaceState
  }

  const retry = context.remoteRetries.find((candidate) => candidate.id === request.retryId)
  if (retry === undefined) {
    const error: RepositoryCreateError = {
      code: 'remote_creation_failed',
      message: `Remote retry not found: ${request.retryId}`
    }
    currentWorkspaceState = updateRepositoryCreateState(
      currentWorkspaceState ?? defaultInitialWorkspaceState,
      error
    )
    return currentWorkspaceState
  }

  const result = await retryRepositoryRemote({
    retry,
    runCommand: options.runCommand
  })

  context.remoteRetries = result.ok
    ? context.remoteRetries.filter((candidate) => candidate.id !== result.retry.id)
    : upsertRetry(context.remoteRetries, result.retry)
  currentWorkspaceState = await createWorkspaceStateFromContext(
    context,
    currentWorkspaceState?.repository.selectedRepositoryId ?? null,
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
  return currentWorkspaceState
}

async function createSelectedRepositoryState(
  workspaceState: InitialWorkspaceState,
  repositoryId: string
): Promise<InitialWorkspaceState> {
  const repository = workspaceState.repository.repositories.find((row) => row.id === repositoryId)
  if (repository === undefined) {
    return workspaceState
  }

  return {
    ...workspaceState,
    repository: {
      ...workspaceState.repository,
      title: repository.name,
      description: repository.path,
      selectedRepositoryId: repository.id
    },
    flow: await createFlowPaneState(repository, currentArtifactRoot, currentFlowStoreFactory)
  }
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
  handleTypedIpc(ipcMain, ipcChannels.config.getEditableConfig, () =>
    getCurrentEditableConfig()
  )
  handleTypedIpc(ipcMain, ipcChannels.config.updateCommonConfig, (request) =>
    updateCommonConfig(request)
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

async function createWorkspaceStateFromContext(
  context: WorkspaceContext,
  selectedRepositoryId: string | null,
  error: RepositoryCreateError | null
): Promise<InitialWorkspaceState> {
  const selectedRepository = context.catalog.repositories.find(
    (repository) => repository.id === selectedRepositoryId
  )
  const repositoryState = createRepositoryReadyState({
    catalog: context.catalog,
    scanRoots: context.scanRoots,
    selectedRepositoryId: selectedRepository?.id ?? null,
    remoteRetries: context.remoteRetries,
    error
  })
  const workspaceState: InitialWorkspaceState = {
    ...defaultInitialWorkspaceState,
    repository: repositoryState
  }

  return selectedRepository === undefined
    ? workspaceState
    : createSelectedRepositoryState(workspaceState, selectedRepository.id)
}

function updateRepositoryCreateState(
  workspaceState: InitialWorkspaceState,
  error: RepositoryCreateError
): InitialWorkspaceState {
  return {
    ...workspaceState,
    repository: {
      ...workspaceState.repository,
      create: {
        ...workspaceState.repository.create,
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

async function createFlowPaneState(
  repository: RepositoryRow,
  artifactRoot: string | undefined,
  flowStoreFactory: FlowStoreFactory
): Promise<Exclude<FlowPaneState, { status: 'loading' }>> {
  try {
    if (artifactRoot === undefined) {
      throw new Error('Flow artifact root is not configured.')
    }

    const store = await flowStoreFactory({
      artifactRoot
    })
    const flows = await store.listFlowsForRepository(repository)

    if (flows.length === 0) {
      return {
        status: 'empty',
        title: `No Flows for ${repository.name}`,
        description: `No Flow records were found for ${repository.path}.`,
        repositoryId: repository.id,
        repositoryName: repository.name
      }
    }

    return {
      status: 'ready',
      repositoryId: repository.id,
      repositoryName: repository.name,
      flows
    }
  } catch (error) {
    return {
      status: 'error',
      message: getErrorMessage(error),
      repositoryId: repository.id,
      repositoryName: repository.name
    }
  }
}

function firstDiagnosticMessage(diagnostics: CatalogDiagnostic[]): string {
  return diagnostics[0]?.message ?? 'Unable to load repository catalog.'
}

function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unable to load workspace state.'
}
