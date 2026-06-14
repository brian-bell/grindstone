export type RepositorySource = 'scan_root' | 'explicit'

export type CatalogDiagnosticCode =
  | 'config_parse_error'
  | 'config_type_error'
  | 'scan_root_missing'
  | 'scan_root_unreadable'
  | 'explicit_repo_missing'

export type CatalogDiagnostic = {
  severity: 'error' | 'warning'
  code: CatalogDiagnosticCode
  message: string
  configuredPath: string
  resolvedPath: string
}

export type RepositoryRow = {
  id: string
  name: string
  path: string
  canonicalPath: string
  sources: RepositorySource[]
}

export type RepositoryPaneState = {
  status: 'ready' | 'error'
  title: string
  description: string
  repositories: RepositoryRow[]
  selectedRepositoryId: string | null
  diagnostics: CatalogDiagnostic[]
}

export type FlowPhaseSummary = {
  id: string
  title: string
  status: string
  order: number
  kind?: string
  outcome?: string
  summary?: string
  updatedAt?: string
}

export type FlowListRow = {
  id: string
  title: string
  status: string
  repositoryId: string
  repositoryPath: string
  branch?: string
  worktreePath?: string
  commit?: string
  planId?: string
  planPath?: string
  createdAt: string
  updatedAt: string
  phases?: FlowPhaseSummary[]
}

export type FlowPaneState =
  | { status: 'loading'; repositoryId?: string; repositoryName?: string }
  | { status: 'empty'; title: string; description: string; repositoryId?: string; repositoryName?: string }
  | { status: 'error'; message: string; repositoryId?: string; repositoryName?: string }
  | { status: 'ready'; repositoryId: string; repositoryName: string; flows: FlowListRow[] }

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
  flow: Exclude<FlowPaneState, { status: 'loading' }>
  hints: ContextHint[]
  shortcuts: ShortcutAffordance[]
}

export const defaultInitialWorkspaceState: InitialWorkspaceState = {
  repository: {
    status: 'ready',
    title: 'No repositories configured',
    description: 'Add scan_roots or repos to Grindstone config to populate this pane.',
    repositories: [],
    selectedRepositoryId: null,
    diagnostics: []
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
