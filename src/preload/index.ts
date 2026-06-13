import { contextBridge, ipcRenderer } from 'electron'
import { ipcChannels, normalizeIpcError } from '@shared/ipc'
import type { InitialWorkspaceState } from '@shared/workspace'

const grindstoneApi = {
  workspace: {
    async getInitialState(): Promise<InitialWorkspaceState> {
      try {
        return await ipcRenderer.invoke(ipcChannels.workspace.getInitialState)
      } catch (error) {
        throw normalizeIpcError(error)
      }
    }
  }
}

contextBridge.exposeInMainWorld('grindstone', grindstoneApi)
