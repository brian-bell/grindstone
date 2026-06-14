import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  FlowTerminalSummary,
  InitialWorkspaceState,
  RetryRepositoryRemoteRequest,
  TerminalActionRequest,
  TerminalEvent,
  TerminalInputRequest,
  TerminalListRequest,
  TerminalResizeRequest
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
        listTerminals: (request: TerminalListRequest) => Promise<FlowTerminalSummary[]>
        writeTerminalInput: (request: TerminalInputRequest) => Promise<FlowTerminalSummary>
        resizeTerminal: (request: TerminalResizeRequest) => Promise<FlowTerminalSummary>
        terminateTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
        dismissTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
        onTerminalEvent: (handler: (event: TerminalEvent) => void) => () => void
      }
      config: {
        getEditableConfig: () => Promise<EditableConfigState>
        updateCommonConfig: (input: CommonConfigUpdateInput) => Promise<ConfigUpdateResponse>
      }
    }
  }
}

export {}
