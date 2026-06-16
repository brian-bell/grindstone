import type { CommonConfigUpdateInput, ConfigUpdateResponse, EditableConfigState } from '@shared/config'
import type {
  LinkedFlowPlanResponse
} from '@shared/artifacts'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  CompleteFlowPhaseRequest,
  FlowTerminalSummary,
  InitialWorkspaceState,
  LaunchFlowPhaseRequest,
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

declare global {
  interface Window {
    grindstone: {
      workspace: {
        getInitialState: () => Promise<InitialWorkspaceState>
        selectRepository: (request: { repositoryId: string }) => Promise<InitialWorkspaceState>
        readFlowPlan: (request: { flowId: string }) => Promise<LinkedFlowPlanResponse>
        createFlow: (request: CreateFlowRequest) => Promise<InitialWorkspaceState>
        updateFlowPhase: (request: UpdateFlowPhaseRequest) => Promise<InitialWorkspaceState>
        launchFlowPhase: (request: LaunchFlowPhaseRequest) => Promise<InitialWorkspaceState>
        skipFlowPhase: (request: SkipFlowPhaseRequest) => Promise<InitialWorkspaceState>
        completeFlowPhase: (request: CompleteFlowPhaseRequest) => Promise<InitialWorkspaceState>
        recordFlowPullRequest: (
          request: RecordFlowPullRequestRequest
        ) => Promise<InitialWorkspaceState>
        recordFlowHumanReview: (
          request: RecordFlowHumanReviewRequest
        ) => Promise<InitialWorkspaceState>
        recordFlowMerge: (
          request: RecordFlowMergeRequest
        ) => Promise<InitialWorkspaceState>
        createRepository: (request: CreateRepositoryRequest) => Promise<InitialWorkspaceState>
        retryRepositoryRemote: (
          request: RetryRepositoryRemoteRequest
        ) => Promise<InitialWorkspaceState>
        listTerminals: (request: TerminalListRequest) => Promise<FlowTerminalSummary[]>
        writeTerminalInput: (request: TerminalInputRequest) => Promise<FlowTerminalSummary>
        resizeTerminal: (request: TerminalResizeRequest) => Promise<FlowTerminalSummary>
        terminateTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
        dismissTerminal: (request: TerminalActionRequest) => Promise<FlowTerminalSummary>
        onTerminalEvent: (
          request: TerminalEventSubscriptionRequest,
          handler: (event: TerminalEvent) => void
        ) => () => void
      }
      config: {
        getEditableConfig: () => Promise<EditableConfigState>
        updateCommonConfig: (input: CommonConfigUpdateInput) => Promise<ConfigUpdateResponse>
      }
    }
  }
}

export {}
