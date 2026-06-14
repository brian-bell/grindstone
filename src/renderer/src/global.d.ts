import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  InitialWorkspaceState,
  RetryRepositoryRemoteRequest
} from '@shared/workspace'

declare global {
  interface Window {
    grindstone: {
      workspace: {
        getInitialState: () => Promise<InitialWorkspaceState>
        selectRepository: (request: { repositoryId: string }) => Promise<InitialWorkspaceState>
        createFlow: (request: CreateFlowRequest) => Promise<InitialWorkspaceState>
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
