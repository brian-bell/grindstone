import type {
  CommonConfigUpdateInput,
  ConfigUpdateResponse,
  EditableConfigState
} from './config'
import type {
  LinkedFlowPlanResponse
} from './artifacts'
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
  TerminalInputRequest,
  TerminalListRequest,
  TerminalResizeRequest,
  TerminalEventSubscriptionRequest,
  TerminalEventSubscriptionResponse,
  TerminalEventUnsubscribeRequest,
  UpdateFlowPhaseRequest
} from './workspace'

export const ipcChannels = {
  workspace: {
    getInitialState: 'workspace:getInitialState',
    selectRepository: 'workspace:selectRepository',
    readFlowPlan: 'workspace:readFlowPlan',
    createFlow: 'workspace:createFlow',
    updateFlowPhase: 'workspace:updateFlowPhase',
    launchFlowPhase: 'workspace:launchFlowPhase',
    skipFlowPhase: 'workspace:skipFlowPhase',
    completeFlowPhase: 'workspace:completeFlowPhase',
    recordFlowPullRequest: 'workspace:recordFlowPullRequest',
    recordFlowHumanReview: 'workspace:recordFlowHumanReview',
    recordFlowMerge: 'workspace:recordFlowMerge',
    createRepository: 'workspace:createRepository',
    retryRepositoryRemote: 'workspace:retryRepositoryRemote',
    listTerminals: 'workspace:listTerminals',
    writeTerminalInput: 'workspace:writeTerminalInput',
    resizeTerminal: 'workspace:resizeTerminal',
    terminateTerminal: 'workspace:terminateTerminal',
    dismissTerminal: 'workspace:dismissTerminal',
    subscribeTerminalEvents: 'workspace:subscribeTerminalEvents',
    unsubscribeTerminalEvents: 'workspace:unsubscribeTerminalEvents'
  },
  config: {
    getEditableConfig: 'config:getEditableConfig',
    updateCommonConfig: 'config:updateCommonConfig'
  },
  events: {
    terminal: 'workspace:terminalEvent'
  }
} as const

export type IpcChannel =
  | (typeof ipcChannels.workspace)[keyof typeof ipcChannels.workspace]
  | (typeof ipcChannels.config)[keyof typeof ipcChannels.config]

export type IpcRequestMap = {
  'workspace:getInitialState': undefined
  'workspace:selectRepository': {
    repositoryId: string
  }
  'workspace:readFlowPlan': {
    flowId: string
  }
  'workspace:createFlow': CreateFlowRequest
  'workspace:updateFlowPhase': UpdateFlowPhaseRequest
  'workspace:launchFlowPhase': LaunchFlowPhaseRequest
  'workspace:skipFlowPhase': SkipFlowPhaseRequest
  'workspace:completeFlowPhase': CompleteFlowPhaseRequest
  'workspace:recordFlowPullRequest': RecordFlowPullRequestRequest
  'workspace:recordFlowHumanReview': RecordFlowHumanReviewRequest
  'workspace:recordFlowMerge': RecordFlowMergeRequest
  'workspace:createRepository': CreateRepositoryRequest
  'workspace:retryRepositoryRemote': RetryRepositoryRemoteRequest
  'workspace:listTerminals': TerminalListRequest
  'workspace:writeTerminalInput': TerminalInputRequest
  'workspace:resizeTerminal': TerminalResizeRequest
  'workspace:terminateTerminal': TerminalActionRequest
  'workspace:dismissTerminal': TerminalActionRequest
  'workspace:subscribeTerminalEvents': TerminalEventSubscriptionRequest
  'workspace:unsubscribeTerminalEvents': TerminalEventUnsubscribeRequest
  'config:getEditableConfig': undefined
  'config:updateCommonConfig': CommonConfigUpdateInput
}

export type IpcResponseMap = {
  'workspace:getInitialState': InitialWorkspaceState
  'workspace:selectRepository': InitialWorkspaceState
  'workspace:readFlowPlan': LinkedFlowPlanResponse
  'workspace:createFlow': InitialWorkspaceState
  'workspace:updateFlowPhase': InitialWorkspaceState
  'workspace:launchFlowPhase': InitialWorkspaceState
  'workspace:skipFlowPhase': InitialWorkspaceState
  'workspace:completeFlowPhase': InitialWorkspaceState
  'workspace:recordFlowPullRequest': InitialWorkspaceState
  'workspace:recordFlowHumanReview': InitialWorkspaceState
  'workspace:recordFlowMerge': InitialWorkspaceState
  'workspace:createRepository': InitialWorkspaceState
  'workspace:retryRepositoryRemote': InitialWorkspaceState
  'workspace:listTerminals': FlowTerminalSummary[]
  'workspace:writeTerminalInput': FlowTerminalSummary
  'workspace:resizeTerminal': FlowTerminalSummary
  'workspace:terminateTerminal': FlowTerminalSummary
  'workspace:dismissTerminal': FlowTerminalSummary
  'workspace:subscribeTerminalEvents': TerminalEventSubscriptionResponse
  'workspace:unsubscribeTerminalEvents': undefined
  'config:getEditableConfig': EditableConfigState
  'config:updateCommonConfig': ConfigUpdateResponse
}

export type NormalizedIpcError = {
  name: 'Error'
  message: string
}

type MaybePromise<T> = T | Promise<T>

export type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>

export type IpcHandlerRegistrar = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => MaybePromise<unknown>
  ) => void
}

export async function invokeTypedIpc<Channel extends IpcChannel>(
  invoke: IpcInvoker,
  channel: Channel,
  request: IpcRequestMap[Channel]
): Promise<IpcResponseMap[Channel]> {
  const args = request === undefined ? [] : [request]
  return (await invoke(channel, ...args)) as IpcResponseMap[Channel]
}

export function handleTypedIpc<Channel extends IpcChannel>(
  ipcMain: IpcHandlerRegistrar,
  channel: Channel,
  handler: (request: IpcRequestMap[Channel]) => MaybePromise<IpcResponseMap[Channel]>
): void {
  ipcMain.handle(channel, async (_event, request) => handler(request as IpcRequestMap[Channel]))
}

export function normalizeIpcError(error: unknown): NormalizedIpcError {
  if (error instanceof Error) {
    return {
      name: 'Error',
      message: error.message
    }
  }

  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error
    }
  }

  return {
    name: 'Error',
    message: 'Unknown IPC error'
  }
}
