import {
  Check,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Maximize2,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type ReactElement
} from 'react'
import { resolveMiddlePaneRoute } from '@shared/middlePane'
import { RECENT_TERMINAL_OUTPUT_LIMIT } from '@shared/workspace'
import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  EditableBootstrapHook,
  EditableConfigState
} from '@shared/config'
import type {
  FlowHumanReviewOutcome,
  FlowPullRequestStatus,
  LinkedFlowPlanResponse
} from '@shared/artifacts'
import type {
  CatalogDiagnostic,
  CreateFlowRequest,
  FlowListRow,
  FlowTerminalSummary,
  TerminalActionRequest,
  TerminalEvent,
  FlowPaneState,
  FlowPhaseManualAction,
  FlowPhaseManualActionAffordance,
  FlowPhaseSummary,
  GitHubVisibility,
  InitialWorkspaceState,
  RecordFlowHumanReviewRequest,
  RecordFlowMergeRequest,
  RecordFlowPullRequestRequest,
  RepositoryCreateState,
  RepositoryRemoteRetryRecord,
  RepositoryPaneState,
  RepositoryRow
} from '@shared/workspace'
import { defaultInitialWorkspaceState } from '@shared/workspace'

type RightPaneMode = 'hints' | 'config'
type RightPaneFocusTarget = 'expand' | 'collapse'

const RIGHT_PANE_ID = 'context-pane'
const RIGHT_PANE_CONTENT_ID = 'context-pane-content'

type ConfigSaveResult = {
  errors: ConfigFieldError[]
  message: string | null
  canReload: boolean
}

type ConfigDraft = {
  scan_roots: string[]
  repos: string[]
  default_agent: '' | 'codex' | 'claude'
  artifact_root: string
  bootstrap_hooks: BootstrapHookDraft[]
}

type ConfigInputResult =
  | {
    ok: true
    input: CommonConfigUpdateInput
  }
  | {
    ok: false
    errors: ConfigFieldError[]
  }

type BootstrapHookDraft = {
  sourceIndex?: number
  name: string
  command: string
  cwd: string
  env: string
}

type PullRequestDraft = {
  number: string
  url: string
  head: string
  base: string
  status: FlowPullRequestStatus
}

