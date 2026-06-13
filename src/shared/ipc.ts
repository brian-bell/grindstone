import type { InitialWorkspaceState } from './workspace'

export const ipcChannels = {
  workspace: {
    getInitialState: 'workspace:getInitialState'
  }
} as const

export type IpcChannel = (typeof ipcChannels.workspace)[keyof typeof ipcChannels.workspace]

export type IpcRequestMap = {
  'workspace:getInitialState': undefined
}

export type IpcResponseMap = {
  'workspace:getInitialState': InitialWorkspaceState
}

export type NormalizedIpcError = {
  name: 'Error'
  message: string
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
