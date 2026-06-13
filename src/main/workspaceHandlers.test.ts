import { describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import { defaultInitialWorkspaceState } from '@shared/workspace'
import { loadInitialWorkspaceState, registerWorkspaceHandlers } from './workspaceHandlers'

describe('workspace main handlers', () => {
  it('loads the static initial workspace state for this shell slice', async () => {
    await expect(loadInitialWorkspaceState()).resolves.toEqual(defaultInitialWorkspaceState)
  })

  it('registers the initial workspace IPC handler on the shared channel', async () => {
    const ipcMain = {
      handle: vi.fn()
    }

    registerWorkspaceHandlers(ipcMain)

    expect(ipcMain.handle).toHaveBeenCalledWith(
      ipcChannels.workspace.getInitialState,
      expect.any(Function)
    )

    const handler = ipcMain.handle.mock.calls[0]?.[1] as () => Promise<unknown>
    await expect(handler()).resolves.toEqual(defaultInitialWorkspaceState)
  })
})
