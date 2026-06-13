import type { IpcMain } from 'electron'
import { ipcChannels } from '@shared/ipc'
import {
  defaultInitialWorkspaceState,
  type InitialWorkspaceState
} from '@shared/workspace'

export async function loadInitialWorkspaceState(): Promise<InitialWorkspaceState> {
  return defaultInitialWorkspaceState
}

export function registerWorkspaceHandlers(ipcMain: Pick<IpcMain, 'handle'>): void {
  ipcMain.handle(ipcChannels.workspace.getInitialState, () => loadInitialWorkspaceState())
}
