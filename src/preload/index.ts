import { contextBridge, ipcRenderer } from 'electron'
import { invokeTypedIpc, ipcChannels, normalizeIpcError } from '@shared/ipc'
import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type { LinkedFlowPlanResponse } from '@shared/artifacts'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  CompleteFlowPhaseRequest,
  InitialWorkspaceState,
  FlowTerminalSummary,
  LaunchFlowPhaseRequest,
  ManualUpdateFlowPhaseRequest,
  RecordFlowHumanReviewRequest,
  RecordFlowMergeRequest,
  RecordFlowPullRequestRequest,
  RetryRepositoryRemoteRequest,
  SkipFlowPhaseRequest,
  TerminalActionRequest,
  TerminalEvent,
  TerminalEventSubscriptionRequest,
  TerminalInputRequest,
  TerminalListRequest,
  TerminalResizeRequest,
  UpdateFlowPhaseRequest
} from '@shared/workspace'

type TerminalEventHandler = (event: TerminalEvent) => void

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
    async updateFlowPhase(request: UpdateFlowPhaseRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.updateFlowPhase,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async launchFlowPhase(request: LaunchFlowPhaseRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.launchFlowPhase,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async manualUpdateFlowPhase(request: ManualUpdateFlowPhaseRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.manualUpdateFlowPhase,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async skipFlowPhase(request: SkipFlowPhaseRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.skipFlowPhase,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async completeFlowPhase(request: CompleteFlowPhaseRequest): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.completeFlowPhase,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async recordFlowPullRequest(
      request: RecordFlowPullRequestRequest
    ): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.recordFlowPullRequest,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async recordFlowHumanReview(
      request: RecordFlowHumanReviewRequest
    ): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.recordFlowHumanReview,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async recordFlowMerge(
      request: RecordFlowMergeRequest
    ): Promise<InitialWorkspaceState> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.recordFlowMerge,
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
    },
    async listTerminals(request: TerminalListRequest): Promise<FlowTerminalSummary[]> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.listTerminals,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async writeTerminalInput(request: TerminalInputRequest): Promise<FlowTerminalSummary> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.writeTerminalInput,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async resizeTerminal(request: TerminalResizeRequest): Promise<FlowTerminalSummary> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.resizeTerminal,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async terminateTerminal(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.terminateTerminal,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    async dismissTerminal(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
      try {
        return await invokeTypedIpc(
          ipcRenderer.invoke.bind(ipcRenderer),
          ipcChannels.workspace.dismissTerminal,
          request
        )
      } catch (error) {
        throw normalizeIpcError(error)
      }
    },
    onTerminalEvent(
      request: TerminalEventSubscriptionRequest,
      handler: TerminalEventHandler
    ): () => void {
      let active = true
      let subscriptionId: string | undefined
      const listener = (_event: unknown, payload: TerminalEvent) => {
        if (
          active &&
          payload.repositoryId === request.repositoryId &&
          payload.flowId === request.flowId
        ) {
          handler(payload)
        }
      }
      void invokeTypedIpc(
        ipcRenderer.invoke.bind(ipcRenderer),
        ipcChannels.workspace.subscribeTerminalEvents,
        request
      ).then((subscription) => {
        if (!active) {
          void invokeTypedIpc(
            ipcRenderer.invoke.bind(ipcRenderer),
            ipcChannels.workspace.unsubscribeTerminalEvents,
            { subscriptionId: subscription.subscriptionId }
          )
          return
        }

        subscriptionId = subscription.subscriptionId
      }).catch(() => undefined)
      ipcRenderer.on(ipcChannels.events.terminal, listener)
      return () => {
        active = false
        ipcRenderer.removeListener(ipcChannels.events.terminal, listener)
        if (subscriptionId !== undefined) {
          void invokeTypedIpc(
            ipcRenderer.invoke.bind(ipcRenderer),
            ipcChannels.workspace.unsubscribeTerminalEvents,
            { subscriptionId }
          )
        }
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
