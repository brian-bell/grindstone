import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type {
  LinkedFlowPlanResponse
} from '@shared/artifacts'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  InitialWorkspaceState,
  RetryRepositoryRemoteRequest,
  UpdateFlowPhaseRequest
} from '@shared/workspace'

declare global {
  interface Window {
    grindstone: {
      workspace: {
        getInitialState: () => Promise<InitialWorkspaceState>
        selectRepository: (request: { repositoryId: string }) => Promise<InitialWorkspaceState>
        readFlowPlan: (request: { flowId: string }) => Promise<LinkedFlowPlanResponse>
        createFlow: (request: CreateFlowRequest) => Promise<InitialWorkspaceState>
        updateFlowPhase: (request: UpdateFlowPhaseRequest) => Promise<InitialWorkspaceState>
        createRepository: (request: CreateRepositoryRequest) => Promise<InitialWorkspaceState>
        retryRepositoryRemote: (
          request: RetryRepositoryRemoteRequest
        ) => Promise<InitialWorkspaceState>
      }
      config: {
        getEditableConfig: () => Promise<EditableConfigState>
        updateCommonConfig: (input: CommonConfigUpdateInput) => Promise<ConfigUpdateResponse>
      }
    }
  }
}

export {}
