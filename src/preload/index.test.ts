import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels, type NormalizedIpcError } from '@shared/ipc'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import {
  defaultInitialWorkspaceState,
  type CompleteFlowPhaseRequest,
  type CreateFlowRequest,
  type CreateRepositoryRequest,
  type FlowTerminalSummary,
  type InitialWorkspaceState,
  type LaunchFlowPhaseRequest,
  type RecordFlowHumanReviewRequest,
  type RecordFlowMergeRequest,
  type RecordFlowPullRequestRequest,
  type RetryRepositoryRemoteRequest,
  type SkipFlowPhaseRequest,
  type TerminalActionRequest,
  type TerminalEvent,
  type TerminalEventSubscriptionRequest,
  type TerminalInputRequest,
  type TerminalListRequest,
  type TerminalResizeRequest,
  type UpdateFlowPhaseRequest
} from '@shared/workspace'

type PreloadApi = {
  workspace: {
    getInitialState: () => Promise<InitialWorkspaceState>
    selectRepository: (request: { repositoryId: string }) => Promise<InitialWorkspaceState>
    readFlowPlan: (request: { flowId: string }) => Promise<LinkedFlowPlanResponse>
    createFlow: (request: CreateFlowRequest) => Promise<InitialWorkspaceState>
    updateFlowPhase: (request: UpdateFlowPhaseRequest) => Promise<InitialWorkspaceState>
    launchFlowPhase: (request: LaunchFlowPhaseRequest) => Promise<InitialWorkspaceState>
    skipFlowPhase: (request: SkipFlowPhaseRequest) => Promise<InitialWorkspaceState>
    completeFlowPhase: (request: CompleteFlowPhaseRequest) => Promise<InitialWorkspaceState>
    recordFlowPullRequest: (request: RecordFlowPullRequestRequest) => Promise<InitialWorkspaceState>
    recordFlowHumanReview: (request: RecordFlowHumanReviewRequest) => Promise<InitialWorkspaceState>
    recordFlowMerge: (request: RecordFlowMergeRequest) => Promise<InitialWorkspaceState>
    createRepository: (request: CreateRepositoryRequest) => Promise<InitialWorkspaceState>
    retryRepositoryRemote: (
      request: RetryRepositoryRemoteRequest
    ) => Promise<InitialWorkspaceState>
    listTerminals: (request: TerminalListRequest) => Promise<FlowTerminalSummary[]>
    writeTerminalInput: (request: TerminalInputRequest) => Promise<FlowTerminalSummary>
    resizeTerminal: (request: TerminalResizeRequest) => Promise<FlowTerminalSummary>
    terminateTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
    dismissTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
    onTerminalEvent: (
      request: TerminalEventSubscriptionRequest,
      handler: (event: TerminalEvent) => void
    ) => () => void
  }
  config: {
    getEditableConfig: () => Promise<EditableConfigState>
    updateCommonConfig: (input: CommonConfigUpdateInput) => Promise<ConfigUpdateResponse>
  }
}

const editableConfigState: EditableConfigState = {
  configPath: '/configs/grindstone.toml',
  scan_roots: ['/repos'],
  repos: ['/repos/grindstone'],
  default_agent: 'codex',
  artifact_root: './artifacts',
  bootstrap_hooks: []
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function loadPreload(): Promise<{
  exposeInMainWorld: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  api: PreloadApi
}> {
  const exposeInMainWorld = vi.fn()
  const invoke = vi.fn()
  const on = vi.fn()
  const removeListener = vi.fn()

  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke, on, removeListener }
  }))

  await import('./index')

  return {
    exposeInMainWorld,
    invoke,
    on,
    removeListener,
    api: exposeInMainWorld.mock.calls[0]?.[1] as PreloadApi
  }
}

