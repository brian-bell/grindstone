import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  handleTypedIpc,
  invokeTypedIpc,
  ipcChannels,
  normalizeIpcError,
  type IpcRequestMap,
  type IpcResponseMap
} from './ipc'
import { defaultInitialWorkspaceState, type InitialWorkspaceState } from './workspace'

describe('IPC contract', () => {
  it('pins the initial workspace channel name', () => {
    expect(ipcChannels.workspace.getInitialState).toBe('workspace:getInitialState')
    expect(ipcChannels.workspace.selectRepository).toBe('workspace:selectRepository')
    expect(ipcChannels.workspace.createRepository).toBe('workspace:createRepository')
    expect(ipcChannels.workspace.retryRepositoryRemote).toBe('workspace:retryRepositoryRemote')
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
