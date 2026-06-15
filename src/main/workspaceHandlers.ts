import type { IpcMain } from 'electron'
import { createHash } from 'node:crypto'
import { handleTypedIpc, ipcChannels } from '@shared/ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse } from '@shared/config'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import {
  defaultInitialWorkspaceState,
  type CatalogDiagnostic,
  type CompleteFlowPhaseRequest,
  type CreateFlowRequest,
  type CreateRepositoryRequest,
  type FlowCreateError,
  type FlowListRow,
  type FlowPaneState,
  type FlowPhaseSummary,
  type InitialWorkspaceState,
  type LaunchFlowPhaseRequest,
  type RepositoryCreateError,
  type RepositoryPaneState,
  type RepositoryRow,
  type SkipFlowPhaseRequest,
  type UpdateFlowPhaseRequest
} from '@shared/workspace'
import {
  getEditableConfig,
  loadGrindstoneConfig,
  updateCommonConfigFile,
  type ConfiguredPath,
  type GrindstoneConfigResult,
  type LoadGrindstoneConfigOptions
} from './config'
import { createFlow, type FlowCommandRunner, type LaunchPreparer } from './flowCreation'
import { createFlowStore, type CreateFlowStoreOptions, type FlowStore } from './flowStore'
import { ArtifactStoreError } from './artifactStore'
import {
  createFlowPhaseLaunchId,
  createFlowPhaseLaunchRecord,
  noopFlowPhaseRunner,
  type FlowPhaseLaunchContext,
  type FlowPhaseRunner
} from './flowPhaseActions'
import { createFlowOperations } from './flowOperations'
import { createPlanStore } from './planStore'
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
  bootstrapHooks: GrindstoneConfigResult['bootstrapHooks']
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
      remoteRetries: [],
      bootstrapHooks: []
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
  const remoteRetries = preserveRemoteRetries(
    currentWorkspaceContext?.remoteRetries ?? [],
    catalog
  )
  currentWorkspaceContext = {
    catalogInput: {
      scanRoots: config.scanRoots,
      repos: config.repos
    },
    scanRoots,
    catalog,
    remoteRetries,
    bootstrapHooks: config.bootstrapHooks
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

export async function readLinkedFlowPlan(request: { flowId: string }): Promise<LinkedFlowPlanResponse> {
  if (currentArtifactRoot === undefined) {
    return {
      status: 'missing',
      flowId: request.flowId,
      message: 'Flow artifact root is not configured.'
    }
  }

  const workspaceState = currentWorkspaceState ?? (await loadInitialWorkspaceState())
  if (workspaceState.flow.status !== 'ready') {
    return {
      status: 'missing',
      flowId: request.flowId,
      message: 'Select a repository before reading a linked Flow plan.'
    }
  }

  const flow = workspaceState.flow.flows.find((candidate) => candidate.id === request.flowId)
  if (flow === undefined) {
    return {
      status: 'missing',
      flowId: request.flowId,
      message: `Flow is not selected in this workspace: ${request.flowId}`
    }
  }
  if (flow.planId === undefined) {
    return {
      status: 'missing',
      flowId: request.flowId,
      message: `Flow has no linked plan: ${request.flowId}`
    }
  }

  try {
    const plan = await createPlanStore({ artifactRoot: currentArtifactRoot }).readPlan(flow.planId)
    return {
      status: 'ready',
      metadata: plan.metadata,
      body: plan.body
    }
  } catch (error) {
    const status = error instanceof ArtifactStoreError && error.code === 'corrupt_artifact'
      ? 'corrupt'
      : 'missing'
    return {
      status,
      flowId: request.flowId,
      planId: flow.planId,
      message: error instanceof Error ? error.message : 'Plan artifact could not be read.'
    }
  }
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

export async function createFlowInWorkspace(
  request: CreateFlowRequest,
  options: {
    runCommand?: FlowCommandRunner
    prepareLaunch?: LaunchPreparer
  } = {}
): Promise<InitialWorkspaceState> {
  const context = await getWorkspaceContext()
  const workspaceState = currentWorkspaceState ?? (await loadInitialWorkspaceState())
  const selectedRepositoryId = workspaceState.repository.selectedRepositoryId
  const selectedRepository = context.catalog.repositories.find(
    (repository) => repository.id === selectedRepositoryId
  )

  if (selectedRepository === undefined) {
    currentWorkspaceState = updateFlowCreateState(workspaceState, {
      code: 'repository_unavailable',
      message: 'Select a repository before creating a Flow.'
    })
    return currentWorkspaceState
  }

  const requestId = currentSelectionRequestId + 1
  currentSelectionRequestId = requestId
  const store = await currentFlowStoreFactory({
    artifactRoot: currentArtifactRoot ?? ''
  })
  const result = await createFlow({
    repository: selectedRepository,
    artifactRoot: currentArtifactRoot,
    bootstrapHooks: context.bootstrapHooks,
    request,
    store,
    runCommand: options.runCommand,
    prepareLaunch: options.prepareLaunch
  })

  if (requestId !== currentSelectionRequestId || workspaceState !== currentWorkspaceState) {
    return currentWorkspaceState ?? workspaceState
  }

  const refreshedWorkspace = await createWorkspaceStateFromContext(
    context,
    selectedRepository.id,
    null
  )
  currentWorkspaceState = result.ok
    ? refreshedWorkspace
    : updateFlowCreateState(refreshedWorkspace, result.error)
  return currentWorkspaceState
}

export async function updateFlowPhaseInWorkspace(
  request: UpdateFlowPhaseRequest
): Promise<InitialWorkspaceState> {
  if (currentArtifactRoot === undefined) {
    throw new Error('Flow artifact root is not configured.')
  }
  if (
    !isUpdateFlowPhaseRequest(request)
  ) {
    throw new Error('Update Flow phase request is invalid.')
  }

  const workspaceState = currentWorkspaceState ?? (await loadInitialWorkspaceState())
  if (workspaceState.flow.status !== 'ready') {
    throw new Error('Select a repository before editing a Flow phase.')
  }
  if (!workspaceState.flow.flows.some((flow) => flow.id === request.flowId)) {
    throw new Error(`Flow is not selected in this workspace: ${request.flowId}`)
  }

  await createFlowOperations({ artifactRoot: currentArtifactRoot }).updatePhase(request)
  const refreshedWorkspace = await createWorkspaceStateFromContext(
    await getWorkspaceContext(),
    workspaceState.flow.repositoryId,
    null
  )
  currentWorkspaceState = refreshedWorkspace
  return refreshedWorkspace
}

export async function launchFlowPhaseInWorkspace(
  request: LaunchFlowPhaseRequest,
  options: { runPhase?: FlowPhaseRunner } = {}
): Promise<InitialWorkspaceState> {
  const { flow, phase, workspaceState } = await getSelectedPhaseForAction(
    request,
    'launch'
  )
  if (!isLaunchableImplementationPhase(phase)) {
    throw new Error(`Phase cannot be launched from this workspace: ${phase.id}`)
  }
  if (phase.status !== 'ready' && phase.status !== 'needs_attention') {
    throw new Error(`Phase is not ready to launch: ${phase.id}`)
  }

  const requestId = currentSelectionRequestId + 1
  currentSelectionRequestId = requestId
  const flowOperations = createFlowOperations({ artifactRoot: currentArtifactRoot as string })
  const launchContext = createFlowPhaseLaunchContext({
    artifactRoot: currentArtifactRoot as string,
    flow,
    phase,
    launchId: createFlowPhaseLaunchId()
  })
  await createFlowPhaseLaunchRecord(launchContext)
  await flowOperations.setPhase({
    flowId: request.flowId,
    phaseId: request.phaseId,
    status: 'running',
    notes: phase.status === 'needs_attention' ? 'Retrying phase launch.' : undefined,
    launchId: launchContext.launchId
  })

  try {
    await (options.runPhase ?? noopFlowPhaseRunner)(launchContext)
  } catch (error) {
    try {
      await flowOperations.needsAttentionPhase({
        flowId: request.flowId,
        phaseId: request.phaseId,
        notes: `Phase launch failed: ${getErrorMessage(error)}`,
        launchId: launchContext.launchId
      })
    } catch (markError) {
      await refreshSelectedRepositoryWorkspaceIfCurrent(workspaceState, requestId)
      throw markError
    }
    return refreshSelectedRepositoryWorkspaceIfCurrent(workspaceState, requestId)
  }

  return refreshSelectedRepositoryWorkspaceIfCurrent(workspaceState, requestId)
}

export async function skipFlowPhaseInWorkspace(
  request: SkipFlowPhaseRequest
): Promise<InitialWorkspaceState> {
  const { phase, workspaceState } = await getSelectedPhaseForAction(request, 'skip')
  if (!isSkippableImplementationChildPhase(phase)) {
    throw new Error(`Phase cannot be skipped from this workspace: ${phase.id}`)
  }
  if (typeof request.notes !== 'string') {
    throw new Error('Flow phase skip request is invalid.')
  }
  if (request.notes.trim() === '') {
    throw new Error('Skipping a phase requires notes.')
  }

  await createFlowOperations({ artifactRoot: currentArtifactRoot as string }).setPhase({
    flowId: request.flowId,
    phaseId: request.phaseId,
    status: 'skipped',
    notes: request.notes
  })
  return refreshSelectedRepositoryWorkspace(workspaceState)
}

export async function completeFlowPhaseInWorkspace(
  request: CompleteFlowPhaseRequest
): Promise<InitialWorkspaceState> {
  if (!isCompleteFlowPhaseRequest(request)) {
    throw new Error('Complete Flow phase request is invalid.')
  }
  const { phase, workspaceState } = await getSelectedPhaseForAction(
    request,
    'complete'
  )
  if (!isLaunchableImplementationPhase(phase)) {
    throw new Error(`Phase cannot be completed from this workspace: ${phase.id}`)
  }
  if (phase.status !== 'running') {
    throw new Error(`Phase is not running: ${phase.id}`)
  }

  await createFlowOperations({ artifactRoot: currentArtifactRoot as string }).completePhase({
    flowId: request.flowId,
    phaseId: request.phaseId,
    outcome: 'implemented',
    summary: request.summary
  })
  return refreshSelectedRepositoryWorkspace(workspaceState)
}

async function getSelectedPhaseForAction(
  request: { flowId: string; phaseId: string },
  actionName: string
): Promise<{
  flow: FlowListRow
  phase: FlowPhaseSummary
  workspaceState: InitialWorkspaceState
}> {
  if (currentArtifactRoot === undefined) {
    throw new Error('Flow artifact root is not configured.')
  }
  if (!isFlowPhaseActionRequest(request)) {
    throw new Error(`Flow phase ${actionName} request is invalid.`)
  }

  const workspaceState = currentWorkspaceState ?? (await loadInitialWorkspaceState())
  if (workspaceState.flow.status !== 'ready') {
    throw new Error(`Select a repository before ${actionName}ing a Flow phase.`)
  }

  const flow = workspaceState.flow.flows.find((candidate) => candidate.id === request.flowId)
  if (flow === undefined) {
    throw new Error(`Flow is not selected in this workspace: ${request.flowId}`)
  }

  const phase = flow.phases?.find((candidate) => candidate.id === request.phaseId)
  if (phase === undefined) {
    throw new Error(`Flow phase is not selected in this workspace: ${request.phaseId}`)
  }

  return { flow, phase, workspaceState }
}

function isFlowPhaseActionRequest(
  request: unknown
): request is { flowId: string; phaseId: string } {
  return typeof request === 'object' &&
    request !== null &&
    typeof (request as { flowId?: unknown }).flowId === 'string' &&
    (request as { flowId: string }).flowId.trim() !== '' &&
    typeof (request as { phaseId?: unknown }).phaseId === 'string' &&
    (request as { phaseId: string }).phaseId.trim() !== ''
}

function isLaunchableImplementationPhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'implementation' || isImplementationChildPhase(phase)
}

function isSkippableImplementationChildPhase(phase: FlowPhaseSummary): boolean {
  return isImplementationChildPhase(phase)
}

function isImplementationChildPhase(phase: FlowPhaseSummary): boolean {
  return phase.parentPhaseId === 'implementation' &&
    (phase.kind === 'implementation_child' || (phase.generated === true && phase.editable === true))
}

function createFlowPhaseLaunchContext({
  artifactRoot,
  flow,
  phase,
  launchId
}: {
  artifactRoot: string
  flow: FlowListRow
  phase: FlowPhaseSummary
  launchId: string
}): FlowPhaseLaunchContext {
  return {
    artifactRoot,
    launchId,
    flowId: flow.id,
    phaseId: phase.id,
    phaseTitle: phase.title,
    phaseKind: phase.kind,
    repositoryPath: flow.repositoryPath,
    worktreePath: flow.worktreePath,
    branch: flow.branch,
    commit: flow.commit,
    planId: flow.planId,
    planPath: flow.planPath
  }
}

async function refreshSelectedRepositoryWorkspace(
  workspaceState: InitialWorkspaceState
): Promise<InitialWorkspaceState> {
  const refreshedWorkspace = await createWorkspaceStateFromContext(
    await getWorkspaceContext(),
    workspaceState.flow.status === 'ready'
      ? workspaceState.flow.repositoryId
      : workspaceState.repository.selectedRepositoryId,
    null
  )
  currentWorkspaceState = refreshedWorkspace
  return refreshedWorkspace
}

async function refreshSelectedRepositoryWorkspaceIfCurrent(
  workspaceState: InitialWorkspaceState,
  requestId: number
): Promise<InitialWorkspaceState> {
  if (requestId !== currentSelectionRequestId || workspaceState !== currentWorkspaceState) {
    return currentWorkspaceState ?? workspaceState
  }
  return refreshSelectedRepositoryWorkspace(workspaceState)
}

function isUpdateFlowPhaseRequest(request: unknown): request is UpdateFlowPhaseRequest {
  return typeof request === 'object' &&
    request !== null &&
    typeof (request as { flowId?: unknown }).flowId === 'string' &&
    typeof (request as { phaseId?: unknown }).phaseId === 'string' &&
    optionalStringField((request as { title?: unknown }).title) &&
    optionalNumberField((request as { order?: unknown }).order) &&
    optionalStringField((request as { notes?: unknown }).notes)
}

function isCompleteFlowPhaseRequest(request: unknown): request is CompleteFlowPhaseRequest {
  return isFlowPhaseActionRequest(request) &&
    optionalStringField((request as { summary?: unknown }).summary)
}

function optionalStringField(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalNumberField(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value))
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

  const flow = await createFlowPaneState(repository, currentArtifactRoot, currentFlowStoreFactory)
  const canCreateFlow = (flow.status === 'ready' || flow.status === 'empty') &&
    flow.create?.available === true

  return {
    ...workspaceState,
    repository: {
      ...workspaceState.repository,
      title: repository.name,
      description: repository.path,
      selectedRepositoryId: repository.id
    },
    flow,
    shortcuts: workspaceState.shortcuts.map((shortcut) =>
      shortcut.id === 'new-flow'
        ? { ...shortcut, disabled: !canCreateFlow }
        : shortcut
    )
  }
}

