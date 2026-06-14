import type {
  CommonConfigUpdateInput,
  ConfigUpdateResponse,
  EditableConfigState
} from './config'
import type {
  CreateRepositoryRequest,
  InitialWorkspaceState,
  RetryRepositoryRemoteRequest
} from './workspace'

export const ipcChannels = {
  workspace: {
    getInitialState: 'workspace:getInitialState',
    selectRepository: 'workspace:selectRepository',
    createRepository: 'workspace:createRepository',
    retryRepositoryRemote: 'workspace:retryRepositoryRemote'
  },
  config: {
    getEditableConfig: 'config:getEditableConfig',
    updateCommonConfig: 'config:updateCommonConfig'
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
  'workspace:createRepository': CreateRepositoryRequest
  'workspace:retryRepositoryRemote': RetryRepositoryRemoteRequest
  'config:getEditableConfig': undefined
  'config:updateCommonConfig': CommonConfigUpdateInput
}

export type IpcResponseMap = {
  'workspace:getInitialState': InitialWorkspaceState
  'workspace:selectRepository': InitialWorkspaceState
  'workspace:createRepository': InitialWorkspaceState
  'workspace:retryRepositoryRemote': InitialWorkspaceState
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
