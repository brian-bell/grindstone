import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  handleTypedIpc,
  invokeTypedIpc,
  ipcChannels,
  normalizeIpcError,
  type IpcRequestMap,
  type IpcResponseMap
} from './ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from './config'
import { defaultInitialWorkspaceState, type InitialWorkspaceState } from './workspace'

const editableConfigState: EditableConfigState = {
  configPath: '/configs/grindstone.toml',
  scan_roots: ['/repos'],
  repos: ['/repos/grindstone'],
  default_agent: 'codex',
  artifact_root: './artifacts',
  bootstrap_hooks: [
    {
      command: 'npm install'
    }
  ]
}

describe('IPC contract', () => {
  it('pins the initial workspace channel name', () => {
    expect(ipcChannels.workspace.getInitialState).toBe('workspace:getInitialState')
    expect(ipcChannels.workspace.selectRepository).toBe('workspace:selectRepository')
    expect(ipcChannels.workspace.createFlow).toBe('workspace:createFlow')
    expect(ipcChannels.workspace.launchFlowPhase).toBe('workspace:launchFlowPhase')
    expect(ipcChannels.workspace.skipFlowPhase).toBe('workspace:skipFlowPhase')
    expect(ipcChannels.workspace.completeFlowPhase).toBe('workspace:completeFlowPhase')
    expect(ipcChannels.workspace.recordFlowPullRequest).toBe('workspace:recordFlowPullRequest')
    expect(ipcChannels.workspace.recordFlowHumanReview).toBe('workspace:recordFlowHumanReview')
    expect(ipcChannels.workspace.recordFlowMerge).toBe('workspace:recordFlowMerge')
    expect(ipcChannels.workspace.createRepository).toBe('workspace:createRepository')
    expect(ipcChannels.workspace.retryRepositoryRemote).toBe('workspace:retryRepositoryRemote')
    expect(ipcChannels.config.getEditableConfig).toBe('config:getEditableConfig')
    expect(ipcChannels.config.updateCommonConfig).toBe('config:updateCommonConfig')
  })

  it('maps workspace:getInitialState to an empty request and InitialWorkspaceState response', () => {
    type InitialWorkspaceChannel = typeof ipcChannels.workspace.getInitialState
    const request = undefined satisfies IpcRequestMap[InitialWorkspaceChannel]
    const response = defaultInitialWorkspaceState satisfies IpcResponseMap[InitialWorkspaceChannel]

    expect(request).toBeUndefined()
    expect(response).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(response).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps workspace:selectRepository to a repository id request and workspace response', () => {
    type SelectRepositoryChannel = typeof ipcChannels.workspace.selectRepository
    const request = {
      repositoryId: '/repos/example'
    } satisfies IpcRequestMap[SelectRepositoryChannel]
    const response = defaultInitialWorkspaceState satisfies IpcResponseMap[SelectRepositoryChannel]

    expect(request.repositoryId).toBe('/repos/example')
    expect(response).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(response).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps workspace:createRepository to scan-root scoped create input and workspace response', () => {
    type CreateRepositoryChannel = typeof ipcChannels.workspace.createRepository
    const request = {
      scanRootId: 'scan-root:0:abc123',
      name: 'new-repo',
      github: {
        enabled: true,
        visibility: 'private'
      }
    } satisfies IpcRequestMap[CreateRepositoryChannel]
    const response = defaultInitialWorkspaceState satisfies IpcResponseMap[CreateRepositoryChannel]

    expect(request.scanRootId).toBe('scan-root:0:abc123')
    expect(request.github.visibility).toBe('private')
    expect(response).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(response).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps workspace:createFlow to a typed Flow creation request and workspace response', () => {
    type CreateFlowChannel = typeof ipcChannels.workspace.createFlow
    const request = {
      title: 'Create Flow worktree',
      instructions: 'Build the end-to-end creation path.',
      baseRef: 'main'
    } satisfies IpcRequestMap[CreateFlowChannel]
    const response = defaultInitialWorkspaceState satisfies IpcResponseMap[CreateFlowChannel]

    expect(request.title).toBe('Create Flow worktree')
    expect(request.baseRef).toBe('main')
    expect(response).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(response).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps workspace phase actions to typed requests and workspace responses', () => {
    type LaunchFlowPhaseChannel = typeof ipcChannels.workspace.launchFlowPhase
    const launchRequest = {
      flowId: 'flow-one',
      phaseId: 'implementation'
    } satisfies IpcRequestMap[LaunchFlowPhaseChannel]
    const launchResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[LaunchFlowPhaseChannel]

    type SkipFlowPhaseChannel = typeof ipcChannels.workspace.skipFlowPhase
    const skipRequest = {
      flowId: 'flow-one',
      phaseId: 'implementation-ui',
      notes: 'Covered by another slice.'
    } satisfies IpcRequestMap[SkipFlowPhaseChannel]
    const skipResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[SkipFlowPhaseChannel]

    type CompleteFlowPhaseChannel = typeof ipcChannels.workspace.completeFlowPhase
    const completeRequest = {
      flowId: 'flow-one',
      phaseId: 'implementation',
      summary: 'Implementation complete.'
    } satisfies IpcRequestMap[CompleteFlowPhaseChannel]
    const completeResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[CompleteFlowPhaseChannel]

    type RecordFlowPullRequestChannel = typeof ipcChannels.workspace.recordFlowPullRequest
    const recordPrRequest = {
      flowId: 'flow-one',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/one',
        base: 'main',
        status: 'open'
      }
    } satisfies IpcRequestMap[RecordFlowPullRequestChannel]
    const recordPrResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[RecordFlowPullRequestChannel]

    type RecordFlowHumanReviewChannel = typeof ipcChannels.workspace.recordFlowHumanReview
    const recordReviewRequest = {
      flowId: 'flow-one',
      outcome: 'changes_requested',
      notes: 'Fix the review finding.'
    } satisfies IpcRequestMap[RecordFlowHumanReviewChannel]
    const recordReviewResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[RecordFlowHumanReviewChannel]

    type RecordFlowMergeChannel = typeof ipcChannels.workspace.recordFlowMerge
    const recordMergeRequest = {
      flowId: 'flow-one',
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12'
    } satisfies IpcRequestMap[RecordFlowMergeChannel]
    const recordMergeResponse = defaultInitialWorkspaceState satisfies IpcResponseMap[RecordFlowMergeChannel]

    expect(launchRequest.phaseId).toBe('implementation')
    expect(skipRequest.notes).toBe('Covered by another slice.')
    expect(completeRequest.summary).toBe('Implementation complete.')
    expect(recordPrRequest.pr.number).toBe(12)
    expect(recordReviewRequest.notes).toBe('Fix the review finding.')
    expect(recordMergeRequest.commit).toBe('abcdef1234567890abcdef1234567890abcdef12')
    expect(launchResponse).toEqual(defaultInitialWorkspaceState)
    expect(skipResponse).toEqual(defaultInitialWorkspaceState)
    expect(completeResponse).toEqual(defaultInitialWorkspaceState)
    expect(recordPrResponse).toEqual(defaultInitialWorkspaceState)
    expect(recordReviewResponse).toEqual(defaultInitialWorkspaceState)
    expect(recordMergeResponse).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(launchResponse).toEqualTypeOf<InitialWorkspaceState>()
    expectTypeOf(skipResponse).toEqualTypeOf<InitialWorkspaceState>()
    expectTypeOf(completeResponse).toEqualTypeOf<InitialWorkspaceState>()
    expectTypeOf(recordPrResponse).toEqualTypeOf<InitialWorkspaceState>()
    expectTypeOf(recordReviewResponse).toEqualTypeOf<InitialWorkspaceState>()
    expectTypeOf(recordMergeResponse).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps workspace:retryRepositoryRemote to a stable retry id request and workspace response', () => {
    type RetryRepositoryRemoteChannel = typeof ipcChannels.workspace.retryRepositoryRemote
    const request = {
      retryId: 'remote-retry:/repos/new-repo'
    } satisfies IpcRequestMap[RetryRepositoryRemoteChannel]
    const response = defaultInitialWorkspaceState satisfies IpcResponseMap[RetryRepositoryRemoteChannel]

    expect(request.retryId).toBe('remote-retry:/repos/new-repo')
    expect(response).toEqual(defaultInitialWorkspaceState)
    expectTypeOf(response).toEqualTypeOf<InitialWorkspaceState>()
  })

  it('maps config channels to editable config request and response types', () => {
    type GetEditableConfigChannel = typeof ipcChannels.config.getEditableConfig
    const getRequest = undefined satisfies IpcRequestMap[GetEditableConfigChannel]
    const getResponse: IpcResponseMap[GetEditableConfigChannel] = editableConfigState

    type UpdateCommonConfigChannel = typeof ipcChannels.config.updateCommonConfig
    const updateRequest: IpcRequestMap[UpdateCommonConfigChannel] = {
      scan_roots: ['/repos'],
      repos: ['/repos/grindstone'],
      default_agent: 'claude',
      artifact_root: null,
      bootstrap_hooks: []
    }
    const updateResponse: IpcResponseMap[UpdateCommonConfigChannel] = {
      ok: true,
      workspace: defaultInitialWorkspaceState,
      config: editableConfigState
    }

    expect(getRequest).toBeUndefined()
    expect(getResponse).toEqual(editableConfigState)
    expect(updateRequest.default_agent).toBe('claude')
    expect(updateResponse.ok).toBe(true)
    expectTypeOf(getResponse).toEqualTypeOf<EditableConfigState>()
    expectTypeOf<IpcRequestMap[UpdateCommonConfigChannel]>()
      .toEqualTypeOf<CommonConfigUpdateInput>()
    expectTypeOf<IpcResponseMap[UpdateCommonConfigChannel]>()
      .toEqualTypeOf<ConfigUpdateResponse>()
  })

  it('invokes IPC through the typed request and response map', async () => {
    const invoke = vi.fn().mockResolvedValue(defaultInitialWorkspaceState)

    await expect(
      invokeTypedIpc(invoke, ipcChannels.workspace.getInitialState, undefined)
    ).resolves.toEqual(defaultInitialWorkspaceState)

    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.getInitialState)

    await expect(
      invokeTypedIpc(invoke, ipcChannels.workspace.selectRepository, {
        repositoryId: '/repos/example'
      })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.selectRepository, {
      repositoryId: '/repos/example'
    })

    await expect(
      invokeTypedIpc(invoke, ipcChannels.workspace.createFlow, {
        title: 'Create Flow worktree',
        instructions: 'Build the end-to-end creation path.'
      })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.createFlow, {
      title: 'Create Flow worktree',
      instructions: 'Build the end-to-end creation path.'
    })

    await expect(
      invokeTypedIpc(invoke, ipcChannels.workspace.launchFlowPhase, {
        flowId: 'flow-one',
        phaseId: 'implementation'
      })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.launchFlowPhase, {
      flowId: 'flow-one',
      phaseId: 'implementation'
    })

    await expect(
      invokeTypedIpc(invoke, ipcChannels.workspace.createRepository, {
        scanRootId: 'scan-root:0:abc123',
        name: 'new-repo',
        github: {
          enabled: false,
          visibility: 'public'
        }
      })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.createRepository, {
      scanRootId: 'scan-root:0:abc123',
      name: 'new-repo',
      github: {
        enabled: false,
        visibility: 'public'
      }
    })

    invoke.mockResolvedValue(editableConfigState)
    await expect(
      invokeTypedIpc(invoke, ipcChannels.config.getEditableConfig, undefined)
    ).resolves.toEqual(editableConfigState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.config.getEditableConfig)
  })

  it('registers IPC handlers through the typed request and response map', async () => {
    const ipcMain = {
      handle: vi.fn()
    }

    handleTypedIpc(ipcMain, ipcChannels.workspace.getInitialState, () => {
      return defaultInitialWorkspaceState
    })

    const handler = ipcMain.handle.mock.calls[0]?.[1] as (
      event: unknown,
      request: undefined
    ) => Promise<InitialWorkspaceState>

    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.getInitialState,
      expect.any(Function)
    )
    await expect(handler({}, undefined)).resolves.toEqual(defaultInitialWorkspaceState)
  })

  it('normalizes rejected IPC errors to a stable renderer-safe shape', () => {
    expect(normalizeIpcError(new Error('handler failed'))).toEqual({
      name: 'Error',
      message: 'handler failed'
    })

    expect(normalizeIpcError('bad result')).toEqual({
      name: 'Error',
      message: 'bad result'
    })
  })
})
