export type RepositoryPaneState = {
  status: 'empty'
  title: string
  description: string
}

export type FlowPaneState =
  | { status: 'loading' }
  | { status: 'empty'; title: string; description: string }
  | { status: 'error'; message: string }

export type ContextHint = {
  id: string
  title: string
  description: string
}

export type ShortcutAffordance = {
  id: string
  label: string
  description: string
  disabled: boolean
}

export type InitialWorkspaceState = {
  repository: RepositoryPaneState
  flow: Exclude<FlowPaneState, { status: 'loading' | 'error' }>
  hints: ContextHint[]
  shortcuts: ShortcutAffordance[]
}

export const defaultInitialWorkspaceState: InitialWorkspaceState = {
  repository: {
    status: 'empty',
    title: 'No repository selected',
    description: 'Repository catalog integration will connect this area to Flow setup.'
  },
  flow: {
    status: 'empty',
    title: 'No Flow selected',
    description: 'Create or continue a Flow from a repository when persistence is connected.'
  },
  hints: [
    {
      id: 'select-repository',
      title: 'Select a repository',
      description: 'Repository catalog work will populate this pane before Flow creation.'
    },
    {
      id: 'flow-first',
      title: 'Stay in Flow',
      description: 'Plans and sessions stay attached to the active Flow workspace.'
    }
  ],
  shortcuts: [
    {
      id: 'new-flow',
      label: 'New Flow',
      description: 'Create a Flow when repository actions are available.',
      disabled: true
    },
    {
      id: 'continue-flow',
      label: 'Continue Flow',
      description: 'Resume the selected Flow when persistence is connected.',
      disabled: true
    }
  ]
}
