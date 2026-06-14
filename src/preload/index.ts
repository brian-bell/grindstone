import { contextBridge, ipcRenderer } from 'electron'
import { invokeTypedIpc, ipcChannels, normalizeIpcError } from '@shared/ipc'
import type {
  CreateRepositoryRequest,
  InitialWorkspaceState,
  RetryRepositoryRemoteRequest
} from '@shared/workspace'

const grindstoneApi = {
  workspace: {
    async getInitialState(): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.getInitialState,
          undefined
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async selectRepository(request: { repositoryId: string }): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.selectRepository,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async createRepository(request: CreateRepositoryRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.createRepository,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async retryRepositoryRemote(
      request: RetryRepositoryRemoteRequest
    ): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.retryRepositoryRemote,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    }
  }
}

contextBridge.exposeInMainWorld('grindstone', grindstoneApi)
