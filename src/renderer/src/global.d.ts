import type { InitialWorkspaceState } from '@shared/workspace'

declare global {
  interface Window {
    grindstone: {
      workspace: {
        getInitialState: () => Promise<InitialWorkspaceState>
      }
    }
  }
}

export {}