describe('preload bridge', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('electron')
  })

  it('exposes only the narrow Grindstone workspace API', async () => {
    const { exposeInMainWorld, api } = await loadPreload()

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld).toHaveBeenCalledWith('grindstone', expect.any(Object))
    expect(Object.keys(api)).toEqual(['workspace', 'config'])
    expect(Object.keys(api.workspace)).toEqual([
      'getInitialState',
      'selectRepository',
      'readFlowPlan',
      'createFlow',
      'updateFlowPhase',
      'launchFlowPhase',
      'skipFlowPhase',
      'completeFlowPhase',
      'recordFlowPullRequest',
      'recordFlowHumanReview',
      'recordFlowMerge',
      'createRepository',
      'retryRepositoryRemote',
      'listTerminals',
      'writeTerminalInput',
      'resizeTerminal',
      'terminateTerminal',
      'dismissTerminal',
      'onTerminalEvent'
    ])
    expect(Object.keys(api.config)).toEqual(['getEditableConfig', 'updateCommonConfig'])
    expect('process' in api).toBe(false)
    expect('fs' in api).toBe(false)
  })

  it('invokes the shared initial workspace channel and returns the typed response', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)

    await expect(api.workspace.getInitialState()).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.getInitialState)
  })

  it('invokes repository selection through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)

    await expect(
      api.workspace.selectRepository({ repositoryId: '/repos/example' })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.selectRepository, {
      repositoryId: '/repos/example'
    })
  })

  it('invokes linked Flow plan reads through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    const response: LinkedFlowPlanResponse = {
      status: 'ready',
      metadata: {
        schema_version: 1,
        plan_id: 'plan-one',
        title: 'Plan One',
        status: 'approved',
        plan_path: '/artifacts/plans/plan-one/plan.md',
        created_at: '2026-06-15T10:00:00.000Z',
        updated_at: '2026-06-15T10:00:00.000Z'
      },
      body: '# Plan\n'
    }
    invoke.mockResolvedValue(response)

    await expect(api.workspace.readFlowPlan({ flowId: 'flow-one' })).resolves.toEqual(response)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.readFlowPlan, {
      flowId: 'flow-one'
    })
  })

  it('invokes config loading through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(editableConfigState)

    await expect(api.config.getEditableConfig()).resolves.toEqual(editableConfigState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.config.getEditableConfig)
  })

  it('invokes repository creation through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)
    const request: CreateRepositoryRequest = {
      scanRootId: 'scan-root:0:test',
      name: 'new-repo',
      github: {
        enabled: true,
        visibility: 'private'
      }
    }

    await expect(api.workspace.createRepository(request)).resolves.toEqual(
      defaultInitialWorkspaceState
    )
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.createRepository, request)
  })

  it('invokes Flow creation through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)
    const request: CreateFlowRequest = {
      title: 'Create Flow worktree',
      instructions: 'Build the end-to-end path.',
      baseRef: 'main'
    }

    await expect(api.workspace.createFlow(request)).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.createFlow, request)
  })

  it('invokes Flow phase updates through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)
    const request: UpdateFlowPhaseRequest = {
      flowId: 'flow-one',
      phaseId: 'implementation-first-slice',
      title: 'Edited slice',
      order: 2,
      notes: 'Keep the edit.'
    }

    await expect(api.workspace.updateFlowPhase(request)).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.updateFlowPhase, request)
  })

  it('invokes Flow phase actions through the shared channels', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)

    await expect(api.workspace.launchFlowPhase({
      flowId: 'flow-one',
      phaseId: 'implementation'
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.launchFlowPhase, {
      flowId: 'flow-one',
      phaseId: 'implementation'
    })

    await expect(api.workspace.skipFlowPhase({
      flowId: 'flow-one',
      phaseId: 'implementation-ui',
      notes: 'Covered elsewhere.'
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.skipFlowPhase, {
      flowId: 'flow-one',
      phaseId: 'implementation-ui',
      notes: 'Covered elsewhere.'
    })

    await expect(api.workspace.completeFlowPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      summary: 'Implemented.'
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.completeFlowPhase, {
      flowId: 'flow-one',
      phaseId: 'implementation',
      summary: 'Implemented.'
    })

    await expect(api.workspace.recordFlowPullRequest({
      flowId: 'flow-one',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/one',
        base: 'main',
        status: 'open'
      }
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.recordFlowPullRequest, {
      flowId: 'flow-one',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/one',
        base: 'main',
        status: 'open'
      }
    })

    await expect(api.workspace.recordFlowHumanReview({
      flowId: 'flow-one',
      outcome: 'approved',
      notes: 'Looks good.'
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.recordFlowHumanReview, {
      flowId: 'flow-one',
      outcome: 'approved',
      notes: 'Looks good.'
    })

    await expect(api.workspace.recordFlowMerge({
      flowId: 'flow-one',
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12'
    })).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.recordFlowMerge, {
      flowId: 'flow-one',
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12'
    })
  })

  it('invokes remote retry through the shared channel', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockResolvedValue(defaultInitialWorkspaceState)

    await expect(
      api.workspace.retryRepositoryRemote({ retryId: 'remote-retry:/repos/new-repo' })
    ).resolves.toEqual(defaultInitialWorkspaceState)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.retryRepositoryRemote, {
      retryId: 'remote-retry:/repos/new-repo'
    })
  })

  it('invokes terminal operations through scoped shared channels', async () => {
    const { invoke, api } = await loadPreload()
    const terminal: FlowTerminalSummary = {
      terminalId: 'terminal-1',
      launchId: 'launch-1',
      provider: 'codex',
      mode: 'interactive',
      flowId: 'flow-1',
      phaseId: 'plan',
      status: 'running',
      command: 'codex',
      argv: ['Plan'],
      cwd: '/worktree',
      startedAt: '2026-06-14T12:00:00.000Z'
    }
    invoke
      .mockResolvedValueOnce([terminal])
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce({ ...terminal, status: 'terminated' })
      .mockResolvedValueOnce({ ...terminal, status: 'dismissed' })
    const listRequest: TerminalListRequest = {
      repositoryId: '/repos/grindstone',
      flowId: 'flow-1'
    }
    const actionRequest: TerminalActionRequest = {
      ...listRequest,
      terminalId: 'terminal-1'
    }

    await expect(api.workspace.listTerminals(listRequest)).resolves.toEqual([terminal])
    await expect(api.workspace.writeTerminalInput({
      ...actionRequest,
      data: 'q'
    })).resolves.toEqual(terminal)
    await expect(api.workspace.resizeTerminal({
      ...actionRequest,
      columns: 100,
      rows: 30
    })).resolves.toEqual(terminal)
    await expect(api.workspace.terminateTerminal(actionRequest)).resolves.toMatchObject({
      status: 'terminated'
    })
    await expect(api.workspace.dismissTerminal(actionRequest)).resolves.toMatchObject({
      status: 'dismissed'
    })

    expect(invoke).toHaveBeenNthCalledWith(1, ipcChannels.workspace.listTerminals, listRequest)
    expect(invoke).toHaveBeenNthCalledWith(2, ipcChannels.workspace.writeTerminalInput, {
      ...actionRequest,
      data: 'q'
    })
    expect(invoke).toHaveBeenNthCalledWith(3, ipcChannels.workspace.resizeTerminal, {
      ...actionRequest,
      columns: 100,
      rows: 30
    })
    expect(invoke).toHaveBeenNthCalledWith(4, ipcChannels.workspace.terminateTerminal, actionRequest)
    expect(invoke).toHaveBeenNthCalledWith(5, ipcChannels.workspace.dismissTerminal, actionRequest)
  })

  it('subscribes to terminal events and returns an unsubscribe function', async () => {
    const { api, invoke, on, removeListener } = await loadPreload()
    const handler = vi.fn()
    const request = {
      repositoryId: '/repos/grindstone',
      flowId: 'flow-1'
    }
    invoke.mockResolvedValue({ subscriptionId: 'subscription-1' })
    const unsubscribe = api.workspace.onTerminalEvent(request, handler)
    const listener = on.mock.calls[0]?.[1] as (event: unknown, payload: TerminalEvent) => void
    const event: TerminalEvent = {
      type: 'output',
      repositoryId: '/repos/grindstone',
      flowId: 'flow-1',
      terminalId: 'terminal-1',
      data: 'hello'
    }
    const unrelatedEvent: TerminalEvent = {
      ...event,
      flowId: 'flow-2',
      data: 'ignore me'
    }

    listener({}, event)
    listener({}, unrelatedEvent)
    await flushMicrotasks()
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.subscribeTerminalEvents, request)
    expect(on).toHaveBeenCalledWith(ipcChannels.events.terminal, expect.any(Function))
    expect(handler).toHaveBeenCalledWith(event)
    expect(handler).not.toHaveBeenCalledWith(unrelatedEvent)
    expect(removeListener).toHaveBeenCalledWith(ipcChannels.events.terminal, listener)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.workspace.unsubscribeTerminalEvents, {
      subscriptionId: 'subscription-1'
    })
  })

  it('invokes config updates and preserves structured validation responses', async () => {
    const { invoke, api } = await loadPreload()
    const validationResponse: ConfigUpdateResponse = {
      ok: false,
      kind: 'validation',
      errors: [
        {
          field: 'scan_roots[0]',
          message: 'scan_roots entries must be non-empty strings.'
        }
      ]
    }
    invoke.mockResolvedValue(validationResponse)

    const input: CommonConfigUpdateInput = {
      scan_roots: [''],
      repos: [],
      default_agent: null,
      artifact_root: null,
      bootstrap_hooks: []
    }

    await expect(api.config.updateCommonConfig(input)).resolves.toEqual(validationResponse)
    expect(invoke).toHaveBeenCalledWith(ipcChannels.config.updateCommonConfig, input)
  })

  it('normalizes rejected IPC errors before they cross into the renderer API', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockRejectedValue(new Error('handler failed'))

    await expect(api.workspace.getInitialState()).rejects.toEqual({
      name: 'Error',
      message: 'handler failed'
    } satisfies NormalizedIpcError)
  })
})