export function registerWorkspaceHandlers(ipcMain: Pick<IpcMain, 'handle'>): void {
  handleTypedIpc(ipcMain, ipcChannels.workspace.getInitialState, () =>
    loadInitialWorkspaceState()
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.selectRepository, (request) =>
    selectRepository(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.readFlowPlan, (request) =>
    readLinkedFlowPlan(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.createFlow, (request) =>
    createFlowInWorkspace(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.updateFlowPhase, (request) =>
    updateFlowPhaseInWorkspace(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.launchFlowPhase, (request) =>
    launchFlowPhaseInWorkspace(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.skipFlowPhase, (request) =>
    skipFlowPhaseInWorkspace(request)
  )
  handleTypedIpc(ipcMain, ipcChannels.workspace.completeFlowPhase, (request) =>
    completeFlowPhaseInWorkspace(request)
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

function updateFlowCreateState(
  workspaceState: InitialWorkspaceState,
  error: FlowCreateError
): InitialWorkspaceState {
  if (workspaceState.flow.status !== 'ready' && workspaceState.flow.status !== 'empty') {
    return workspaceState
  }

  return {
    ...workspaceState,
    flow: {
      ...workspaceState.flow,
      create: {
        available: workspaceState.flow.create?.available ?? true,
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

function preserveRemoteRetries(
  retries: RepositoryPaneState['create']['remoteRetries'],
  catalog: RepositoryCatalogResult
): RepositoryPaneState['create']['remoteRetries'] {
  return retries.filter((retry) =>
    catalog.repositories.some(
      (repository) =>
        repository.id === retry.repositoryId &&
        repository.canonicalPath === retry.repositoryPath
    )
  )
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
        repositoryName: repository.name,
        create: {
          available: true,
          error: null
        }
      }
    }

    return {
      status: 'ready',
      repositoryId: repository.id,
      repositoryName: repository.name,
      flows,
      create: {
        available: true,
        error: null
      }
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
