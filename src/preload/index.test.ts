import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels, type NormalizedIpcError } from '@shared/ipc'
import {
  defaultInitialWorkspaceState,
  type CreateRepositoryRequest,
  type InitialWorkspaceState,
  type RetryRepositoryRemoteRequest
} from '@shared/workspace'

type PreloadApi = {
  workspace: {
    getInitialState: () => Promise<InitialWorkspaceState>
    selectRepository: (request: { repositoryId: string }) => Promise<InitialWorkspaceState>
    createRepository: (request: CreateRepositoryRequest) => Promise<InitialWorkspaceState>
    retryRepositoryRemote: (
      request: RetryRepositoryRemoteRequest
    ) => Promise<InitialWorkspaceState>
  }
}

async function loadPreload(): Promise<{
  exposeInMainWorld: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  api: PreloadApi
}> {
  const exposeInMainWorld = vi.fn()
  const invoke = vi.fn()

  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke }
  }))

  await import('./index')

  return {
    exposeInMainWorld,
    invoke,
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
    expect(Object.keys(api)).toEqual(['workspace'])
    expect(Object.keys(api.workspace)).toEqual([
      'getInitialState',
      'selectRepository',
      'createRepository',
      'retryRepositoryRemote'
    ])
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

  it('normalizes rejected IPC errors before they cross into the renderer API', async () => {
    const { invoke, api } = await loadPreload()
    invoke.mockRejectedValue(new Error('handler failed'))

    await expect(api.workspace.getInitialState()).rejects.toEqual({
      name: 'Error',
      message: 'handler failed'
    } satisfies NormalizedIpcError)
  })
})
