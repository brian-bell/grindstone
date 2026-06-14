import type { IpcMain } from 'electron'
import { handleTypedIpc, ipcChannels } from '@shared/ipc'
import {
  defaultInitialWorkspaceState,
  type CatalogDiagnostic,
  type FlowPaneState,
  type InitialWorkspaceState,
  type RepositoryPaneState,
  type RepositoryRow
} from '@shared/workspace'
import {
  loadGrindstoneConfig,
  type GrindstoneConfigResult,
  type LoadGrindstoneConfigOptions
} from './config'
import { createFlowStore, type CreateFlowStoreOptions, type FlowStore } from './flowStore'
import { scanRepositoryCatalog, type RepositoryCatalogResult } from './repositoryCatalog'

type FlowStoreFactory = (options: CreateFlowStoreOptions) => Promise<FlowStore>
type ConfigLoader = (options: LoadGrindstoneConfigOptions) => Promise<GrindstoneConfigResult>

export type LoadWorkspaceStateOptions = LoadGrindstoneConfigOptions & {
  configLoader?: ConfigLoader
  flowStoreFactory?: FlowStoreFactory
}

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
  const config = await configLoader(configOptions)
  currentArtifactRoot = config.artifactRoot.resolvedPath
  currentFlowStoreFactory = flowStoreFactory

  if (!config.ok) {
    currentWorkspaceState = {
      ...defaultInitialWorkspaceState,
      repository: createRepositoryErrorState(config.diagnostics)
    }
    return currentWorkspaceState
  }

  const catalog = await scanRepositoryCatalog({
    scanRoots: config.scanRoots,
    repos: config.repos
  })

  currentWorkspaceState = {
    ...defaultInitialWorkspaceState,
    repository: createRepositoryReadyState(catalog)
  }
  return currentWorkspaceState
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

  const nextWorkspaceState: InitialWorkspaceState = {
    ...workspaceState,
    repository: {
      ...workspaceState.repository,
      title: repository.name,
      description: repository.path,
      selectedRepositoryId: repository.id
    },
    flow: await createFlowPaneState(repository, currentArtifactRoot, currentFlowStoreFactory)
  }

  if (requestId !== currentSelectionRequestId || workspaceState !== currentWorkspaceState) {
    return currentWorkspaceState ?? nextWorkspaceState
  }

  currentWorkspaceState = nextWorkspaceState
  return nextWorkspaceState
}

export function registerWorkspaceHandlers(ipcMain: Pick<IpcMain, 'handle'>): void {
  handleTypedIpc(ipcMain, ipcChannels.workspace.getInitialState, () =>
    loadInitialWorkspaceState()
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.selectRepository, (request) =>
    selectRepository(request)
  )
}

function createRepositoryReadyState(catalog: RepositoryCatalogResult): RepositoryPaneState {
  const repositoryCount = catalog.repositories.length

  return {
    status: 'ready',
    title: repositoryCount === 0 ? 'No repositories configured' : 'Repository catalog',
    description:
      repositoryCount === 0
        ? 'Add scan_roots or repos to Grindstone config to populate this pane.'
        : `${repositoryCount} ${pluralize('repository', repositoryCount)} configured.`,
    repositories: catalog.repositories,
    selectedRepositoryId: null,
    diagnostics: catalog.diagnostics
  }
}

function createRepositoryErrorState(diagnostics: CatalogDiagnostic[]): RepositoryPaneState {
  return {
    status: 'error',
    title: 'Repository catalog unavailable',
    description: firstDiagnosticMessage(diagnostics),
    repositories: [],
    selectedRepositoryId: null,
    diagnostics
  }
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

  return 'Unable to load Flow artifacts.'
}
