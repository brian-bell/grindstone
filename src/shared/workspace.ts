import type {
  FlowHumanReviewMetadata,
  FlowHumanReviewOutcome,
  FlowMergeMetadata,
  FlowPullRequestMetadata
} from './artifacts'

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

export type UpdateFlowPhaseRequest = {
  flowId: string
  phaseId: string
  title?: string
  order?: number
  notes?: string
}

export type LaunchFlowPhaseRequest = {
  flowId: string
  phaseId: string
}

export type ManualUpdateFlowPhaseRequest = {
  flowId: string
  phaseId: string
  action: FlowPhaseManualAction
  notes?: string
}

export type SkipFlowPhaseRequest = {
  flowId: string
  phaseId: string
  notes: string
}

export type CompleteFlowPhaseRequest = {
  flowId: string
  phaseId: string
  summary?: string
}

export type RecordFlowPullRequestRequest = {
  flowId: string
  pr: FlowPullRequestMetadata
  summary?: string
}

export type RecordFlowHumanReviewRequest = {
  flowId: string
  outcome: FlowHumanReviewOutcome
  notes?: string
}

export type RecordFlowMergeRequest =
  | { flowId: string; status: 'merged'; commit: string }
  | { flowId: string; status: 'blocked'; notes: string }

export type AgentProvider = 'codex' | 'claude'

export type AgentLaunchMode = 'headless' | 'interactive' | 'resume' | 'continue'

export type TerminalStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'terminated'
  | 'failed'
  | 'dismissed'

export const RECENT_TERMINAL_OUTPUT_LIMIT = 20_000

export type FlowTerminalSummary = {
  terminalId: string
  launchId: string
  provider: AgentProvider
  mode: AgentLaunchMode
  flowId: string
  phaseId: string
  planId?: string
  sessionId?: string
  status: TerminalStatus
  command: string
  argv: string[]
  cwd: string
  logPath?: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  signal?: string
  recentOutput?: string
}

export type TerminalListRequest = {
  repositoryId: string
  flowId: string
}

export type TerminalInputRequest = {
  repositoryId: string
  flowId: string
  terminalId: string
  data: string
}

export type TerminalResizeRequest = {
  repositoryId: string
  flowId: string
  terminalId: string
  columns: number
  rows: number
}

export type TerminalActionRequest = {
  repositoryId: string
  flowId: string
  terminalId: string
}

export type TerminalEventSubscriptionRequest = {
  repositoryId: string
  flowId: string
}

export type TerminalEventSubscriptionResponse = {
  subscriptionId: string
}

export type TerminalEventUnsubscribeRequest = {
  subscriptionId: string
}

export type TerminalEvent =
  | {
      type: 'output'
      repositoryId: string
      flowId: string
      terminalId: string
      data: string
    }
  | {
      type: 'state'
      repositoryId: string
      flowId: string
      terminal: FlowTerminalSummary
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
  parentPhaseId?: string
  kind?: string
  outcome?: string
  summary?: string
  notes?: string
  launchIds?: string[]
  generated?: boolean
  editable?: boolean
  sourcePlanId?: string
  manualActions?: FlowPhaseManualActionAffordance[]
  updatedAt?: string
}

export type FlowPhaseManualAction = 'restart' | 'block' | 'needs_attention' | 'skip'

export type FlowPhaseManualActionAffordance = {
  action: FlowPhaseManualAction
  label: string
  requiresNotes: boolean
  allowsBlankNotes?: boolean
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
  pr?: FlowPullRequestMetadata
  humanReview?: FlowHumanReviewMetadata
  merge: FlowMergeMetadata
  createdAt: string
  updatedAt: string
  phases?: FlowPhaseSummary[]
  terminals?: FlowTerminalSummary[]
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
