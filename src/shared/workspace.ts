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

export type RepositoryScanRoot = {
  id: string
  configuredPath: string
  resolvedPath: string
  displayPath: string
}

export type GitHubVisibility = 'public' | 'private'

export type CreateRepositoryRequest = {
  scanRootId: string
  name: string
  github: {
    enabled: boolean
    visibility: GitHubVisibility
  }
}

export type RetryRepositoryRemoteRequest = {
  retryId: string
}

export type CreateFlowRequest = {
  title: string
  instructions: string
  baseRef?: string
}

export type RepositoryCreateError = {
  code:
    | 'validation_error'
    | 'scan_root_unavailable'
    | 'target_exists'
    | 'local_creation_failed'
    | 'remote_creation_failed'
    | 'remote_origin_conflict'
  message: string
}

export type RepositoryRemoteSetupStatus =
  | 'remote_create_failed'
  | 'remote_maybe_created_origin_failed'
  | 'origin_missing'
  | 'origin_matches'
  | 'origin_conflict'
  | 'succeeded'

export type RepositoryRemoteRetryRecord = {
  id: string
  repositoryId: string
  repositoryPath: string
  githubRepositoryName: string
  visibility: GitHubVisibility
  status: RepositoryRemoteSetupStatus
  lastError: string
  expectedOriginUrl: string | null
}

export type RepositoryCreateState = {
  scanRoots: RepositoryScanRoot[]
  available: boolean
  error: RepositoryCreateError | null
  remoteRetries: RepositoryRemoteRetryRecord[]
}

export type RepositoryPaneState = {
  status: 'ready' | 'error'
  title: string
  description: string
  repositories: RepositoryRow[]
  selectedRepositoryId: string | null
  diagnostics: CatalogDiagnostic[]
  create: RepositoryCreateState
}

export type FlowFailureStage = 'validation' | 'worktree' | 'bootstrap' | 'launch_prep'

export type FlowFailureSummary = {
  stage: FlowFailureStage
  message: string
  command?: string
  output?: string
}

export type FlowStartMetadata = {
  repositoryPath: string
  worktreePath: string
  branch: string
  baseRef: string
  commit: string
}

export type FlowCreateError = {
  code:
    | 'validation_error'
    | 'repository_unavailable'
    | 'artifact_root_unavailable'
    | 'worktree_creation_failed'
    | 'bootstrap_failed'
    | 'launch_prep_failed'
  message: string
}

export type FlowCreateState = {
  available: boolean
  error: FlowCreateError | null
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
  instructions?: string
  branch?: string
  worktreePath?: string
  baseRef?: string
  commit?: string
  start?: FlowStartMetadata
  failure?: FlowFailureSummary
  planId?: string
  planPath?: string
  createdAt: string
  updatedAt: string
  phases?: FlowPhaseSummary[]
}

export type FlowPaneState =
  | { status: 'loading'; repositoryId?: string; repositoryName?: string }
  | {
      status: 'empty'
      title: string
      description: string
      repositoryId?: string
      repositoryName?: string
      create?: FlowCreateState
    }
  | { status: 'error'; message: string; repositoryId?: string; repositoryName?: string }
  | {
      status: 'ready'
      repositoryId: string
      repositoryName: string
      flows: FlowListRow[]
      create: FlowCreateState
    }

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
    diagnostics: [],
    create: {
      scanRoots: [],
      available: false,
      error: null,
      remoteRetries: []
    }
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