export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<InitialWorkspaceState | null>(null)
  const [routeResolution] = useState(() => resolveMiddlePaneRoute(getRendererPath()))
  const routeFlowState = 'flowState' in routeResolution ? routeResolution.flowState : null
  const [flowState, setFlowState] = useState<FlowPaneState>(
    routeFlowState ?? { status: 'loading' }
  )
  const [flowCreateOpenRequest, setFlowCreateOpenRequest] = useState(0)
  const selectionRequestIdRef = useRef(0)
  const rightPaneFocusTargetRef = useRef<RightPaneFocusTarget | null>(null)
  const expandRightPaneButtonRef = useRef<HTMLButtonElement | null>(null)
  const collapseRightPaneButtonRef = useRef<HTMLButtonElement | null>(null)
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>('hints')
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(false)
  const [editableConfig, setEditableConfig] = useState<EditableConfigState | null>(null)
  const [configLoadError, setConfigLoadError] = useState<string | null>(null)
  const terminalSubscriptionKey = flowState.status === 'ready'
    ? `${flowState.repositoryId}:${flowState.flows.map((flow) => flow.id).join('\0')}`
    : ''

  useEffect(() => {
    let cancelled = false

    window.grindstone.workspace
      .getInitialState()
      .then((initialState) => {
        if (!cancelled) {
          setWorkspace(initialState)
          setFlowState(routeFlowState ?? initialState.flow)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWorkspace(defaultInitialWorkspaceState)
          setFlowState({
            status: 'error',
            message: getErrorMessage(error)
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [routeFlowState])

  useEffect(() => {
    let cancelled = false

    window.grindstone.config
      .getEditableConfig()
      .then((config) => {
        if (!cancelled) {
          setEditableConfig(config)
          setConfigLoadError(null)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigLoadError(getErrorMessage(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (
      flowState.status !== 'ready' ||
      window.grindstone?.workspace?.onTerminalEvent === undefined
    ) {
      return undefined
    }

    const handleTerminalEvent = (event: TerminalEvent) => {
      const updateFlow = (flow: FlowPaneState): FlowPaneState => {
        if (flow.status !== 'ready' || flow.repositoryId !== event.repositoryId) {
          return flow
        }

        return {
          ...flow,
          flows: flow.flows.map((row) => {
            if (row.id !== event.flowId) {
              return row
            }

            const terminals = row.terminals ?? []
            if (event.type === 'output') {
              return {
                ...row,
                terminals: terminals.map((terminal) =>
                  terminal.terminalId === event.terminalId
                    ? {
                        ...terminal,
                        recentOutput: trimRecentTerminalOutput(
                          `${terminal.recentOutput ?? ''}${event.data}`
                        )
                      }
                    : terminal
                )
              }
            }

            return {
              ...row,
              terminals: [
                ...terminals.filter((terminal) =>
                  terminal.terminalId !== event.terminal.terminalId
                ),
                event.terminal
              ]
            }
          })
        }
      }

      setFlowState((current) => updateFlow(current))
      setWorkspace((current) => current === null
        ? current
        : {
            ...current,
            flow: updateFlow(current.flow) as InitialWorkspaceState['flow']
          })
    }

    const unsubscribes = flowState.flows.map((flow) =>
      window.grindstone.workspace.onTerminalEvent(
        {
          repositoryId: flowState.repositoryId,
          flowId: flow.id
        },
        handleTerminalEvent
      )
    )

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [terminalSubscriptionKey])

  const shellState = workspace ?? defaultInitialWorkspaceState
  const isWorkspaceLoading = workspace === null

  useEffect(() => {
    const focusTarget = rightPaneFocusTargetRef.current

    if (focusTarget === 'expand' && isRightPaneCollapsed) {
      rightPaneFocusTargetRef.current = null
      expandRightPaneButtonRef.current?.focus()
      return
    }

    if (focusTarget === 'collapse' && !isRightPaneCollapsed) {
      rightPaneFocusTargetRef.current = null
      collapseRightPaneButtonRef.current?.focus()
    }
  }, [isRightPaneCollapsed])

  async function handleRepositorySelect(repository: RepositoryRow): Promise<void> {
    const requestId = selectionRequestIdRef.current + 1
    selectionRequestIdRef.current = requestId

    if (routeFlowState === null) {
      setFlowState({
        status: 'loading',
        repositoryId: repository.id,
        repositoryName: repository.name
      })
    }

    try {
      const nextWorkspace = await window.grindstone.workspace.selectRepository({
        repositoryId: repository.id
      })
      if (requestId !== selectionRequestIdRef.current) {
        return
      }

      applyWorkspace(nextWorkspace)
    } catch (error: unknown) {
      if (requestId !== selectionRequestIdRef.current) {
        return
      }

      setFlowState({
        status: 'error',
        message: getErrorMessage(error),
        repositoryId: repository.id,
        repositoryName: repository.name
      })
    }
  }

  function applyWorkspace(nextWorkspace: InitialWorkspaceState): void {
    setWorkspace(nextWorkspace)
    setFlowState(routeFlowState ?? nextWorkspace.flow)
  }

  function requestFlowCreate(): void {
    setFlowCreateOpenRequest((request) => request + 1)
  }

  function collapseRightPane(): void {
    rightPaneFocusTargetRef.current = 'expand'
    setIsRightPaneCollapsed(true)
  }

  function expandRightPane(): void {
    rightPaneFocusTargetRef.current = 'collapse'
    setIsRightPaneCollapsed(false)
  }

  async function handleConfigReload(): Promise<void> {
    const [nextWorkspace, nextConfig] = await Promise.all([
      window.grindstone.workspace.getInitialState(),
      window.grindstone.config.getEditableConfig()
    ])

    setWorkspace(nextWorkspace)
    setEditableConfig(nextConfig)
    setFlowState(routeFlowState ?? nextWorkspace.flow)
  }

  async function handleConfigSave(input: CommonConfigUpdateInput): Promise<ConfigSaveResult> {
    const response = await window.grindstone.config.updateCommonConfig(input)

    if (response.ok) {
      setWorkspace(response.workspace)
      setEditableConfig(response.config)
      setFlowState(routeFlowState ?? response.workspace.flow)
      return { errors: [], message: null, canReload: false }
    }

    if (response.kind === 'validation') {
      return { errors: response.errors, message: null, canReload: false }
    }

    if (response.config !== undefined) {
      setEditableConfig(response.config)
    }

    return {
      errors: [],
      message: `Config saved to ${response.configPath}, but reload failed: ${response.message}`,
      canReload: true
    }
  }

  return (
    <div
      className={isRightPaneCollapsed ? 'app-shell app-shell-right-collapsed' : 'app-shell'}
    >
      <section
        className="pane repository-pane"
        aria-labelledby="repository-pane-title"
      >
        <div className="pane-header">
          <GitBranch aria-hidden="true" size={18} />
          <h2 id="repository-pane-title">Repos</h2>
        </div>
        <RepositoryCatalogView
          isLoading={isWorkspaceLoading}
          repository={shellState.repository}
          onSelect={handleRepositorySelect}
          onConfigure={() => {
            setRightPaneMode('config')
            setIsRightPaneCollapsed(false)
          }}
          onWorkspaceUpdate={applyWorkspace}
        />
      </section>

      <main
        className="pane flow-pane"
        aria-labelledby="flow-workspace-title"
      >
        <div className="pane-header">
          <Sparkles aria-hidden="true" size={18} />
          <h1 id="flow-workspace-title">Flow Workspace</h1>
        </div>
        <FlowWorkspaceStateView
          createOpenRequest={flowCreateOpenRequest}
          state={flowState}
          onWorkspaceUpdate={applyWorkspace}
        />
      </main>

      <section
        aria-label={isRightPaneCollapsed ? 'Right pane' : undefined}
        aria-labelledby={isRightPaneCollapsed ? undefined : 'context-pane-title'}
        className={isRightPaneCollapsed
          ? 'pane context-pane context-pane-collapsed'
          : 'pane context-pane'}
        id={RIGHT_PANE_ID}
      >
        {isRightPaneCollapsed ? (
          <button
            aria-controls={RIGHT_PANE_CONTENT_ID}
            aria-expanded="false"
            aria-label="Expand right pane"
            className="icon-button"
            ref={expandRightPaneButtonRef}
            title="Expand right pane"
            type="button"
            onClick={expandRightPane}
          >
            <PanelRightOpen aria-hidden="true" size={16} />
          </button>
        ) : null}
        <div id={RIGHT_PANE_CONTENT_ID} hidden={isRightPaneCollapsed}>
          {rightPaneMode === 'config' ? (
            <ConfigEditorPanel
              collapseButtonRef={collapseRightPaneButtonRef}
              config={editableConfig}
              loadError={configLoadError}
              onCancel={() => setRightPaneMode('hints')}
              onCollapse={collapseRightPane}
              onReload={handleConfigReload}
              onSave={handleConfigSave}
            />
          ) : (
            <ContextHintsPanel
              collapseButtonRef={collapseRightPaneButtonRef}
              workspace={shellState}
              onCollapse={collapseRightPane}
              onNewFlow={requestFlowCreate}
            />
          )}
        </div>
      </section>
    </div>
  )
}

function trimRecentTerminalOutput(output: string): string {
  return output.length <= RECENT_TERMINAL_OUTPUT_LIMIT
    ? output
    : output.slice(output.length - RECENT_TERMINAL_OUTPUT_LIMIT)
}

export function getTerminalOutputAppend(previousOutput: string, output: string): string {
  if (previousOutput === '' || output.startsWith(previousOutput)) {
    return output.slice(previousOutput.length)
  }
  if (output === '') {
    return ''
  }

  const prefixTable = Array<number>(output.length).fill(0)
  for (let index = 1; index < output.length; index += 1) {
    let candidateLength = prefixTable[index - 1] ?? 0
    while (candidateLength > 0 && output[index] !== output[candidateLength]) {
      candidateLength = prefixTable[candidateLength - 1] ?? 0
    }
    if (output[index] === output[candidateLength]) {
      candidateLength += 1
    }
    prefixTable[index] = candidateLength
  }

  let overlapLength = 0
  for (let index = 0; index < previousOutput.length; index += 1) {
    while (overlapLength > 0 && previousOutput[index] !== output[overlapLength]) {
      overlapLength = prefixTable[overlapLength - 1] ?? 0
    }
    if (previousOutput[index] === output[overlapLength]) {
      overlapLength += 1
    }
    if (overlapLength === output.length && index < previousOutput.length - 1) {
      overlapLength = prefixTable[overlapLength - 1] ?? 0
    }
  }

  return output.slice(overlapLength)
}

function RepositoryCatalogView({
  isLoading,
  repository,
  onSelect,
  onConfigure,
  onWorkspaceUpdate
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  onSelect: (repository: RepositoryRow) => Promise<void>
  onConfigure: () => void
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  if (isLoading) {
    return (
      <div
        className="repository-summary"
        role="status"
        aria-label="Repository catalog loading"
      >
        <p className="repository-status-title">Loading repositories</p>
        <p>Reading configured scan roots and explicit repositories.</p>
      </div>
    )
  }

  return (
    <div className="repository-catalog">
      <div className="repository-summary">
        <p className="repository-status-title">{repository.title}</p>
        <p>{repository.description}</p>
        <button className="configure-button" type="button" onClick={onConfigure}>
          <Settings aria-hidden="true" size={16} />
          <span>Configure</span>
        </button>
      </div>

      <RepositoryCreatePanel
        create={repository.create}
        onWorkspaceUpdate={onWorkspaceUpdate}
      />

      {repository.repositories.length > 0 ? (
        <div className="repository-list" aria-label="Configured repositories">
          {repository.repositories.map((row) => (
            <RepositoryRowButton
              isSelected={row.id === repository.selectedRepositoryId}
              key={row.id}
              repository={row}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      {repository.diagnostics.length > 0 ? (
        <div className="diagnostic-list" aria-label="Repository diagnostics">
          {repository.diagnostics.map((diagnostic) => (
            <CatalogDiagnosticRow
              diagnostic={diagnostic}
              key={`${diagnostic.code}:${diagnostic.configuredPath}:${diagnostic.resolvedPath}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RepositoryCreatePanel({
  create,
  onWorkspaceUpdate
}: {
  create: RepositoryCreateState
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [scanRootId, setScanRootId] = useState(create.scanRoots[0]?.id ?? '')
  const [name, setName] = useState('')
  const [githubEnabled, setGithubEnabled] = useState(false)
  const [visibility, setVisibility] = useState<GitHubVisibility>('private')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<{
    message: string
    repositoryName: string
  } | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const createButtonRef = useRef<HTMLButtonElement | null>(null)
  const scanRootSelectRef = useRef<HTMLSelectElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const isAvailable = create.available && create.scanRoots.length > 0

  useEffect(() => {
    if (!create.scanRoots.some((scanRoot) => scanRoot.id === scanRootId)) {
      setScanRootId(create.scanRoots[0]?.id ?? '')
    }
  }, [create.scanRoots, scanRootId])

  useEffect(() => {
    if (isOpen) {
      nameInputRef.current?.focus()
      return
    }

    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false
      createButtonRef.current?.focus()
    }
  }, [isOpen])

  function openCreateDialog(): void {
    if (!isAvailable) {
      return
    }

    shouldRestoreFocusRef.current = false
    setIsOpen(true)
  }

  function closeCreateDialog(): void {
    shouldRestoreFocusRef.current = true
    setName('')
    setScanRootId(create.scanRoots[0]?.id ?? '')
    setGithubEnabled(false)
    setVisibility('private')
    setLocalError(null)
    setIsOpen(false)
  }

  function focusFirstDialogElement(): void {
    scanRootSelectRef.current?.focus()
  }

  function focusLastDialogElement(): void {
    closeButtonRef.current?.focus()
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCreateDialog()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const firstElement = scanRootSelectRef.current
    const lastElement = closeButtonRef.current

    if (firstElement === null || lastElement === null) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      focusLastDialogElement()
      return
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      focusFirstDialogElement()
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setLocalError('Repository name is required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createRepository({
        scanRootId,
        name: trimmedName,
        github: {
          enabled: githubEnabled,
          visibility
        }
      })
      onWorkspaceUpdate(nextWorkspace)
      if (nextWorkspace.repository.create.error === null) {
        closeCreateDialog()
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRetry(retry: RepositoryRemoteRetryRecord): Promise<void> {
    setRetryingId(retry.id)
    setRetryError(null)
    try {
      const nextWorkspace = await window.grindstone.workspace.retryRepositoryRemote({
        retryId: retry.id
      })
      onWorkspaceUpdate(nextWorkspace)
    } catch (error: unknown) {
      setRetryError({
        message: getErrorMessage(error),
        repositoryName: retry.githubRepositoryName
      })
    } finally {
      setRetryingId(null)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <div className="repository-create">
      <button
        className="primary-action repository-create-launcher"
        disabled={!isAvailable}
        onClick={openCreateDialog}
        ref={createButtonRef}
        type="button"
      >
        <CirclePlus aria-hidden="true" size={16} />
        <span>Create repository</span>
      </button>

      {isOpen ? (
        <div className="modal-backdrop">
          <div
            aria-labelledby="repository-create-dialog-title"
            aria-modal="true"
            className="modal-dialog"
            onKeyDown={handleDialogKeyDown}
            role="dialog"
          >
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusLastDialogElement}
              tabIndex={0}
            />
            <div className="modal-header">
              <h2 id="repository-create-dialog-title">Create repository</h2>
            </div>

            <form
              aria-label="Create repository"
              className="repository-create-form"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <label className="field">
                <span>Scan root</span>
                <select
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setScanRootId(event.target.value)}
                  ref={scanRootSelectRef}
                  value={scanRootId}
                >
                  {create.scanRoots.length === 0 ? (
                    <option value="">No scan roots configured</option>
                  ) : (
                    create.scanRoots.map((scanRoot) => (
                      <option
                        key={scanRoot.id}
                        value={scanRoot.id}
                      >
                        {scanRoot.displayPath}
                      </option>
                    ))
                  )}
                </select>
              </label>

              <label className="field">
                <span>Repository name</span>
                <input
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="new-repo"
                  ref={nameInputRef}
                  type="text"
                  value={name}
                />
              </label>

              <label className="checkbox-field">
                <input
                  checked={githubEnabled}
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setGithubEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>Create on GitHub</span>
              </label>

              <label className="field">
                <span>GitHub visibility</span>
                <select
                  disabled={!isAvailable || !githubEnabled || isSubmitting}
                  onChange={(event) => setVisibility(event.target.value as GitHubVisibility)}
                  value={visibility}
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>

              {errorMessage !== null ? (
                <div
                  aria-label="Repository creation error"
                  className="create-error"
                  role="alert"
                >
                  {errorMessage}
                </div>
              ) : null}

              <div className="form-actions">
                <button
                  className="secondary-button"
                  disabled={isSubmitting}
                  onClick={closeCreateDialog}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                  <span>Cancel</span>
                </button>
                <button
                  className="primary-action"
                  disabled={!isAvailable || isSubmitting || name.trim() === ''}
                  type="submit"
                >
                  <CirclePlus aria-hidden="true" size={16} />
                  <span>{isSubmitting ? 'Creating' : 'Create repository'}</span>
                </button>
              </div>
            </form>
            <button
              aria-label="Close repository creation"
              className="icon-button modal-close-button"
              disabled={isSubmitting}
              onClick={closeCreateDialog}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusFirstDialogElement}
              tabIndex={0}
            />
          </div>
        </div>
      ) : null}

      {create.remoteRetries.length > 0 ? (
        <div
          aria-label="Repository remote retries"
          className="remote-retry-list"
        >
          {create.remoteRetries.map((retry) => (
            <RemoteRetryRow
              key={retry.id}
              retry={retry}
              isRetrying={retryingId === retry.id}
              onRetry={handleRetry}
            />
          ))}
        </div>
      ) : null}

      {retryError !== null ? (
        <div
          aria-label="Repository remote retry error"
          className="create-error"
          role="alert"
        >
          {retryError.repositoryName}: {retryError.message}
        </div>
      ) : null}
    </div>
  )
}

function RemoteRetryRow({
  retry,
  isRetrying,
  onRetry
}: {
  retry: RepositoryRemoteRetryRecord
  isRetrying: boolean
  onRetry: (retry: RepositoryRemoteRetryRecord) => Promise<void>
}): ReactElement {
  const isSucceeded = retry.status === 'succeeded'

  return (
    <div className="remote-retry-row">
      <GitBranch aria-hidden="true" size={16} />
      <span className="remote-retry-copy">
        <span className="remote-retry-name">{retry.githubRepositoryName}</span>
        <span className="remote-retry-status">
          {isSucceeded ? 'Remote setup succeeded' : retry.lastError}
        </span>
      </span>
      <button
        aria-label={`Retry remote for ${retry.githubRepositoryName}`}
        className="icon-action"
        disabled={isSucceeded || isRetrying}
        onClick={() => void onRetry(retry)}
        title={`Retry remote for ${retry.githubRepositoryName}`}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={15} />
      </button>
    </div>
  )
}

function RepositoryRowButton({
  isSelected,
  repository,
  onSelect
}: {
  isSelected: boolean
  repository: RepositoryRow
  onSelect: (repository: RepositoryRow) => Promise<void>
}): ReactElement {
  return (
    <button
      aria-pressed={isSelected}
      className="repository-row"
      onClick={() => void onSelect(repository)}
      type="button"
    >
      <span className="repository-row-main">
        <span className="repository-name">{repository.name}</span>
        <span className="repository-path">{repository.path}</span>
      </span>
      <span className="repository-sources">{repository.sources.join(', ')}</span>
    </button>
  )
}

function CatalogDiagnosticRow({
  diagnostic
}: {
  diagnostic: CatalogDiagnostic
}): ReactElement {
  return (
    <div className="diagnostic-row" role="alert">
      <span className="diagnostic-code">{diagnostic.code}</span>
      <span className="diagnostic-message">{diagnostic.message}</span>
      <span className="diagnostic-path">{diagnostic.configuredPath}</span>
    </div>
  )
}

function ContextHintsPanel({
  collapseButtonRef,
  workspace,
  onCollapse,
  onNewFlow
}: {
  collapseButtonRef: RefObject<HTMLButtonElement | null>
  workspace: InitialWorkspaceState
  onCollapse: () => void
  onNewFlow: () => void
}): ReactElement {
  return (
    <>
      <div className="pane-header">
        <Sparkles aria-hidden="true" size={18} />
        <h2 id="context-pane-title">Contextual Hints</h2>
        <button
          aria-controls={RIGHT_PANE_CONTENT_ID}
          aria-expanded="true"
          aria-label="Collapse right pane"
          className="icon-button context-toggle-button"
          ref={collapseButtonRef}
          title="Collapse right pane"
          type="button"
          onClick={onCollapse}
        >
          <PanelRightClose aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="hint-list">
        {workspace.hints.map((hint) => (
          <article className="hint-row" key={hint.id}>
            <h3>{hint.title}</h3>
            <p>{hint.description}</p>
          </article>
        ))}
      </div>

      <div className="shortcut-list" aria-label="Flow shortcuts">
        {workspace.shortcuts.map((shortcut) => (
          <button
            className="shortcut-button"
            disabled={shortcut.disabled}
            key={shortcut.id}
            onClick={shortcut.id === 'new-flow' ? onNewFlow : undefined}
            title={shortcut.description}
            type="button"
          >
            {shortcut.id === 'new-flow' ? (
              <CirclePlus aria-hidden="true" size={16} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}
            <span>{shortcut.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function ConfigEditorPanel({
  collapseButtonRef,
  config,
  loadError,
  onCancel,
  onCollapse,
  onReload,
  onSave
}: {
  collapseButtonRef: RefObject<HTMLButtonElement | null>
  config: EditableConfigState | null
  loadError: string | null
  onCancel: () => void
  onCollapse: () => void
  onReload: () => Promise<void>
  onSave: (input: CommonConfigUpdateInput) => Promise<ConfigSaveResult>
}): ReactElement {
  const [draft, setDraft] = useState<ConfigDraft>(() => createDraft(config))
  const [fieldErrors, setFieldErrors] = useState<ConfigFieldError[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const [showReloadAction, setShowReloadAction] = useState(false)

  useEffect(() => {
    setDraft(createDraft(config))
    setFieldErrors([])
  }, [config])

  const errorsByField = new Map(fieldErrors.map((error) => [error.field, error.message]))

  async function handleSave(): Promise<void> {
    if (config === null || loadError !== null) {
      return
    }

    setIsSaving(true)
    setStatusMessage(null)
    setFieldErrors([])

    try {
      const inputResult = createConfigInput(draft)
      if (!inputResult.ok) {
        setFieldErrors(inputResult.errors)
        setShowReloadAction(false)
        return
      }

      const result = await onSave(inputResult.input)
      setFieldErrors(result.errors)
      setStatusMessage(result.message ?? (result.errors.length === 0 ? 'Config saved' : null))
      setShowReloadAction(result.canReload)
    } catch (error: unknown) {
      setStatusMessage(getErrorMessage(error))
      setShowReloadAction(false)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleReload(): Promise<void> {
    setIsReloading(true)
    setStatusMessage(null)

    try {
      await onReload()
      setStatusMessage('Config reloaded')
      setShowReloadAction(false)
    } catch (error: unknown) {
      setStatusMessage(getErrorMessage(error))
      setShowReloadAction(true)
    } finally {
      setIsReloading(false)
    }
  }

  return (
    <>
      <div className="pane-header config-header">
        <Settings aria-hidden="true" size={18} />
        <h2 id="context-pane-title">Common Config</h2>
        <button
          aria-controls={RIGHT_PANE_CONTENT_ID}
          aria-expanded="true"
          aria-label="Collapse right pane"
          className="icon-button context-toggle-button"
          ref={collapseButtonRef}
          title="Collapse right pane"
          type="button"
          onClick={onCollapse}
        >
          <PanelRightClose aria-hidden="true" size={16} />
        </button>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close config">
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="config-panel">
        {loadError !== null ? (
          <div className="form-message error-message" role="alert">
            {loadError}
          </div>
        ) : null}

        {config === null && loadError === null ? (
          <div className="form-message" role="status">
            Loading config
          </div>
        ) : null}

        <PathListEditor
          label="Scan roots"
          fieldName="scan_roots"
          values={draft.scan_roots}
          errorsByField={errorsByField}
          onChange={(scanRoots) => setDraft({ ...draft, scan_roots: scanRoots })}
        />

        <PathListEditor
          label="Explicit repositories"
          fieldName="repos"
          values={draft.repos}
          errorsByField={errorsByField}
          onChange={(repos) => setDraft({ ...draft, repos })}
        />

        <label className="form-field">
          <span>Default agent</span>
          <select
            aria-label="Default agent"
            value={draft.default_agent}
            onChange={(event) =>
              setDraft({
                ...draft,
                default_agent: event.currentTarget.value as ConfigDraft['default_agent']
              })
            }
          >
            <option value="">No default</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
          <FieldError message={errorsByField.get('default_agent')} />
        </label>

        <label className="form-field">
          <span>Artifact root</span>
          <input
            aria-label="Artifact root"
            value={draft.artifact_root}
            onChange={(event) => setDraft({ ...draft, artifact_root: event.currentTarget.value })}
          />
          <FieldError message={errorsByField.get('artifact_root')} />
        </label>

        <BootstrapHookEditor
          hooks={draft.bootstrap_hooks}
          errorsByField={errorsByField}
        />

        {statusMessage !== null ? (
          <div className="form-message" role={fieldErrors.length > 0 ? 'alert' : 'status'}>
            {statusMessage}
          </div>
        ) : null}

        {showReloadAction ? (
          <button
            className="secondary-button reload-button"
            type="button"
            onClick={() => void handleReload()}
          >
            <RotateCcw aria-hidden="true" size={16} />
            <span>{isReloading ? 'Reloading config' : 'Reload config'}</span>
          </button>
        ) : null}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            <X aria-hidden="true" size={16} />
            <span>Cancel</span>
          </button>
          <button
            className="primary-button"
            disabled={config === null || loadError !== null || isSaving}
            type="button"
            onClick={() => void handleSave()}
          >
            <Save aria-hidden="true" size={16} />
            <span>{isSaving ? 'Saving' : 'Save'}</span>
          </button>
        </div>
      </div>
    </>
  )
}

function PathListEditor({
  label,
  fieldName,
  values,
  errorsByField,
  onChange
}: {
  label: string
  fieldName: 'scan_roots' | 'repos'
  values: string[]
  errorsByField: Map<string, string>
  onChange: (values: string[]) => void
}): ReactElement {
  const itemLabel = fieldName === 'scan_roots' ? 'Scan root' : 'Repository'

  return (
    <fieldset className="form-group">
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div className="list-field" key={`${fieldName}-${index}`}>
          <label className="form-field">
            <span>{`${itemLabel} ${index + 1}`}</span>
            <input
              aria-label={`${itemLabel} ${index + 1}`}
              value={value}
              onChange={(event) => {
                const nextValues = [...values]
                nextValues[index] = event.currentTarget.value
                onChange(nextValues)
              }}
            />
            <FieldError message={errorsByField.get(`${fieldName}[${index}]`)} />
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, currentIndex) => currentIndex !== index))}
          >
            <Trash2 aria-hidden="true" size={16} />
          </button>
        </div>
      ))}
      <button className="secondary-button" type="button" onClick={() => onChange([...values, ''])}>
        <Plus aria-hidden="true" size={16} />
        <span>{`Add ${itemLabel.toLowerCase()}`}</span>
      </button>
      <FieldError message={errorsByField.get(fieldName)} />
    </fieldset>
  )
}

function BootstrapHookEditor({
  hooks,
  errorsByField
}: {
  hooks: BootstrapHookDraft[]
  errorsByField: Map<string, string>
}): ReactElement {
  return (
    <fieldset className="form-group">
      <legend>Bootstrap hooks</legend>
      {hooks.map((hook, index) => (
        <div className="hook-editor" key={`hook-${index}`}>
          <div className="hook-header">
            <span>{`Hook ${index + 1}`}</span>
          </div>
          <HookField
            label={`Hook ${index + 1} command`}
            value={hook.command}
            error={errorsByField.get(`bootstrap_hooks[${index}].command`)}
          />
          <HookField
            label={`Hook ${index + 1} name`}
            value={hook.name}
            error={errorsByField.get(`bootstrap_hooks[${index}].name`)}
          />
          <HookField
            label={`Hook ${index + 1} cwd`}
            value={hook.cwd}
            error={errorsByField.get(`bootstrap_hooks[${index}].cwd`)}
          />
          <label className="form-field">
            <span>{`Hook ${index + 1} environment`}</span>
            <textarea
              aria-label={`Hook ${index + 1} environment`}
              readOnly
              value={hook.env}
            />
            <FieldError message={getFieldError(errorsByField, `bootstrap_hooks[${index}].env`)} />
          </label>
        </div>
      ))}
    </fieldset>
  )
}

function HookField({
  label,
  value,
  error
}: {
  label: string
  value: string
  error: string | undefined
}): ReactElement {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        aria-label={label}
        readOnly
        value={value}
      />
      <FieldError message={error} />
    </label>
  )
}

function FieldError({ message }: { message: string | undefined }): ReactElement | null {
  return message === undefined ? null : <span className="field-error">{message}</span>
}

function createDraft(config: EditableConfigState | null): ConfigDraft {
  return {
    scan_roots: config?.scan_roots ?? [],
    repos: config?.repos ?? [],
    default_agent: config?.default_agent ?? '',
    artifact_root: config?.artifact_root ?? '',
    bootstrap_hooks: (config?.bootstrap_hooks ?? []).map((hook) => ({
      sourceIndex: hook.sourceIndex,
      name: hook.name ?? '',
      command: hook.command,
      cwd: hook.cwd ?? '',
      env: formatEnv(hook.env)
    }))
  }
}

function createConfigInput(draft: ConfigDraft): ConfigInputResult {
  const errors: ConfigFieldError[] = []
  const bootstrapHooks = draft.bootstrap_hooks.map((hook, index) => {
    const nextHook: EditableBootstrapHook = {
      command: hook.command
    }

    if (hook.sourceIndex !== undefined) {
      nextHook.sourceIndex = hook.sourceIndex
    }

    if (hook.name.trim() !== '') {
      nextHook.name = hook.name
    }

    if (hook.cwd.trim() !== '') {
      nextHook.cwd = hook.cwd
    }

    const parsedEnv = parseEnv(hook.env, `bootstrap_hooks[${index}].env`)
    if (!parsedEnv.ok) {
      errors.push(...parsedEnv.errors)
    } else if (Object.keys(parsedEnv.env).length > 0) {
      nextHook.env = parsedEnv.env
    }

    return nextHook
  })

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    }
  }

  return {
    ok: true,
    input: {
      scan_roots: draft.scan_roots,
      repos: draft.repos,
      default_agent: draft.default_agent === '' ? null : draft.default_agent,
      artifact_root: draft.artifact_root.trim() === '' ? null : draft.artifact_root,
      bootstrap_hooks: bootstrapHooks
    }
  }
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (env === undefined) {
    return ''
  }

  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function parseEnv(
  value: string,
  field: string
): { ok: true; env: Record<string, string> } | { ok: false; errors: ConfigFieldError[] } {
  const env: Record<string, string> = {}
  const errors: ConfigFieldError[] = []

  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .forEach((line) => {
      const separatorIndex = line.indexOf('=')
      if (separatorIndex <= 0) {
        errors.push({
          field,
          message: 'Environment lines must use KEY=value.'
        })
        return
      }

      env[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1)
    })

  return errors.length === 0 ? { ok: true, env } : { ok: false, errors }
}

function getFieldError(errorsByField: Map<string, string>, field: string): string | undefined {
  return errorsByField.get(field) ??
    [...errorsByField.entries()].find(([errorField]) => errorField.startsWith(`${field}.`))?.[1]
}

function getRendererPath(): string {
  if (window.location.protocol === 'file:') {
    return '/'
  }

  if (window.location.pathname.endsWith('/index.html')) {
    return '/'
  }

  return window.location.pathname || '/'
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }

  return 'Unable to load Flow workspace'
}

function FlowWorkspaceStateView({
  createOpenRequest,
  state,
  onWorkspaceUpdate
}: {
  createOpenRequest: number
  state: FlowPaneState
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  if (state.status === 'loading') {
    const title = state.repositoryName === undefined
      ? 'Loading Flow workspace'
      : `Loading ${state.repositoryName} Flows`
    const description = state.repositoryName === undefined
      ? 'Preparing the Flow-only workspace surface.'
      : `Reading Flow artifacts for ${state.repositoryName}.`

    return (
      <div
        className="state-block"
        role="status"
        aria-label="Flow workspace loading"
      >
        <p className="eyebrow">Flow</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        className="state-block error-block"
        role="alert"
        aria-label="Flow workspace error"
      >
        <p className="eyebrow">Flow</p>
        <h2>Flow workspace unavailable</h2>
        <p>{state.message}</p>
      </div>
    )
  }

  if (state.status === 'ready') {
    return (
      <div className="flow-list-view">
        <FlowCreatePanel
          create={state.create}
          openRequest={createOpenRequest}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />

        <div className="flow-list-header">
          <p className="eyebrow">Flow</p>
          <h2>{state.repositoryName} Flows</h2>
          <p>{state.flows.length} {state.flows.length === 1 ? 'Flow' : 'Flows'} found.</p>
        </div>

        <FlowRecordTable
          flows={state.flows}
          onWorkspaceUpdate={onWorkspaceUpdate}
          repositoryName={state.repositoryName}
        />
      </div>
    )
  }

  return (
    <div className="empty-flow-view">
      {state.create === undefined ? null : (
        <FlowCreatePanel
          create={state.create}
          openRequest={createOpenRequest}
          onWorkspaceUpdate={onWorkspaceUpdate}
        />
      )}
      <div className="state-block">
        <p className="eyebrow">Flow</p>
        <h2>{state.title}</h2>
        <p>{state.description}</p>
      </div>
    </div>
  )
}

function FlowRecordTable({
  flows,
  onWorkspaceUpdate,
  repositoryName
}: {
  flows: FlowListRow[]
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  repositoryName: string
}): ReactElement {
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null)
  const [planViews, setPlanViews] = useState<Record<string, FlowPlanViewState>>({})

  async function handlePlanOpen(flow: FlowListRow): Promise<void> {
    if (flow.planId === undefined) {
      return
    }

    const current = planViews[flow.id]
    if (current?.status === 'ready' || current?.status === 'missing' || current?.status === 'corrupt') {
      setPlanViews((views) => {
        const nextViews = { ...views }
        delete nextViews[flow.id]
        return nextViews
      })
      return
    }

    setPlanViews((views) => ({
      ...views,
      [flow.id]: { status: 'loading', planId: flow.planId ?? '' }
    }))

    try {
      const response = await window.grindstone.workspace.readFlowPlan({ flowId: flow.id })
      setPlanViews((views) => ({
        ...views,
        [flow.id]: toFlowPlanViewState(flow.planId ?? '', response)
      }))
    } catch (error: unknown) {
      setPlanViews((views) => ({
        ...views,
        [flow.id]: {
          status: 'missing',
          planId: flow.planId ?? '',
          message: getErrorMessage(error)
        }
      }))
    }
  }

  return (
    <div className="flow-table-wrap">
      <table className="flow-table" aria-label={`${repositoryName} Flow records`}>
        <thead>
          <tr>
            <th scope="col">Flow</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">Branch</th>
            <th scope="col">Plan</th>
            <th scope="col">Phases</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow) => {
            const details = formatFlowTooltip(flow)
            const detailsId = `flow-details-${flow.id}`
            const planDetailsId = `flow-plan-${flow.id}`
            const isExpanded = expandedFlowId === flow.id
            const planView = planViews[flow.id]

            return (
              <Fragment key={flow.id}>
                <tr>
                  <td>
                    <span className="flow-title-cell">
                      <button
                        aria-controls={detailsId}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${flow.title} details`}
                        className="flow-disclosure-button"
                        onClick={() => setExpandedFlowId(isExpanded ? null : flow.id)}
                        title={details}
                        type="button"
                      >
                        {isExpanded ? (
                          <ChevronDown aria-hidden="true" size={14} />
                        ) : (
                          <ChevronRight aria-hidden="true" size={14} />
                        )}
                      </button>
                      <span className="flow-title">{flow.title}</span>
                    </span>
                  </td>
                  <td>
                    <span className="flow-status">{flow.status}</span>
                    {flow.failure === undefined ? null : (
                      <span className="flow-failure-summary">
                        {formatFailureSummary(flow.failure)}
                      </span>
                    )}
                  </td>
                  <td>{flow.updatedAt}</td>
                  <td>
                    {flow.branch === undefined ? '-' : flow.branch}
                  </td>
                  <td>
                    {flow.planId === undefined ? '-' : (
                      <button
                        aria-controls={planDetailsId}
                        aria-expanded={planView !== undefined}
                        aria-label={`Open plan ${flow.planId} for ${flow.title}`}
                        className="flow-plan-button"
                        onClick={() => void handlePlanOpen(flow)}
                        type="button"
                      >
                        {flow.planId}
                      </button>
                    )}
                  </td>
                  <td>
                    {formatPhaseSummary(flow)}
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="flow-detail-row">
                    <td colSpan={6}>
                      <div
                        className="flow-detail-panel"
                        id={detailsId}
                        role="region"
                        aria-label={`${flow.title} details`}
                      >
                        <FlowDetailBadges details={details} />
                        <FlowPhaseTree
                          flow={flow}
                          onWorkspaceUpdate={onWorkspaceUpdate}
                        />
                      </div>
                    </td>
                  </tr>
                ) : null}
                {planView === undefined ? null : (
                  <tr className="flow-detail-row">
                    <td colSpan={6}>
                      <FlowPlanPanel
                        flow={flow}
                        id={planDetailsId}
                        view={planView}
                      />
                    </td>
                  </tr>
                )}
                {flow.terminals !== undefined && flow.terminals.length > 0 ? (
                  <tr className="flow-terminal-row">
                    <td colSpan={6}>
                      <FlowTerminalTabs
                        flow={flow}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FlowDetailBadges({ details }: { details: string }): ReactElement {
  return (
    <div className="flow-detail-badges">
      {details
        .split('\n')
        .filter((line) => !line.startsWith('Phase: '))
        .map((line, index) => (
          <span key={`${index}:${line}`}>{line}</span>
        ))}
    </div>
  )
}

function FlowPhaseTree({
  flow,
  onWorkspaceUpdate
}: {
  flow: FlowListRow
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement | null {
  if (flow.phases === undefined || flow.phases.length === 0) {
    return null
  }

  const childrenByParent = new Map<string, FlowPhaseSummary[]>()
  for (const phase of flow.phases) {
    if (phase.parentPhaseId === undefined) {
      continue
    }
    childrenByParent.set(phase.parentPhaseId, [
      ...(childrenByParent.get(phase.parentPhaseId) ?? []),
      phase
    ])
  }

  const topLevel = flow.phases
    .filter((phase) => phase.parentPhaseId === undefined)
    .sort((left, right) => left.order - right.order)

  return (
    <div className="phase-tree" aria-label={`${flow.title} phase tree`}>
      {topLevel.map((phase) => (
        <FlowPhaseNode
          childrenByParent={childrenByParent}
          flow={flow}
          key={phase.id}
          level={0}
          onWorkspaceUpdate={onWorkspaceUpdate}
          phase={phase}
        />
      ))}
    </div>
  )
}

function FlowPhaseNode({
  childrenByParent,
  flow,
  level,
  onWorkspaceUpdate,
  phase
}: {
  childrenByParent: Map<string, FlowPhaseSummary[]>
  flow: FlowListRow
  level: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  phase: FlowPhaseSummary
}): ReactElement {
  const children = (childrenByParent.get(phase.id) ?? [])
    .sort((left, right) => left.order - right.order)

  return (
    <div className="phase-tree-node">
      <FlowPhaseRow
        flow={flow}
        level={level}
        onWorkspaceUpdate={onWorkspaceUpdate}
        phase={phase}
      />
      {children.length > 0 ? (
        <div className="phase-tree-children">
          {children.map((child) => (
            <FlowPhaseNode
              childrenByParent={childrenByParent}
              flow={flow}
              key={child.id}
              level={level + 1}
              onWorkspaceUpdate={onWorkspaceUpdate}
              phase={child}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FlowPhaseRow({
  flow,
  level,
  onWorkspaceUpdate,
  phase
}: {
  flow: FlowListRow
  level: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
  phase: FlowPhaseSummary
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false)
  const [title, setTitle] = useState(phase.title)
  const [order, setOrder] = useState(String(phase.order))
  const [notes, setNotes] = useState(phase.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingAction, setPendingAction] = useState<
    'launch' | 'manual' | 'complete' | 'human-review' | 'merge' | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [manualAction, setManualAction] = useState<FlowPhaseManualAction | null>(null)
  const [manualNotes, setManualNotes] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [prDraft, setPrDraft] = useState<PullRequestDraft>(() => createPullRequestDraft(flow))
  const [prError, setPrError] = useState<string | null>(null)
  const [humanReviewNotes, setHumanReviewNotes] = useState(flow.humanReview?.notes ?? '')
  const [humanReviewError, setHumanReviewError] = useState<string | null>(null)
  const [mergeCommit, setMergeCommit] = useState(flow.merge.status === 'merged' ? flow.merge.commit : '')
  const [mergeNotes, setMergeNotes] = useState(flow.merge.status === 'blocked' ? flow.merge.notes : '')
  const [mergeError, setMergeError] = useState<string | null>(null)
  const canEdit = phase.generated === true &&
    phase.editable === true &&
    (phase.status === 'pending' || phase.status === 'ready')
  const isExecutablePhase = isExecutableWorkspacePhase(phase)
  const canLaunch = isExecutablePhase &&
    (phase.status === 'ready' || phase.status === 'needs_attention')
  const canComplete = isExecutablePhase &&
    phase.status === 'running' &&
    (phase.id !== 'implementation' || implementationChildrenCanComplete(flow.phases ?? []))
  const manualActions = phase.manualActions ?? []
  const canRecordPr = isPrCreationPhase(phase) &&
    (phase.status === 'ready' || phase.status === 'running')
  const canRecordHumanReview = isHumanReviewPhase(phase) &&
    flow.pr !== undefined &&
    flow.merge.status !== 'merged' &&
    isHumanReviewPhaseActionable(phase)
  const showHumanReviewPanel = isHumanReviewPhase(phase) && flow.pr !== undefined
  const showMergePanel = showHumanReviewPanel && flow.humanReview?.outcome === 'approved'
  const canRecordMerge = showMergePanel && flow.merge.status !== 'merged'

  useEffect(() => {
    if (!isEditing) {
      setTitle(phase.title)
      setOrder(String(phase.order))
      setNotes(phase.notes ?? '')
      setError(null)
    }
  }, [isEditing, phase.notes, phase.order, phase.title])

  useEffect(() => {
    setActionError(null)
    setManualError(null)
    setPrError(null)
    setHumanReviewError(null)
    setMergeError(null)
    setManualAction(null)
    setManualNotes('')
  }, [phase.id, phase.status])

  useEffect(() => {
    setPrDraft(createPullRequestDraft(flow))
    setHumanReviewNotes(flow.humanReview?.notes ?? '')
    setMergeCommit(flow.merge.status === 'merged' ? flow.merge.commit : '')
    setMergeNotes(flow.merge.status === 'blocked' ? flow.merge.notes : '')
  }, [flow])

  async function handleSave(): Promise<void> {
    const parsedOrder = Number(order)
    if (title.trim() === '') {
      setError('Phase title cannot be empty.')
      return
    }
    if (!Number.isInteger(parsedOrder)) {
      setError('Phase order must be an integer.')
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const workspace = await window.grindstone.workspace.updateFlowPhase({
        flowId: flow.id,
        phaseId: phase.id,
        title: title.trim(),
        order: parsedOrder,
        notes
      })
      onWorkspaceUpdate(workspace)
      setIsEditing(false)
    } catch (saveError: unknown) {
      setError(getErrorMessage(saveError))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleLaunch(): Promise<void> {
    setPendingAction('launch')
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.launchFlowPhase({
        flowId: flow.id,
        phaseId: phase.id
      })
      onWorkspaceUpdate(workspace)
    } catch (launchError: unknown) {
      setActionError(getErrorMessage(launchError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleComplete(): Promise<void> {
    setPendingAction('complete')
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.completeFlowPhase({
        flowId: flow.id,
        phaseId: phase.id
      })
      onWorkspaceUpdate(workspace)
    } catch (completeError: unknown) {
      setActionError(getErrorMessage(completeError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleManualAction(action: FlowPhaseManualActionAffordance): Promise<void> {
    const trimmedNotes = manualNotes.trim()
    if (action.requiresNotes && trimmedNotes === '') {
      setManualError(`${action.label} notes are required.`)
      return
    }

    setPendingAction('manual')
    setManualError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.manualUpdateFlowPhase({
        flowId: flow.id,
        phaseId: phase.id,
        action: action.action,
        notes: trimmedNotes === '' ? undefined : trimmedNotes
      })
      onWorkspaceUpdate(workspace)
      setManualAction(null)
      setManualNotes('')
    } catch (manualActionError: unknown) {
      setManualError(getErrorMessage(manualActionError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordPullRequest(): Promise<void> {
    const request = createRecordPullRequestRequest(flow.id, prDraft)
    if (!request.ok) {
      setPrError(request.message)
      return
    }

    setPendingAction('complete')
    setPrError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowPullRequest(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordHumanReview(outcome: FlowHumanReviewOutcome): Promise<void> {
    const request = createRecordHumanReviewRequest(flow.id, outcome, humanReviewNotes)
    if (!request.ok) {
      setHumanReviewError(request.message)
      return
    }

    setPendingAction('human-review')
    setHumanReviewError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowHumanReview(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleRecordMerge(status: 'merged' | 'blocked'): Promise<void> {
    const request = createRecordMergeRequest(flow.id, status, {
      commit: mergeCommit,
      notes: mergeNotes
    })
    if (!request.ok) {
      setMergeError(request.message)
      return
    }

    setPendingAction('merge')
    setMergeError(null)
    setActionError(null)
    try {
      const workspace = await window.grindstone.workspace.recordFlowMerge(request.request)
      onWorkspaceUpdate(workspace)
    } catch (recordError: unknown) {
      setActionError(getErrorMessage(recordError))
    } finally {
      setPendingAction(null)
    }
  }

  if (isEditing) {
    return (
      <form
        aria-label={`Edit ${phase.title}`}
        className="phase-edit-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
        style={{ marginLeft: `${level * 18}px` }}
      >
        <label className="phase-edit-field">
          <span>Phase title</span>
          <input
            aria-label="Phase title"
            disabled={isSaving}
            onChange={(event) => setTitle(event.currentTarget.value)}
            value={title}
          />
        </label>
        <label className="phase-edit-field phase-order-field">
          <span>Order</span>
          <input
            aria-label="Order"
            disabled={isSaving}
            onChange={(event) => setOrder(event.currentTarget.value)}
            value={order}
          />
        </label>
        <label className="phase-edit-field phase-notes-field">
          <span>Notes</span>
          <textarea
            aria-label="Notes"
            disabled={isSaving}
            onChange={(event) => setNotes(event.currentTarget.value)}
            value={notes}
          />
        </label>
        {error === null ? null : (
          <div className="phase-edit-error" role="alert">
            {error}
          </div>
        )}
        <div className="phase-edit-actions">
          <button
            className="secondary-button"
            disabled={isSaving}
            onClick={() => setIsEditing(false)}
            type="button"
          >
            <X aria-hidden="true" size={15} />
            <span>Cancel</span>
          </button>
          <button
            className="primary-button"
            disabled={isSaving}
            type="submit"
          >
            <Save aria-hidden="true" size={15} />
            <span>{isSaving ? 'Saving' : 'Save'}</span>
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="phase-row-wrap">
      <div
        className={canLaunch
          ? 'phase-tree-row phase-tree-row-with-leading-action'
          : 'phase-tree-row'}
        style={{ marginLeft: `${level * 18}px` }}
      >
        {canLaunch ? (
          <button
            aria-label={`Launch ${phase.title}`}
            className="icon-button phase-action-button"
            disabled={pendingAction !== null}
            onClick={() => void handleLaunch()}
            title={`Launch ${phase.title}`}
            type="button"
          >
            <Play aria-hidden="true" size={14} />
          </button>
        ) : null}
        <span className="phase-tree-copy">
          <span>{formatPhaseDetail(phase)}</span>
          {phase.notes === undefined ? null : (
            <span className="phase-tree-notes">{phase.notes}</span>
          )}
        </span>
        <span className="phase-tree-actions">
          {canComplete ? (
            <button
              aria-label={`Complete ${phase.title}`}
              className="icon-button phase-action-button"
              disabled={pendingAction !== null}
              onClick={() => void handleComplete()}
              title={`Complete ${phase.title}`}
              type="button"
            >
              <Check aria-hidden="true" size={14} />
            </button>
          ) : null}
          {manualActions.map((action) => (
            <button
              aria-label={`${action.label} ${phase.title}`}
              className="icon-button phase-action-button"
              disabled={pendingAction !== null}
              key={action.action}
              onClick={() => {
                setManualAction((openAction) => openAction === action.action ? null : action.action)
                setManualError(null)
                setActionError(null)
                setManualNotes('')
              }}
              title={`${action.label} ${phase.title}`}
              type="button"
            >
              <ManualActionIcon action={action.action} />
            </button>
          ))}
          {canEdit ? (
            <button
              className="secondary-button phase-edit-button"
              disabled={pendingAction !== null}
              onClick={() => setIsEditing(true)}
              type="button"
            >
              <span>Edit</span>
            </button>
          ) : null}
        </span>
      </div>
      {manualAction === null ? null : (
        <form
          aria-label={`${getManualActionAffordance(manualActions, manualAction)?.label ?? 'Manual update'} ${phase.title}`}
          className="phase-skip-form"
          onSubmit={(event) => {
            event.preventDefault()
            const action = getManualActionAffordance(manualActions, manualAction)
            if (action !== undefined) {
              void handleManualAction(action)
            }
          }}
          style={{ marginLeft: `${level * 18}px` }}
        >
          <label className="phase-edit-field phase-notes-field">
            <span>{getManualActionAffordance(manualActions, manualAction)?.label ?? 'Manual update'} notes for {phase.title}</span>
            <textarea
              aria-label={`${getManualActionAffordance(manualActions, manualAction)?.label ?? 'Manual update'} notes for ${phase.title}`}
              disabled={pendingAction === 'manual'}
              onChange={(event) => setManualNotes(event.currentTarget.value)}
              value={manualNotes}
            />
          </label>
          {manualError === null ? null : (
            <div className="phase-edit-error" role="alert">
              {manualError}
            </div>
          )}
          <div className="phase-edit-actions">
            <button
              className="secondary-button"
              disabled={pendingAction === 'manual'}
              onClick={() => {
                setManualAction(null)
                setManualError(null)
                setManualNotes('')
              }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
              <span>Cancel</span>
            </button>
            <button
              className="primary-button"
              disabled={pendingAction === 'manual'}
              type="submit"
            >
              <ManualActionIcon action={manualAction} size={15} />
              <span>
                {pendingAction === 'manual'
                  ? `${getManualActionAffordance(manualActions, manualAction)?.label ?? 'Updating'}`
                  : `${getManualActionAffordance(manualActions, manualAction)?.label ?? 'Update'} phase`}
              </span>
            </button>
          </div>
        </form>
      )}
      {canRecordPr ? (
        <form
          aria-label={`Record PR for ${flow.title}`}
          className="phase-pr-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleRecordPullRequest()
          }}
          style={{ marginLeft: `${level * 18}px` }}
        >
          <label className="phase-edit-field">
            <span>PR number</span>
            <input
              aria-label="PR number"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, number: event.currentTarget.value })}
              value={prDraft.number}
            />
          </label>
          <label className="phase-edit-field">
            <span>PR URL</span>
            <input
              aria-label="PR URL"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, url: event.currentTarget.value })}
              value={prDraft.url}
            />
          </label>
          <label className="phase-edit-field">
            <span>Head branch</span>
            <input
              aria-label="Head branch"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, head: event.currentTarget.value })}
              value={prDraft.head}
            />
          </label>
          <label className="phase-edit-field">
            <span>Base branch</span>
            <input
              aria-label="Base branch"
              disabled={pendingAction === 'complete'}
              onChange={(event) => setPrDraft({ ...prDraft, base: event.currentTarget.value })}
              value={prDraft.base}
            />
          </label>
          <label className="phase-edit-field">
            <span>Status</span>
            <select
              aria-label="Status"
              disabled={pendingAction === 'complete'}
              onChange={(event) =>
                setPrDraft({
                  ...prDraft,
                  status: event.currentTarget.value as FlowPullRequestStatus
                })
              }
              value={prDraft.status}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="merged">Merged</option>
            </select>
          </label>
          {prError === null ? null : (
            <div className="phase-edit-error" role="alert">
              {prError}
            </div>
          )}
          <div className="phase-edit-actions">
            <button
              className="primary-button"
              disabled={pendingAction === 'complete'}
              type="submit"
            >
              <Check aria-hidden="true" size={15} />
              <span>{pendingAction === 'complete' ? 'Recording' : 'Record PR'}</span>
            </button>
          </div>
        </form>
      ) : null}
      {showHumanReviewPanel ? (
        <div
          aria-label={`Human Review for ${flow.title}`}
          className="phase-human-review-panel"
          role="region"
          style={{ marginLeft: `${level * 18}px` }}
        >
          <div className="phase-review-summary">
            <span>GitHub PR #{flow.pr?.number}</span>
            <a href={flow.pr?.url} rel="noreferrer" target="_blank">
              {flow.pr?.head} to {flow.pr?.base}
            </a>
            <span>{flow.pr?.status}</span>
          </div>
          {flow.humanReview === undefined ? null : (
            <div className="phase-review-summary">
              <span>Review {formatHumanReviewOutcome(flow.humanReview.outcome)}</span>
              <span>{flow.humanReview.reviewed_at}</span>
              {flow.humanReview.notes === undefined ? null : <span>{flow.humanReview.notes}</span>}
            </div>
          )}
          {canRecordHumanReview ? (
            <>
              <label className="phase-edit-field phase-notes-field">
                <span>Review notes</span>
                <textarea
                  aria-label="Review notes"
                  disabled={pendingAction === 'human-review'}
                  onChange={(event) => setHumanReviewNotes(event.currentTarget.value)}
                  value={humanReviewNotes}
                />
              </label>
              {humanReviewError === null ? null : (
                <div className="phase-edit-error" role="alert">
                  {humanReviewError}
                </div>
              )}
              <div className="phase-edit-actions">
                <button
                  className="primary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('approved')}
                  type="button"
                >
                  <Check aria-hidden="true" size={15} />
                  <span>Approve</span>
                </button>
                <button
                  className="secondary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('changes_requested')}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                  <span>Request changes</span>
                </button>
                <button
                  className="secondary-button"
                  disabled={pendingAction === 'human-review'}
                  onClick={() => void handleRecordHumanReview('blocked')}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                  <span>Block</span>
                </button>
              </div>
            </>
          ) : null}
          {showMergePanel ? (
            <div
              className="phase-merge-panel"
              aria-label={`Merge metadata for ${flow.title}`}
              role="region"
            >
              {flow.merge.status === 'merged' ? (
                <div className="phase-review-summary">
                  <span>Merged</span>
                  <span>{flow.merge.commit}</span>
                  <span>{flow.merge.merged_at}</span>
                </div>
              ) : (
                <>
                  {flow.merge.status === 'blocked' ? (
                    <div className="phase-review-summary">
                      <span>Merge blocked</span>
                      <span>{flow.merge.notes}</span>
                      <span>{flow.merge.updated_at}</span>
                    </div>
                  ) : null}
                  {canRecordMerge ? (
                    <>
                      <label className="phase-edit-field">
                        <span>Merge commit</span>
                        <input
                          aria-label="Merge commit"
                          disabled={pendingAction === 'merge'}
                          onChange={(event) => setMergeCommit(event.currentTarget.value)}
                          value={mergeCommit}
                        />
                      </label>
                      <label className="phase-edit-field phase-notes-field">
                        <span>Merge block notes</span>
                        <textarea
                          aria-label="Merge block notes"
                          disabled={pendingAction === 'merge'}
                          onChange={(event) => setMergeNotes(event.currentTarget.value)}
                          value={mergeNotes}
                        />
                      </label>
                      {mergeError === null ? null : (
                        <div className="phase-edit-error" role="alert">
                          {mergeError}
                        </div>
                      )}
                      <div className="phase-edit-actions">
                        <button
                          className="primary-button"
                          disabled={pendingAction === 'merge'}
                          onClick={() => void handleRecordMerge('merged')}
                          type="button"
                        >
                          <Check aria-hidden="true" size={15} />
                          <span>Record merge</span>
                        </button>
                        <button
                          className="secondary-button"
                          disabled={pendingAction === 'merge'}
                          onClick={() => void handleRecordMerge('blocked')}
                          type="button"
                        >
                          <X aria-hidden="true" size={15} />
                          <span>Block merge</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {actionError === null ? null : (
        <div
          className="phase-edit-error phase-action-error"
          role="alert"
          style={{ marginLeft: `${level * 18}px` }}
        >
          {actionError}
        </div>
      )}
    </div>
  )
}

function ManualActionIcon({
  action,
  size = 14
}: {
  action: FlowPhaseManualAction
  size?: number
}): ReactElement {
  if (action === 'restart') {
    return <RotateCcw aria-hidden="true" size={size} />
  }
  if (action === 'skip') {
    return <SkipForward aria-hidden="true" size={size} />
  }
  if (action === 'needs_attention') {
    return <Info aria-hidden="true" size={size} />
  }
  return <X aria-hidden="true" size={size} />
}

function getManualActionAffordance(
  actions: FlowPhaseManualActionAffordance[],
  action: FlowPhaseManualAction
): FlowPhaseManualActionAffordance | undefined {
  return actions.find((candidate) => candidate.action === action)
}

function implementationChildrenCanComplete(phases: FlowPhaseSummary[]): boolean {
  return phases
    .filter(isImplementationChildPhase)
    .every((phase) =>
      phase.status === 'completed' ||
        (phase.status === 'skipped' && phase.notes !== undefined && phase.notes.trim() !== '')
    )
}

function isExecutableWorkspacePhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'implementation' ||
    isImplementationChildPhase(phase) ||
    phase.kind === 'review_loop'
}

function isPrCreationPhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'pr-creation'
}

function isHumanReviewPhase(phase: FlowPhaseSummary): boolean {
  return phase.id === 'human-review'
}

function isHumanReviewPhaseActionable(phase: FlowPhaseSummary): boolean {
  return phase.status === 'ready' ||
    phase.status === 'running' ||
    phase.status === 'needs_attention' ||
    phase.status === 'blocked' ||
    phase.status === 'completed'
}

function isImplementationChildPhase(phase: FlowPhaseSummary): boolean {
  return phase.parentPhaseId === 'implementation' &&
    (phase.kind === 'implementation_child' || (phase.generated === true && phase.editable === true))
}

function createPullRequestDraft(flow: FlowListRow): PullRequestDraft {
  return {
    number: flow.pr?.number === undefined ? '' : String(flow.pr.number),
    url: flow.pr?.url ?? '',
    head: flow.pr?.head ?? flow.branch ?? '',
    base: flow.pr?.base ?? flow.baseRef ?? 'main',
    status: flow.pr?.status ?? 'open'
  }
}

function createRecordPullRequestRequest(
  flowId: string,
  draft: PullRequestDraft
): { ok: true; request: RecordFlowPullRequestRequest } | { ok: false; message: string } {
  const number = Number(draft.number)
  const url = draft.url.trim()
  const head = draft.head.trim()
  const base = draft.base.trim()

  if (draft.number.trim() === '' || !Number.isInteger(number) || number <= 0) {
    return { ok: false, message: 'PR number must be a positive integer.' }
  }
  if (!isHttpsUrl(url)) {
    return { ok: false, message: 'PR URL must be a valid HTTPS URL.' }
  }
  if (head === '') {
    return { ok: false, message: 'Head branch is required.' }
  }
  if (base === '') {
    return { ok: false, message: 'Base branch is required.' }
  }

  return {
    ok: true,
    request: {
      flowId,
      pr: {
        provider: 'github',
        number,
        url,
        head,
        base,
        status: draft.status
      },
      summary: `Recorded GitHub PR #${number}.`
    }
  }
}

function createRecordHumanReviewRequest(
  flowId: string,
  outcome: FlowHumanReviewOutcome,
  notes: string
): { ok: true; request: RecordFlowHumanReviewRequest } | { ok: false; message: string } {
  const trimmedNotes = notes.trim()
  if ((outcome === 'changes_requested' || outcome === 'blocked') && trimmedNotes === '') {
    return { ok: false, message: 'Review notes are required.' }
  }

  return {
    ok: true,
    request: {
      flowId,
      outcome,
      notes: trimmedNotes === '' ? undefined : trimmedNotes
    }
  }
}

function createRecordMergeRequest(
  flowId: string,
  status: 'merged' | 'blocked',
  draft: { commit: string; notes: string }
): { ok: true; request: RecordFlowMergeRequest } | { ok: false; message: string } {
  if (status === 'blocked') {
    const notes = draft.notes.trim()
    if (notes === '') {
      return { ok: false, message: 'Merge block notes are required.' }
    }
    return {
      ok: true,
      request: {
        flowId,
        status: 'blocked',
        notes
      }
    }
  }

  const commit = draft.commit.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, message: 'Merge commit must be a full 40-character hex object id.' }
  }
  return {
    ok: true,
    request: {
      flowId,
      status: 'merged',
      commit
    }
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function formatHumanReviewOutcome(outcome: FlowHumanReviewOutcome): string {
  if (outcome === 'changes_requested') {
    return 'changes requested'
  }
  return outcome
}

type FlowPlanViewState =
  | { status: 'loading'; planId: string }
  | { status: 'ready'; planId: string; title: string; body: string }
  | { status: 'missing' | 'corrupt'; planId: string; message: string }

function FlowPlanPanel({
  flow,
  id,
  view
}: {
  flow: FlowListRow
  id: string
  view: FlowPlanViewState
}): ReactElement {
  switch (view.status) {
    case 'loading':
      return (
        <div className="flow-detail-panel" id={id} role="status" aria-label={`${flow.title} linked plan`}>
          <span>Loading linked plan {view.planId}</span>
        </div>
      )
    case 'missing':
    case 'corrupt':
      return (
        <div className="flow-detail-panel" id={id} role="alert" aria-label={`${flow.title} linked plan`}>
          <span>{view.status === 'missing' ? 'Linked plan missing' : 'Linked plan corrupt'}</span>
          <span>{view.message}</span>
        </div>
      )
    case 'ready':
      return (
        <div className="flow-detail-panel flow-plan-panel" id={id} role="region" aria-label={`${flow.title} linked plan`}>
          <span>Plan: {view.title}</span>
          <pre>{view.body}</pre>
        </div>
      )
  }
}

function toFlowPlanViewState(planId: string, response: LinkedFlowPlanResponse): FlowPlanViewState {
  if (response.status === 'ready') {
    return {
      status: 'ready',
      planId,
      title: response.metadata.title,
      body: response.body
    }
  }

  return {
    status: response.status,
    planId,
    message: response.message
  }
}

function FlowTerminalTabs({ flow }: { flow: FlowListRow }): ReactElement {
  const visibleTerminals = (flow.terminals ?? []).filter((terminal) => terminal.status !== 'dismissed')
  const [activeTerminalId, setActiveTerminalId] = useState(visibleTerminals[0]?.terminalId ?? '')
  const [input, setInput] = useState('')
  const [terminalSize, setTerminalSize] = useState<{ columns: number; rows: number } | null>(null)
  const activeTerminal = visibleTerminals.find((terminal) =>
    terminal.terminalId === activeTerminalId
  ) ?? visibleTerminals[0]

  useEffect(() => {
    if (!visibleTerminals.some((terminal) => terminal.terminalId === activeTerminalId)) {
      setActiveTerminalId(visibleTerminals[0]?.terminalId ?? '')
    }
  }, [activeTerminalId, visibleTerminals])

  useEffect(() => {
    setTerminalSize(null)
  }, [activeTerminal?.terminalId])

  if (activeTerminal === undefined) {
    return (
      <div className="terminal-panel" aria-label={`${flow.title} terminal sessions`}>
        <span className="terminal-empty">No visible terminal sessions</span>
      </div>
    )
  }

  const terminalRequest = {
    repositoryId: flow.repositoryId,
    flowId: flow.id,
    terminalId: activeTerminal.terminalId
  }
  const canWrite = activeTerminal.status === 'running'
  const canDismiss = ['exited', 'terminated', 'failed'].includes(activeTerminal.status)

  async function sendInput(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canWrite || input === '') {
      return
    }

    await window.grindstone.workspace.writeTerminalInput({
      ...terminalRequest,
      data: input
    })
    setInput('')
  }

  async function requestResize(): Promise<void> {
    if (!canWrite || terminalSize === null) {
      return
    }

    await window.grindstone.workspace.resizeTerminal({
      ...terminalRequest,
      columns: terminalSize.columns,
      rows: terminalSize.rows
    })
  }

  async function requestTerminate(): Promise<void> {
    if (!canWrite || !window.confirm(`Terminate ${activeTerminal.provider} terminal?`)) {
      return
    }

    await window.grindstone.workspace.terminateTerminal(terminalRequest)
  }

  async function requestDismiss(): Promise<void> {
    if (!canDismiss) {
      return
    }

    await window.grindstone.workspace.dismissTerminal(terminalRequest)
  }

  return (
    <section className="terminal-panel" aria-label={`${flow.title} terminal sessions`}>
      <div className="terminal-tabs" role="tablist" aria-label={`${flow.title} terminals`}>
        {visibleTerminals.map((terminal) => (
          <button
            aria-label={`${terminal.phaseId} ${terminal.status}`}
            aria-selected={terminal.terminalId === activeTerminal.terminalId}
            className="terminal-tab"
            key={terminal.terminalId}
            onClick={() => setActiveTerminalId(terminal.terminalId)}
            role="tab"
            type="button"
          >
            <span>{terminal.phaseId}</span>
            <span className={`terminal-status terminal-status-${terminal.status}`}>
              {terminal.status}
            </span>
          </button>
        ))}
      </div>

      <div className="terminal-toolbar">
        <span className="terminal-command">
          {activeTerminal.provider} {activeTerminal.argv.join(' ')}
        </span>
        {activeTerminal.logPath === undefined ? null : (
          <span className="terminal-log-marker">Fallback log ready</span>
        )}
        <button
          aria-label={`Resize ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canWrite || terminalSize === null}
          onClick={() => void requestResize()}
          title={`Resize ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <Maximize2 aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={`Terminate ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canWrite}
          onClick={() => void requestTerminate()}
          title={`Terminate ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <Square aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={`Dismiss ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canDismiss}
          onClick={() => void requestDismiss()}
          title={`Dismiss ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>

      <TerminalOutput
        canWrite={canWrite}
        onMeasuredSize={setTerminalSize}
        terminal={activeTerminal}
        terminalRequest={terminalRequest}
      />

      <form
        aria-label={`${activeTerminal.phaseId} terminal input`}
        className="terminal-input-form"
        onSubmit={(event) => void sendInput(event)}
      >
        <input
          aria-label={`${activeTerminal.phaseId} terminal input text`}
          disabled={!canWrite}
          onChange={(event) => setInput(event.currentTarget.value)}
          value={input}
        />
        <button className="secondary-button" disabled={!canWrite || input === ''} type="submit">
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}

function TerminalOutput({
  canWrite,
  onMeasuredSize,
  terminal,
  terminalRequest
}: {
  canWrite: boolean
  onMeasuredSize: (size: { columns: number; rows: number }) => void
  terminal: FlowTerminalSummary
  terminalRequest: TerminalActionRequest
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<{
    terminalId: string
    write: (data: string) => void
  } | null>(null)
  const writtenOutputRef = useRef('')
  const output = terminal.recentOutput ?? ''
  const latestOutputRef = useRef(output)
  latestOutputRef.current = output

  useEffect(() => {
    let disposed = false
    let disposeTerminal: (() => void) | undefined
    let resizeObserver: ResizeObserver | undefined

    async function sendTerminalInput(data: string): Promise<void> {
      if (!canWrite) {
        return
      }

      await window.grindstone.workspace.writeTerminalInput({
        ...terminalRequest,
        data
      })
    }

    async function mountXterm(): Promise<void> {
      if (
        containerRef.current === null ||
        (typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom'))
      ) {
        return
      }

      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit')
        ])
        if (disposed || containerRef.current === null) {
          return
        }

        const xterm = new Terminal({
          convertEol: true,
          disableStdin: !canWrite,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          theme: {
            background: '#111318',
            foreground: '#e6edf3'
          }
        })
        const fit = new FitAddon()
        xterm.loadAddon(fit)
        xterm.open(containerRef.current)
        xtermRef.current = {
          terminalId: terminal.terminalId,
          write: (data) => xterm.write(data)
        }
        const mountedOutput = latestOutputRef.current
        xterm.write(mountedOutput)
        writtenOutputRef.current = mountedOutput
        const publishSize = () => {
          fit.fit()
          const dimensions = fit.proposeDimensions()
          if (dimensions !== undefined) {
            onMeasuredSize({
              columns: dimensions.cols,
              rows: dimensions.rows
            })
          }
        }
        const inputDisposable = canWrite
          ? xterm.onData((data) => {
              void sendTerminalInput(data)
            })
          : undefined
        publishSize()
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(publishSize)
          resizeObserver.observe(containerRef.current)
        }
        disposeTerminal = () => {
          inputDisposable?.dispose()
          resizeObserver?.disconnect()
          if (xtermRef.current?.terminalId === terminal.terminalId) {
            xtermRef.current = null
          }
          writtenOutputRef.current = ''
          xterm.dispose()
        }
      } catch {
        // The text fallback below remains authoritative for tests and accessibility.
      }
    }

    void mountXterm()

    return () => {
      disposed = true
      disposeTerminal?.()
    }
  }, [
    canWrite,
    onMeasuredSize,
    terminalRequest.flowId,
    terminalRequest.repositoryId,
    terminalRequest.terminalId,
    terminal.terminalId
  ])

  useEffect(() => {
    const xterm = xtermRef.current
    if (xterm === null || xterm.terminalId !== terminal.terminalId) {
      return
    }

    const nextChunk = getTerminalOutputAppend(writtenOutputRef.current, output)
    if (nextChunk !== '') {
      xterm.write(nextChunk)
    }
    writtenOutputRef.current = output
  }, [output, terminal.terminalId])

  return (
    <div className="terminal-output-wrap">
      <div ref={containerRef} className="terminal-xterm" aria-hidden="true" />
      <pre className="terminal-output" aria-label={`${terminal.phaseId} terminal output`}>
        {output === '' ? 'Terminal is waiting for output.' : output}
      </pre>
    </div>
  )
}

function formatFlowTooltip(flow: FlowListRow): string {
  return [
    `Repository: ${flow.repositoryPath}`,
    flow.worktreePath === undefined ? null : `Worktree: ${flow.worktreePath}`,
    flow.branch === undefined ? null : `Branch: ${flow.branch}`,
    flow.baseRef === undefined ? null : `Base ref: ${flow.baseRef}`,
    flow.commit === undefined ? null : `Commit: ${flow.commit}`,
    flow.planId === undefined ? null : `Plan: ${flow.planId}`,
    flow.planPath === undefined ? null : `Plan path: ${flow.planPath}`,
    flow.pr === undefined ? null : `PR: github#${flow.pr.number} - ${flow.pr.status} - ${flow.pr.url}`,
    flow.failure === undefined ? null : `Failure: ${flow.failure.stage} - ${flow.failure.message}`,
    flow.failure?.command === undefined ? null : `Command: ${flow.failure.command}`,
    flow.failure?.output === undefined ? null : `Output: ${flow.failure.output}`,
    ...(flow.phases ?? []).map(formatPhaseDetail)
  ].filter((line): line is string => line !== null).join('\n')
}

function formatPhaseDetail(phase: FlowPhaseSummary): string {
  return `Phase: ${phase.title} - ${phase.status}${phase.summary === undefined ? '' : ` - ${phase.summary}`}`
}

function formatFailureSummary(failure: NonNullable<FlowListRow['failure']>): string {
  const firstLine = failure.message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? failure.message.trim()

  return `${failure.stage}: ${truncateText(firstLine, 72)}`
}

function formatPhaseSummary(flow: FlowListRow): string {
  if (flow.phases === undefined || flow.phases.length === 0) {
    return '-'
  }

  const doneCount = flow.phases.filter(isDonePhase).length
  const nonDoneCounts = flow.phases
    .filter((phase) => !isDonePhase(phase))
    .reduce<Record<string, number>>((counts, phase) => {
      counts[phase.status] = (counts[phase.status] ?? 0) + 1
      return counts
    }, {})

  const nonDoneSummary = Object.entries(nonDoneCounts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')

  return nonDoneSummary === ''
    ? `${doneCount}/${flow.phases.length} done`
    : `${doneCount}/${flow.phases.length} done, ${nonDoneSummary}`
}

function isDonePhase(phase: FlowPhaseSummary): boolean {
  return phase.status === 'done' || phase.status === 'completed' || phase.status === 'skipped'
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`
}

function FlowCreatePanel({
  create,
  openRequest,
  onWorkspaceUpdate
}: {
  create: NonNullable<Extract<FlowPaneState, { status: 'ready' | 'empty' }>['create']>
  openRequest: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const newFlowButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const lastOpenRequestRef = useRef(openRequest)

  useEffect(() => {
    if (isOpen) {
      titleInputRef.current?.focus()
      return
    }

    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false
      newFlowButtonRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (openRequest === lastOpenRequestRef.current) {
      return
    }
    lastOpenRequestRef.current = openRequest
    if (create.available) {
      shouldRestoreFocusRef.current = false
      setIsOpen(true)
    }
  }, [create.available, openRequest])

  function openFlowDialog(): void {
    shouldRestoreFocusRef.current = false
    setIsOpen(true)
  }

  function closeFlowDialog(): void {
    shouldRestoreFocusRef.current = true
    setIsOpen(false)
  }

  function focusFirstDialogElement(): void {
    titleInputRef.current?.focus()
  }

  function focusLastDialogElement(): void {
    closeButtonRef.current?.focus()
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFlowDialog()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const firstElement = titleInputRef.current
    const lastElement = closeButtonRef.current

    if (firstElement === null || lastElement === null) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      focusLastDialogElement()
      return
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      focusFirstDialogElement()
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const request: CreateFlowRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      baseRef: baseRef.trim() === '' ? undefined : baseRef.trim()
    }

    if (request.title === '') {
      setLocalError('Flow title is required.')
      return
    }

    if (request.instructions === '') {
      setLocalError('Flow instructions are required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createFlow(request)
      onWorkspaceUpdate(nextWorkspace)
      if (
        (nextWorkspace.flow.status === 'ready' || nextWorkspace.flow.status === 'empty') &&
        nextWorkspace.flow.create?.error === null
      ) {
        setTitle('')
        setInstructions('')
        setBaseRef('')
        closeFlowDialog()
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <div className="flow-create">
      <button
        className="primary-action"
        disabled={!create.available}
        onClick={openFlowDialog}
        ref={newFlowButtonRef}
        type="button"
      >
        <CirclePlus aria-hidden="true" size={16} />
        <span>New Flow</span>
      </button>

      {isOpen ? (
        <div className="modal-backdrop">
          <div
            aria-labelledby="flow-create-dialog-title"
            aria-modal="true"
            className="modal-dialog"
            onKeyDown={handleDialogKeyDown}
            role="dialog"
          >
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusLastDialogElement}
              tabIndex={0}
            />
            <div className="modal-header">
              <h2 id="flow-create-dialog-title">Create Flow</h2>
            </div>

            <form
              aria-label="Create Flow"
              className="flow-create-form"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <label className="field">
                <span>Title</span>
                <input
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Ship workspace creation"
                  ref={titleInputRef}
                  value={title}
                />
              </label>
              <label className="field">
                <span>Instructions</span>
                <textarea
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setInstructions(event.currentTarget.value)}
                  placeholder="Describe the implementation goal"
                  value={instructions}
                />
              </label>
              <label className="field">
                <span>Base ref</span>
                <input
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setBaseRef(event.currentTarget.value)}
                  placeholder="HEAD"
                  value={baseRef}
                />
              </label>

              {errorMessage === null ? null : (
                <div
                  aria-label="Flow creation error"
                  className="create-error"
                  role="alert"
                >
                  {errorMessage}
                </div>
              )}

              <div className="form-actions">
                <button
                  className="secondary-button"
                  disabled={isSubmitting}
                  onClick={closeFlowDialog}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                  <span>Cancel</span>
                </button>
                <button
                  className="primary-action"
                  disabled={
                    !create.available ||
                    isSubmitting ||
                    title.trim() === '' ||
                    instructions.trim() === ''
                  }
                  type="submit"
                >
                  <CirclePlus aria-hidden="true" size={16} />
                  <span>{isSubmitting ? 'Creating' : 'Create Flow'}</span>
                </button>
              </div>
            </form>
            <button
              aria-label="Close Flow creation"
              className="icon-button modal-close-button"
              disabled={isSubmitting}
              onClick={closeFlowDialog}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusFirstDialogElement}
              tabIndex={0}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
