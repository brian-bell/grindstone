import { describe, expect, it } from 'vitest'
import {
  ipcChannels,
  normalizeIpcError,
  type IpcRequestMap,
  type IpcResponseMap
} from './ipc'
import type { InitialWorkspaceState } from './workspace'

describe('IPC contract', () => {
  it('pins the initial workspace channel name', () => {
    expect(ipcChannels.workspace.getInitialState).toBe('workspace:getInitialState')
  })

  it('maps workspace:getInitialState to an empty request and InitialWorkspaceState response', () => {
    const request: IpcRequestMap['workspace:getInitialState'] = undefined
    const response = {} as IpcResponseMap['workspace:getInitialState']

    expect(request).toBeUndefined()
    expect(response).toEqual({} as InitialWorkspaceState)
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
