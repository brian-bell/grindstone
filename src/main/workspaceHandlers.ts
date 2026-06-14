import type { IpcMain } from 'electron'
import { handleTypedIpc, ipcChannels } from '@shared/ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse } from '@shared/config'
import {
  defaultInitialWorkspaceState,
  type CatalogDiagnostic,
  type InitialWorkspaceState,
  type RepositoryPaneState
} from '@shared/workspace'
import {
  getEditableConfig,
  loadGrindstoneConfig,
  updateCommonConfigFile,
  type LoadGrindstoneConfigOptions
} from './config'
import { scanRepositoryCatalog, type RepositoryCatalogResult } from './repositoryCatalog'

let currentWorkspaceState: InitialWorkspaceState | undefined

export async function loadInitialWorkspaceState(
  options: LoadGrindstoneConfigOptions = {}
): Promise<InitialWorkspaceState> {
  currentWorkspaceState = await buildWorkspaceState(options)
  return currentWorkspaceState
}

async function buildWorkspaceState(
  options: LoadGrindstoneConfigOptions = {},
  selectedRepositoryId: string | null = null
): Promise<InitialWorkspaceState> {
  const config = await loadGrindstoneConfig(options)

  if (!config.ok) {
    return {
      ...defaultInitialWorkspaceState,
      repository: createRepositoryErrorState(config.diagnostics)
    }
  }

  const catalog = await scanRepositoryCatalog({
    scanRoots: config.scanRoots,
    repos: config.repos
  })

  const workspaceState: InitialWorkspaceState = {
    ...defaultInitialWorkspaceState,
    repository: createRepositoryReadyState(catalog)
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

  currentWorkspaceState = createSelectedRepositoryState(workspaceState, repository.id)
  return currentWorkspaceState
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

function createSelectedRepositoryState(
  workspaceState: InitialWorkspaceState,
  repositoryId: string
): InitialWorkspaceState {
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
    flow: {
      status: 'empty',
      title: `${repository.name} Flow workspace`,
      description: `Flow context is scoped to ${repository.path}.`
    }
  }
}

export function registerWorkspaceHandlers(ipcMain: Pick<IpcMain, 'handle'>): void {
  handleTypedIpc(ipcMain, ipcChannels.workspace.getInitialState, () =>
    loadInitialWorkspaceState()
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.selectRepository, (request) =>
    selectRepository(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.config.getEditableConfig, () =>
    getCurrentEditableConfig()
  )
  handleTypedIpc(ipcMain, ipcChannels.config.updateCommonConfig, (request) =>
    updateCommonConfig(request)
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

  return 'Unable to reload Grindstone config.'
}
