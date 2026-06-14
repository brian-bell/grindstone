import type {
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
        createRepository: (request: CreateRepositoryRequest) => Promise<InitialWorkspaceState>
        retryRepositoryRemote: (
          request: RetryRepositoryRemoteRequest
        ) => Promise<InitialWorkspaceState>
      }
    }
  }
}

export {}
