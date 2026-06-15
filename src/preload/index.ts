import { contextBridge, ipcRenderer } from 'electron'
import { invokeTypedIpc, ipcChannels, normalizeIpcError } from '@shared/ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import type {
  CreateFlowRequest,
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
    async readFlowPlan(request: { flowId: string }): Promise<LinkedFlowPlanResponse> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.readFlowPlan,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async createFlow(request: CreateFlowRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.createFlow,
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
  },
  config: {
    async getEditableConfig(): Promise<EditableConfigState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.config.getEditableConfig,
          undefined
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async updateCommonConfig(input: CommonConfigUpdateInput): Promise<ConfigUpdateResponse> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.config.updateCommonConfig,
          input
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    }
  }
}

contextBridge.exposeInMainWorld('grindstone', grindstoneApi)
