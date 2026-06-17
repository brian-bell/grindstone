import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, getTerminalOutputAppend } from './App'
import './styles.css'
import type {
  LinkedFlowPlanResponse
} from '@shared/artifacts'
import type {
  CommonConfigUpdateInput,
  ConfigUpdateResponse,
  EditableConfigState
} from '@shared/config'
import { RECENT_TERMINAL_OUTPUT_LIMIT } from '@shared/workspace'
import type {
  CreateFlowRequest,
  CreateRepositoryRequest,
  FlowListRow,
  InitialWorkspaceState,
  LaunchFlowPhaseRequest,
  RecordFlowHumanReviewRequest,
  RecordFlowMergeRequest,
  RecordFlowPullRequestRequest,
  SkipFlowPhaseRequest,
  TerminalEvent,
  UpdateFlowPhaseRequest
} from '@shared/workspace'

const defaultInitialState: InitialWorkspaceState = {
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

const catalogState: InitialWorkspaceState = {
  ...defaultInitialState,
  repository: {
    status: 'ready',
    title: 'Repository catalog',
    description: '1 repository configured.',
    repositories: [
      {
        id: '/repos/grindstone',
        name: 'grindstone',
        path: '/repos/grindstone',
        canonicalPath: '/repos/grindstone',
        sources: ['explicit']
      }
    ],
    selectedRepositoryId: null,
    diagnostics: [
      {
        severity: 'warning',
        code: 'explicit_repo_missing',
        message: 'Explicit repository does not exist or is not a Git repository: /missing/repo',
        configuredPath: '/missing/repo',
        resolvedPath: '/missing/repo'
      }
    ],
    create: {
      scanRoots: [
        {
          id: 'scan-root:0:test',
          configuredPath: '/repos',
          resolvedPath: '/repos',
          displayPath: '/repos'
        }
      ],
      available: true,
      error: null,
      remoteRetries: []
    }
  }
}

const selectedCatalogState: InitialWorkspaceState = {
  ...catalogState,
  repository: {
    ...catalogState.repository,
    title: 'grindstone',
    description: '/repos/grindstone',
    selectedRepositoryId: '/repos/grindstone'
  },
  flow: {
    status: 'ready',
    repositoryId: '/repos/grindstone',
    repositoryName: 'grindstone',
    create: {
      available: true,
      error: null
    },
    flows: [
      {
        id: 'artifact-backed-flow',
        title: 'Artifact backed Flow',
        status: 'active',
        repositoryId: '/repos/grindstone',
        repositoryPath: '/repos/grindstone',
        merge: { status: 'pending' },
        branch: 'flow/list',
        planId: 'plan-flow-list',
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-11T12:30:00.000Z',
        phases: [
          {
            id: 'phase-render',
            title: 'Render list',
            status: 'completed',
            order: 1,
            summary: 'Rows are visible'
          },
          {
            id: 'phase-launch',
            title: 'Launch workspace',
            status: 'active',
            order: 2
          }
        ]
      }
    ]
  }
}

const emptySelectedCatalogState: InitialWorkspaceState = {
  ...selectedCatalogState,
  flow: {
    status: 'empty',
    title: 'No Flows for grindstone',
    description: 'No Flow records were found for /repos/grindstone.',
    repositoryId: '/repos/grindstone',
    repositoryName: 'grindstone',
    create: {
      available: true,
      error: null
    }
  }
}

const errorSelectedCatalogState: InitialWorkspaceState = {
  ...selectedCatalogState,
  flow: {
    status: 'error',
    message: 'Flow artifact store unavailable: permission denied',
    repositoryId: '/repos/grindstone',
    repositoryName: 'grindstone'
  }
}

const multiRepositoryCatalogState: InitialWorkspaceState = {
  ...catalogState,
  repository: {
    ...catalogState.repository,
    description: '2 repositories configured.',
    repositories: [
      {
        id: '/repos/alpha',
        name: 'alpha',
        path: '/repos/alpha',
        canonicalPath: '/repos/alpha',
        sources: ['explicit']
      },
      {
        id: '/repos/beta',
        name: 'beta',
        path: '/repos/beta',
        canonicalPath: '/repos/beta',
        sources: ['explicit']
      }
    ]
  }
}

const alphaSelectedCatalogState: InitialWorkspaceState = {
  ...multiRepositoryCatalogState,
  repository: {
    ...multiRepositoryCatalogState.repository,
    title: 'alpha',
    description: '/repos/alpha',
    selectedRepositoryId: '/repos/alpha'
  },
  flow: {
    status: 'ready',
    repositoryId: '/repos/alpha',
    repositoryName: 'alpha',
    create: {
      available: true,
      error: null
    },
    flows: [
      {
        id: 'alpha-flow',
        title: 'Alpha Flow',
        status: 'active',
        repositoryId: '/repos/alpha',
        repositoryPath: '/repos/alpha',
        merge: { status: 'pending' },
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-11T10:00:00.000Z'
      }
    ]
  }
}

const betaSelectedCatalogState: InitialWorkspaceState = {
  ...multiRepositoryCatalogState,
  repository: {
    ...multiRepositoryCatalogState.repository,
    title: 'beta',
    description: '/repos/beta',
    selectedRepositoryId: '/repos/beta'
  },
  flow: {
    status: 'ready',
    repositoryId: '/repos/beta',
    repositoryName: 'beta',
    create: {
      available: true,
      error: null
    },
    flows: [
      {
        id: 'beta-flow',
        title: 'Beta Flow',
        status: 'active',
        repositoryId: '/repos/beta',
        repositoryPath: '/repos/beta',
        merge: { status: 'pending' },
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-12T10:00:00.000Z'
      }
    ]
  }
}

const editableConfigState: EditableConfigState = {
  configPath: '/configs/grindstone.toml',
  scan_roots: ['/repos'],
  repos: ['/repos/grindstone'],
  default_agent: 'codex',
  artifact_root: './artifacts',
  bootstrap_hooks: [
    {
      sourceIndex: 0,
      name: 'Install',
      command: 'npm install',
      cwd: './app',
      env: {
        NODE_ENV: 'test'
      }
    }
  ]
}

const setWorkspaceApi = (
  getInitialState: () => Promise<InitialWorkspaceState>,
  selectRepository = vi.fn().mockResolvedValue(selectedCatalogState),
  getEditableConfig = vi.fn().mockResolvedValue(editableConfigState),
  updateCommonConfig = vi.fn().mockResolvedValue({
    ok: true,
    workspace: catalogState,
    config: editableConfigState
  } satisfies ConfigUpdateResponse),
  createRepository = vi.fn().mockResolvedValue(catalogState),
  retryRepositoryRemote = vi.fn().mockResolvedValue(catalogState),
  createFlow = vi.fn().mockResolvedValue(selectedCatalogState),
  readFlowPlan = vi.fn().mockResolvedValue({
    status: 'missing',
    flowId: 'artifact-backed-flow',
    planId: 'plan-flow-list',
    message: 'Linked plan missing'
  } satisfies LinkedFlowPlanResponse),
  updateFlowPhase = vi.fn().mockResolvedValue(selectedCatalogState),
  launchFlowPhase = vi.fn().mockResolvedValue(selectedCatalogState),
  skipFlowPhase = vi.fn().mockResolvedValue(selectedCatalogState),
  completeFlowPhase = vi.fn().mockResolvedValue(selectedCatalogState),
  recordFlowPullRequest = vi.fn().mockResolvedValue(selectedCatalogState),
  recordFlowHumanReview = vi.fn().mockResolvedValue(selectedCatalogState),
  recordFlowMerge = vi.fn().mockResolvedValue(selectedCatalogState),
  terminalApi = {
    listTerminals: vi.fn().mockResolvedValue([]),
    writeTerminalInput: vi.fn().mockResolvedValue({}),
    resizeTerminal: vi.fn().mockResolvedValue({}),
    terminateTerminal: vi.fn().mockResolvedValue({}),
    dismissTerminal: vi.fn().mockResolvedValue({}),
    onTerminalEvent: vi.fn((request: unknown, handler: (event: TerminalEvent) => void) => {
      void request
      void handler
      return () => undefined
    })
  }
): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState,
        selectRepository,
        readFlowPlan,
        createFlow,
        updateFlowPhase,
        launchFlowPhase,
        skipFlowPhase,
        completeFlowPhase,
        recordFlowPullRequest,
        recordFlowHumanReview,
        recordFlowMerge,
        createRepository,
        retryRepositoryRemote,
        ...terminalApi
      },
      config: {
        getEditableConfig,
        updateCommonConfig
      }
    }
  })
}

describe('App shell', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'grindstone')
    window.history.pushState({}, '', '/')
  })

  it('opens into the three-pane Flow workspace with default state', async () => {
    setWorkspaceApi(vi.fn().mockResolvedValue(defaultInitialState))

    render(<App />)

    expect(await screen.findByRole('region', { name: /^repos$/i })).toBeInTheDocument()

    const repositoryPane = screen.getByRole('region', { name: /^repos$/i })
    const flowPane = screen.getByRole('main', { name: /flow workspace/i })
    const contextPane = screen.getByRole('region', { name: /contextual hints/i })

    expect(screen.queryByText('Repository Area')).not.toBeInTheDocument()
    expect(within(repositoryPane).getAllByRole('heading')).toHaveLength(1)
    expect(within(repositoryPane).getByRole('heading', { name: /^repos$/i })).toBeInTheDocument()
    expect(within(repositoryPane).getByText('No repositories configured')).toBeInTheDocument()
    expect(within(flowPane).getByText('No Flow selected')).toBeInTheDocument()
    expect(within(contextPane).getByText('Select a repository')).toBeInTheDocument()
  })

  it('starts with a narrower right pane and lets users collapse it', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(vi.fn().mockResolvedValue(defaultInitialState))

    const { container } = render(<App />)

    const shell = container.querySelector('.app-shell')
    expect(shell).not.toHaveAttribute('style')

    const contextPane = await screen.findByRole('region', { name: /contextual hints/i })
    const collapseButton = within(contextPane).getByRole('button', {
      name: /collapse right pane/i
    })
    expect(collapseButton).toHaveAttribute('aria-controls', 'context-pane-content')
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true')

    await user.click(collapseButton)

    expect(screen.queryByRole('region', { name: /contextual hints/i })).not.toBeInTheDocument()
    expect(shell).toHaveClass('app-shell-right-collapsed')
    expect(shell).not.toHaveAttribute('style')
    const expandButton = screen.getByRole('button', { name: /expand right pane/i })
    expect(expandButton).toHaveAttribute('aria-controls', 'context-pane-content')
    expect(expandButton).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(expandButton).toHaveFocus())

    await user.click(expandButton)

    const restoredContextPane = await screen.findByRole('region', { name: /contextual hints/i })
    const restoredCollapseButton = within(restoredContextPane).getByRole('button', {
      name: /collapse right pane/i
    })
    expect(shell).not.toHaveClass('app-shell-right-collapsed')
    await waitFor(() => expect(restoredCollapseButton).toHaveFocus())
  })

  it('reopens a collapsed right pane when configuration is requested', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    const { container } = render(<App />)

    const contextPane = await screen.findByRole('region', { name: /contextual hints/i })
    await user.click(within(contextPane).getByRole('button', { name: /collapse right pane/i }))

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    await user.click(within(repositoryPane).getByRole('button', { name: /configure/i }))

    expect(await screen.findByRole('region', { name: /common config/i })).toBeInTheDocument()
    expect(container.querySelector('.app-shell')).not.toHaveClass('app-shell-right-collapsed')
  })

  it('keeps repository loading copy out of secondary left-pane headings', () => {
    setWorkspaceApi(vi.fn(() => new Promise<typeof defaultInitialState>(() => undefined)))

    render(<App />)

    const repositoryPane = screen.getByRole('region', { name: /^repos$/i })
    expect(within(repositoryPane).getByRole('status', { name: /repository catalog loading/i }))
      .toHaveTextContent('Loading repositories')
    expect(within(repositoryPane).getAllByRole('heading')).toHaveLength(1)
    expect(
      within(repositoryPane).queryByRole('heading', { name: /loading repositories/i })
    ).not.toBeInTheDocument()
  })

  it('renders configured repositories and non-fatal catalog diagnostics', async () => {
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    expect(within(repositoryPane).getByRole('button', { name: /grindstone/i })).toHaveTextContent(
      '/repos/grindstone'
    )
    expect(within(repositoryPane).getByText('explicit')).toBeInTheDocument()
    expect(within(repositoryPane).getByRole('alert')).toHaveTextContent('/missing/repo')
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'No Flow selected'
    )
  })

  it('opens repository creation in a modal from the left pane', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    const launcher = within(repositoryPane).getByRole('button', { name: /create repository/i })
    expect(launcher).toBeEnabled()
    expect(within(repositoryPane).queryByLabelText(/repository name/i)).not.toBeInTheDocument()

    await user.click(launcher)

    const dialog = await screen.findByRole('dialog', { name: /create repository/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const scanRootSelect = within(dialog).getByLabelText(/scan root/i)
    expect(scanRootSelect).toBeInTheDocument()
    const nameInput = within(dialog).getByLabelText(/repository name/i)
    expect(nameInput).toHaveFocus()
    expect(within(dialog).getByLabelText(/create on github/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/github visibility/i)).toBeInTheDocument()
    const closeButton = within(dialog).getByRole('button', { name: /close repository creation/i })
    scanRootSelect.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(closeButton).toHaveFocus()
    await user.tab()
    expect(scanRootSelect).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
    expect(launcher).toHaveFocus()
  })

  it('selects a repository through preload and renders its Flow records in a table', async () => {
    const user = userEvent.setup()
    const selectRepository = vi.fn().mockResolvedValue(selectedCatalogState)
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState), selectRepository)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /grindstone/i }))

    expect(selectRepository).toHaveBeenCalledWith({ repositoryId: '/repos/grindstone' })
    const repositoryPane = screen.getByRole('region', { name: /^repos$/i })
    expect(within(repositoryPane).getByRole('button', { name: /grindstone/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const flowPane = screen.getByRole('main', { name: /flow workspace/i })
    const flowTable = within(flowPane).getByRole('table', { name: /grindstone flow records/i })
    expect(within(flowTable).getByRole('columnheader', { name: /flow/i })).toBeInTheDocument()
    expect(within(flowTable).getByRole('columnheader', { name: /status/i })).toBeInTheDocument()
    expect(within(flowTable).getByRole('columnheader', { name: /updated/i })).toBeInTheDocument()
    expect(within(flowTable).getByRole('columnheader', { name: /branch/i })).toBeInTheDocument()
    expect(within(flowTable).getByRole('columnheader', { name: /plan/i })).toBeInTheDocument()
    expect(within(flowTable).getByRole('columnheader', { name: /phases/i })).toBeInTheDocument()
    expect(within(flowTable).queryByRole('columnheader', { name: /details/i })).not.toBeInTheDocument()

    const rows = within(flowTable).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toHaveTextContent('Artifact backed Flow')
    expect(rows[1]).toHaveTextContent('active')
    expect(rows[1]).toHaveTextContent('2026-06-11T12:30:00.000Z')
    expect(rows[1]).toHaveTextContent('flow/list')
    expect(rows[1]).toHaveTextContent('plan-flow-list')
    expect(rows[1]).toHaveTextContent('1/2 done, 1 active')
    expect(rows[1]).not.toHaveTextContent('/repos/grindstone')
    expect(rows[1]).not.toHaveTextContent('Render list')
    const cells = within(rows[1]).getAllByRole('cell')
    const detailsButton = within(rows[1]).getByRole('button', {
      name: /expand artifact backed flow details/i
    })
    expect(cells[0]).toContainElement(detailsButton)
    expect(cells[0]).toHaveTextContent('Artifact backed Flow')
    expect(detailsButton).toHaveAttribute('aria-expanded', 'false')
    expect(detailsButton).toHaveAttribute(
      'title',
      expect.stringContaining('Repository: /repos/grindstone')
    )
    expect(detailsButton).toHaveAttribute(
      'title',
      expect.stringContaining('Phase: Render list - completed - Rows are visible')
    )

    await user.click(detailsButton)

    expect(detailsButton).toHaveAttribute('aria-expanded', 'true')
    expect(detailsButton).toHaveAccessibleName(/collapse artifact backed flow details/i)
    expect(await within(flowTable).findByRole('region', { name: /artifact backed flow details/i }))
      .toHaveTextContent('Phase: Launch workspace - active')
  })

  it('renders nested implementation phases and edits generated children through IPC responses', async () => {
    const user = userEvent.setup()
    const nestedFlow: FlowListRow = {
      id: 'phase-tree-flow',
      title: 'Phase tree Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'plan',
          title: 'Plan',
          status: 'completed',
          order: 1
        },
        {
          id: 'implementation',
          title: 'Implementation',
          status: 'ready',
          order: 3
        },
        {
          id: 'implementation-build-api',
          title: 'Build API',
          status: 'pending',
          order: 1,
          parentPhaseId: 'implementation',
          kind: 'implementation_child',
          generated: true,
          editable: true,
          notes: 'Wire the handler'
        }
      ]
    }
    const nestedState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [nestedFlow]
      }
    }
    const editedState: InitialWorkspaceState = {
      ...nestedState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...nestedFlow,
            phases: nestedFlow.phases?.map((phase) =>
              phase.id === 'implementation-build-api'
                ? { ...phase, title: 'Build API contract', order: 2, notes: 'Saved notes' }
                : phase
            )
          }
        ]
      }
    }
    const updateFlowPhase = vi.fn<(
      request: UpdateFlowPhaseRequest
    ) => Promise<InitialWorkspaceState>>()
      .mockRejectedValueOnce(new Error('Duplicate sibling phase title.'))
      .mockResolvedValueOnce(editedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(nestedState),
      vi.fn().mockResolvedValue(nestedState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: nestedState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(nestedState),
      undefined,
      updateFlowPhase
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /phase tree flow details/i }))
    const phaseTree = within(flowPane).getByRole('region', { name: /phase tree flow details/i })
    expect(phaseTree).toHaveTextContent('Phase: Implementation - ready')
    expect(phaseTree).toHaveTextContent('Phase: Build API - pending')
    expect(phaseTree).toHaveTextContent('Wire the handler')

    await user.click(within(phaseTree).getByRole('button', { name: /^edit$/i }))
    const editForm = within(phaseTree).getByRole('form', { name: /edit build api/i })
    await user.clear(within(editForm).getByLabelText('Phase title'))
    await user.type(within(editForm).getByLabelText('Phase title'), 'Duplicate title')
    await user.clear(within(editForm).getByLabelText('Order'))
    await user.type(within(editForm).getByLabelText('Order'), '2')
    await user.clear(within(editForm).getByLabelText('Notes'))
    await user.type(within(editForm).getByLabelText('Notes'), 'Saved notes')
    await user.click(within(editForm).getByRole('button', { name: /^save$/i }))

    expect(await within(editForm).findByRole('alert')).toHaveTextContent(
      'Duplicate sibling phase title.'
    )
    expect(phaseTree).not.toHaveTextContent('Phase: Duplicate title - pending')

    await user.clear(within(editForm).getByLabelText('Phase title'))
    await user.type(within(editForm).getByLabelText('Phase title'), 'Build API contract')
    await user.click(within(editForm).getByRole('button', { name: /^save$/i }))

    expect(updateFlowPhase).toHaveBeenLastCalledWith({
      flowId: 'phase-tree-flow',
      phaseId: 'implementation-build-api',
      title: 'Build API contract',
      order: 2,
      notes: 'Saved notes'
    })
    expect(await within(flowPane).findByText('Phase: Build API contract - pending'))
      .toBeInTheDocument()
  })

  it('launches parent and child implementation phases from the phase tree', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'launchable-flow',
      title: 'Launchable Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'implementation',
          title: 'Implementation',
          status: 'ready',
          order: 3
        },
        {
          id: 'implementation-build-api',
          title: 'Build API',
          status: 'ready',
          order: 1,
          parentPhaseId: 'implementation',
          kind: 'implementation_child',
          generated: true,
          editable: true
        },
        {
          id: 'implementation-repair-api',
          title: 'Repair API',
          status: 'needs_attention',
          order: 2,
          parentPhaseId: 'implementation',
          kind: 'implementation_child',
          generated: true,
          editable: true
        }
      ]
    }
    const launchedState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            phases: flow.phases?.map((phase) =>
              phase.id === 'implementation'
                ? { ...phase, status: 'running' }
                : phase
            )
          }
        ]
      }
    }
    const childLaunchedState: InitialWorkspaceState = {
      ...launchedState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            phases: flow.phases?.map((phase) =>
              phase.id === 'implementation-build-api'
                ? { ...phase, status: 'running' }
                : phase.id === 'implementation'
                  ? { ...phase, status: 'running' }
                  : phase
            )
          }
        ]
      }
    }
    const launchFlowPhase = vi.fn<(
      request: LaunchFlowPhaseRequest
    ) => Promise<InitialWorkspaceState>>()
      .mockResolvedValueOnce(launchedState)
      .mockResolvedValueOnce(childLaunchedState)
    const launchableState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [flow]
      }
    }
    setWorkspaceApi(
      vi.fn().mockResolvedValue(launchableState),
      vi.fn().mockResolvedValue(launchableState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: launchableState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(launchableState),
      undefined,
      vi.fn().mockResolvedValue(launchableState),
      launchFlowPhase
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /launchable flow details/i }))
    expect(within(flowPane).getByRole('button', { name: /launch repair api/i }))
      .toBeInTheDocument()
    await user.click(within(flowPane).getByRole('button', { name: /launch implementation/i }))

    expect(launchFlowPhase).toHaveBeenCalledWith({
      flowId: 'launchable-flow',
      phaseId: 'implementation'
    })
    expect(await within(flowPane).findByText('Phase: Implementation - running'))
      .toBeInTheDocument()
    expect(within(flowPane).queryByRole('button', { name: /complete implementation/i }))
      .not.toBeInTheDocument()

    await user.click(within(flowPane).getByRole('button', { name: /launch build api/i }))
    expect(launchFlowPhase).toHaveBeenLastCalledWith({
      flowId: 'launchable-flow',
      phaseId: 'implementation-build-api'
    })
    expect(await within(flowPane).findByText('Phase: Build API - running'))
      .toBeInTheDocument()
  })

  it('launches and completes Review Loop 2 before showing PR Creation metadata controls', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'review-two-flow',
      title: 'Review Two Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      branch: 'flow/review-two',
      baseRef: 'main',
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'review-loop-1',
          title: 'Review Loop 1',
          status: 'completed',
          kind: 'review_loop',
          order: 4
        },
        {
          id: 'review-loop-2',
          title: 'Review Loop 2',
          status: 'ready',
          kind: 'review_loop',
          order: 5
        },
        {
          id: 'pr-creation',
          title: 'PR Creation',
          status: 'pending',
          kind: 'pr_creation',
          order: 6
        }
      ]
    }
    const state: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [flow]
      }
    }
    const launchedState: InitialWorkspaceState = {
      ...state,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            phases: flow.phases?.map((phase) =>
              phase.id === 'review-loop-2' ? { ...phase, status: 'running' } : phase
            )
          }
        ]
      }
    }
    const completedState: InitialWorkspaceState = {
      ...state,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            phases: flow.phases?.map((phase) =>
              phase.id === 'review-loop-2'
                ? { ...phase, status: 'completed', outcome: 'review_completed' }
                : phase.id === 'pr-creation'
                  ? { ...phase, status: 'ready' }
                  : phase
            )
          }
        ]
      }
    }
    const launchFlowPhase = vi.fn<(
      request: LaunchFlowPhaseRequest
    ) => Promise<InitialWorkspaceState>>().mockResolvedValue(launchedState)
    const completeFlowPhase = vi.fn().mockResolvedValue(completedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: state,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(state),
      undefined,
      vi.fn().mockResolvedValue(state),
      launchFlowPhase,
      vi.fn().mockResolvedValue(state),
      completeFlowPhase
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /review two flow details/i }))
    expect(within(flowPane).getByRole('button', { name: /launch review loop 2/i }))
      .toBeInTheDocument()
    expect(within(flowPane).queryByRole('form', { name: /record pr for review two flow/i }))
      .not.toBeInTheDocument()

    await user.click(within(flowPane).getByRole('button', { name: /launch review loop 2/i }))
    expect(launchFlowPhase).toHaveBeenCalledWith({
      flowId: 'review-two-flow',
      phaseId: 'review-loop-2'
    })
    await user.click(await within(flowPane).findByRole('button', { name: /complete review loop 2/i }))
    expect(completeFlowPhase).toHaveBeenCalledWith({
      flowId: 'review-two-flow',
      phaseId: 'review-loop-2'
    })
    expect(await within(flowPane).findByRole('form', { name: /record pr for review two flow/i }))
      .toBeInTheDocument()
  })

  it('validates and records PR metadata from ready PR Creation', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'pr-ready-flow',
      title: 'PR Ready Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      branch: 'flow/pr-ready',
      baseRef: 'main',
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'pr-creation',
          title: 'PR Creation',
          status: 'ready',
          kind: 'pr_creation',
          order: 6
        },
        {
          id: 'human-review',
          title: 'Human Review',
          status: 'pending',
          kind: 'human_review',
          order: 7
        }
      ]
    }
    const state: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [flow]
      }
    }
    const recordedState: InitialWorkspaceState = {
      ...state,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            pr: {
              provider: 'github',
              number: 12,
              url: 'https://github.com/acme/grindstone/pull/12',
              head: 'flow/pr-ready',
              base: 'main',
              status: 'open'
            },
            phases: flow.phases?.map((phase) =>
              phase.id === 'pr-creation'
                ? { ...phase, status: 'completed', outcome: 'pr_recorded' }
                : phase.id === 'human-review'
                  ? { ...phase, status: 'ready' }
                  : phase
            )
          }
        ]
      }
    }
    const recordFlowPullRequest = vi.fn<(
      request: RecordFlowPullRequestRequest
    ) => Promise<InitialWorkspaceState>>().mockResolvedValue(recordedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: state,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(state),
      undefined,
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      recordFlowPullRequest
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /pr ready flow details/i }))
    const form = within(flowPane).getByRole('form', { name: /record pr for pr ready flow/i })
    expect(within(form).getByLabelText(/head branch/i)).toHaveValue('flow/pr-ready')
    expect(within(form).getByLabelText(/base branch/i)).toHaveValue('main')

    await user.click(within(form).getByRole('button', { name: /record pr/i }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'PR number must be a positive integer.'
    )
    expect(recordFlowPullRequest).not.toHaveBeenCalled()

    await user.type(within(form).getByLabelText(/pr number/i), '12')
    await user.type(within(form).getByLabelText(/pr url/i), 'http://github.com/acme/grindstone/pull/12')
    await user.click(within(form).getByRole('button', { name: /record pr/i }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'PR URL must be a valid HTTPS URL.'
    )

    await user.clear(within(form).getByLabelText(/pr url/i))
    await user.type(within(form).getByLabelText(/pr url/i), 'https://github.com/acme/grindstone/pull/12')
    await user.click(within(form).getByRole('button', { name: /record pr/i }))
    expect(recordFlowPullRequest).toHaveBeenCalledWith({
      flowId: 'pr-ready-flow',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/pr-ready',
        base: 'main',
        status: 'open'
      },
      summary: 'Recorded GitHub PR #12.'
    })
    expect(await within(flowPane).findByText('Phase: Human Review - ready'))
      .toBeInTheDocument()
    expect(within(flowPane).getByText('PR: github#12 - open - https://github.com/acme/grindstone/pull/12'))
      .toBeInTheDocument()
  })

  it('records Human Review outcomes from a PR-backed Human Review phase', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'reviewable-flow',
      title: 'Reviewable Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      pr: {
        provider: 'github',
        number: 13,
        url: 'https://github.com/acme/grindstone/pull/13',
        head: 'flow/human-review',
        base: 'main',
        status: 'open'
      },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'human-review',
          title: 'Human Review',
          status: 'ready',
          kind: 'human_review',
          order: 7
        }
      ]
    }
    const baseState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: { available: true, error: null },
        flows: [flow]
      }
    }
    const approvedState: InitialWorkspaceState = {
      ...baseState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: { available: true, error: null },
        flows: [
          {
            ...flow,
            humanReview: {
              outcome: 'approved',
              reviewed_at: '2026-06-15T12:00:00.000Z'
            },
            phases: flow.phases?.map((phase) => ({ ...phase, status: 'completed', outcome: 'approved' }))
          }
        ]
      }
    }
    const recordFlowHumanReview = vi.fn<(
      request: RecordFlowHumanReviewRequest
    ) => Promise<InitialWorkspaceState>>().mockResolvedValue(approvedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(baseState),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordFlowHumanReview
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /reviewable flow details/i }))
    const reviewPanel = within(flowPane).getByRole('region', { name: /human review for reviewable flow/i })
    expect(within(reviewPanel).getByText('GitHub PR #13')).toBeInTheDocument()
    expect(within(reviewPanel).queryByRole('region', { name: /merge metadata/i })).not.toBeInTheDocument()

    await user.click(within(reviewPanel).getByRole('button', { name: /request changes/i }))
    expect(await within(reviewPanel).findByRole('alert')).toHaveTextContent('Review notes are required.')
    expect(recordFlowHumanReview).not.toHaveBeenCalled()

    await user.type(within(reviewPanel).getByLabelText(/review notes/i), 'Looks good.')
    await user.click(within(reviewPanel).getByRole('button', { name: /approve/i }))
    expect(recordFlowHumanReview).toHaveBeenCalledWith({
      flowId: 'reviewable-flow',
      outcome: 'approved',
      notes: 'Looks good.'
    })
    expect(await within(flowPane).findByRole('region', { name: /merge metadata for reviewable flow/i }))
      .toBeInTheDocument()
  })

  it('records merge metadata only after Human Review approval', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'merge-ready-flow',
      title: 'Merge Ready Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      pr: {
        provider: 'github',
        number: 13,
        url: 'https://github.com/acme/grindstone/pull/13',
        head: 'flow/human-review',
        base: 'main',
        status: 'open'
      },
      humanReview: {
        outcome: 'approved',
        reviewed_at: '2026-06-15T12:00:00.000Z'
      },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'human-review',
          title: 'Human Review',
          status: 'completed',
          kind: 'human_review',
          outcome: 'approved',
          order: 7
        }
      ]
    }
    const baseState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: { available: true, error: null },
        flows: [flow]
      }
    }
    const mergedState: InitialWorkspaceState = {
      ...baseState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: { available: true, error: null },
        flows: [
          {
            ...flow,
            status: 'merged',
            merge: {
              status: 'merged',
              commit: 'abcdef1234567890abcdef1234567890abcdef12',
              merged_at: '2026-06-15T12:30:00.000Z'
            }
          }
        ]
      }
    }
    const recordFlowMerge = vi.fn<(
      request: RecordFlowMergeRequest
    ) => Promise<InitialWorkspaceState>>().mockResolvedValue(mergedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(baseState),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordFlowMerge
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /merge ready flow details/i }))
    const mergePanel = within(flowPane).getByRole('region', { name: /merge metadata for merge ready flow/i })

    await user.click(within(mergePanel).getByRole('button', { name: /record merge/i }))
    expect(await within(mergePanel).findByRole('alert')).toHaveTextContent(
      'Merge commit must be a full 40-character hex object id.'
    )
    expect(recordFlowMerge).not.toHaveBeenCalled()

    await user.type(
      within(mergePanel).getByLabelText(/merge commit/i),
      'ABCDEF1234567890ABCDEF1234567890ABCDEF12'
    )
    await user.click(within(mergePanel).getByRole('button', { name: /record merge/i }))
    expect(recordFlowMerge).toHaveBeenCalledWith({
      flowId: 'merge-ready-flow',
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12'
    })
    expect(await within(flowPane).findByText('Merged')).toBeInTheDocument()
  })

  it('does not show Record PR controls for custom PR creation phases', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'custom-pr-flow',
      title: 'Custom PR Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'custom-pr-gate',
          title: 'Custom PR Gate',
          status: 'ready',
          kind: 'pr_creation',
          order: 6
        }
      ]
    }
    const state: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [flow]
      }
    }
    const recordFlowPullRequest = vi.fn<(
      request: RecordFlowPullRequestRequest
    ) => Promise<InitialWorkspaceState>>().mockResolvedValue(state)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: state,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(state),
      undefined,
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      recordFlowPullRequest
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /custom pr flow details/i }))

    expect(within(flowPane).queryByRole('form', { name: /record pr for custom pr flow/i }))
      .not.toBeInTheDocument()
    expect(recordFlowPullRequest).not.toHaveBeenCalled()
  })

  it('requires notes before skipping an implementation child and shows refreshed readiness', async () => {
    const user = userEvent.setup()
    const flow: FlowListRow = {
      id: 'skip-child-flow',
      title: 'Skip Child Flow',
      status: 'active',
      repositoryId: '/repos/grindstone',
      repositoryPath: '/repos/grindstone',
      merge: { status: 'pending' },
      createdAt: '2026-06-15T10:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      phases: [
        {
          id: 'implementation',
          title: 'Implementation',
          status: 'running',
          order: 3
        },
        {
          id: 'implementation-build-api',
          title: 'Build API',
          status: 'ready',
          order: 1,
          parentPhaseId: 'implementation',
          kind: 'implementation_child',
          generated: true,
          editable: true
        },
        {
          id: 'review-loop-1',
          title: 'Review Loop 1',
          status: 'pending',
          order: 4
        }
      ]
    }
    const skippedState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            ...flow,
            phases: flow.phases?.map((phase) =>
              phase.id === 'implementation-build-api'
                ? { ...phase, status: 'skipped', notes: 'Covered by the parent slice.' }
                : phase.id === 'review-loop-1'
                  ? { ...phase, status: 'ready' }
                  : phase
            )
          }
        ]
      }
    }
    const skipFlowPhase = vi.fn<(
      request: SkipFlowPhaseRequest
    ) => Promise<InitialWorkspaceState>>()
      .mockResolvedValue(skippedState)
    const state: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [flow]
      }
    }
    setWorkspaceApi(
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: state,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(state),
      undefined,
      vi.fn().mockResolvedValue(state),
      vi.fn().mockResolvedValue(state),
      skipFlowPhase
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /skip child flow details/i }))
    await user.click(within(flowPane).getByRole('button', { name: /skip build api/i }))
    const skipForm = within(flowPane).getByRole('form', { name: /skip build api/i })
    await user.click(within(skipForm).getByRole('button', { name: /^skip phase$/i }))

    expect(await within(skipForm).findByRole('alert')).toHaveTextContent(
      'Skip notes are required.'
    )
    expect(skipFlowPhase).not.toHaveBeenCalled()

    await user.type(within(skipForm).getByLabelText(/skip notes for build api/i), 'Covered by the parent slice.')
    await user.click(within(skipForm).getByRole('button', { name: /^skip phase$/i }))

    expect(skipFlowPhase).toHaveBeenCalledWith({
      flowId: 'skip-child-flow',
      phaseId: 'implementation-build-api',
      notes: 'Covered by the parent slice.'
    })
    expect(await within(flowPane).findByText('Phase: Build API - skipped'))
      .toBeInTheDocument()
    expect(await within(flowPane).findByText('Phase: Review Loop 1 - ready'))
      .toBeInTheDocument()
  })

  it('opens a linked plan from selected Flow context', async () => {
    const user = userEvent.setup()
    const readFlowPlan = vi.fn().mockResolvedValue({
      status: 'ready',
      metadata: {
        schema_version: 1,
        plan_id: 'plan-flow-list',
        title: 'Linked Plan',
        status: 'approved',
        plan_path: '/artifacts/plans/plan-flow-list/plan.md',
        created_at: '2026-06-15T10:00:00.000Z',
        updated_at: '2026-06-15T10:00:00.000Z'
      },
      body: '# Linked Plan\n\nShip the CLI.\n'
    } satisfies LinkedFlowPlanResponse)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: selectedCatalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      readFlowPlan
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', {
      name: /open plan plan-flow-list for artifact backed flow/i
    }))

    expect(readFlowPlan).toHaveBeenCalledWith({ flowId: 'artifact-backed-flow' })
    const planPanel = await within(flowPane).findByRole('region', {
      name: /artifact backed flow linked plan/i
    })
    expect(planPanel).toHaveTextContent('Plan: Linked Plan')
    expect(planPanel).toHaveTextContent('Ship the CLI.')
  })

  it('renders Flow terminal tabs and routes terminal controls through scoped preload calls', async () => {
    const user = userEvent.setup()
    const terminalState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            id: 'terminal-flow',
            title: 'Terminal Flow',
            status: 'active',
            repositoryId: '/repos/grindstone',
            repositoryPath: '/repos/grindstone',
            createdAt: '2026-06-14T10:00:00.000Z',
            updatedAt: '2026-06-14T10:01:00.000Z',
            merge: { status: 'pending' },
            terminals: [
              {
                terminalId: 'terminal-plan',
                launchId: 'launch-plan',
                provider: 'codex',
                mode: 'interactive',
                flowId: 'terminal-flow',
                phaseId: 'plan',
                status: 'running',
                command: 'codex',
                argv: ['Implement plan'],
                cwd: '/worktree',
                logPath: '/artifacts/flows/terminal-flow/terminals/terminal-plan/raw.log',
                startedAt: '2026-06-14T10:00:00.000Z',
                recentOutput: 'Plan terminal ready\n'
              }
            ]
          }
        ]
      }
    }
    const terminalApi = {
      listTerminals: vi.fn().mockResolvedValue([]),
      writeTerminalInput: vi.fn().mockResolvedValue({}),
      resizeTerminal: vi.fn().mockResolvedValue({}),
      terminateTerminal: vi.fn().mockResolvedValue({}),
      dismissTerminal: vi.fn().mockResolvedValue({}),
      onTerminalEvent: vi.fn(() => () => undefined)
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(terminalState),
      vi.fn().mockResolvedValue(terminalState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: terminalState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(terminalState),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      terminalApi
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    const terminalPanel = within(flowPane).getByRole('region', {
      name: /terminal flow terminal sessions/i
    })
    expect(within(terminalPanel).getByRole('tab', { name: /plan running/i }))
      .toHaveAttribute('aria-selected', 'true')
    expect(within(terminalPanel).getByLabelText(/plan terminal output/i))
      .toHaveTextContent('Plan terminal ready')
    expect(within(terminalPanel).getByText('Fallback log ready')).toBeInTheDocument()

    await user.type(within(terminalPanel).getByLabelText(/plan terminal input text/i), 'q')
    await user.click(within(terminalPanel).getByRole('button', { name: /^send$/i }))
    expect(within(terminalPanel).getByRole('button', { name: /resize plan terminal/i }))
      .toBeDisabled()
    await user.click(within(terminalPanel).getByRole('button', { name: /terminate plan terminal/i }))

    const scopedRequest = {
      repositoryId: '/repos/grindstone',
      flowId: 'terminal-flow',
      terminalId: 'terminal-plan'
    }
    expect(terminalApi.writeTerminalInput).toHaveBeenCalledWith({
      ...scopedRequest,
      data: 'q'
    })
    expect(terminalApi.resizeTerminal).not.toHaveBeenCalled()
    expect(window.confirm).toHaveBeenCalledWith('Terminate codex terminal?')
    expect(terminalApi.terminateTerminal).toHaveBeenCalledWith(scopedRequest)
    expect(within(terminalPanel).getByRole('button', { name: /dismiss plan terminal/i }))
      .toBeDisabled()
  })

  it('caps live terminal output events to the recent-output limit', async () => {
    let terminalHandler: ((event: TerminalEvent) => void) | undefined
    const terminalState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            id: 'terminal-flow',
            title: 'Terminal Flow',
            status: 'active',
            repositoryId: '/repos/grindstone',
            repositoryPath: '/repos/grindstone',
            createdAt: '2026-06-14T10:00:00.000Z',
            updatedAt: '2026-06-14T10:01:00.000Z',
            merge: { status: 'pending' },
            terminals: [
              {
                terminalId: 'terminal-plan',
                launchId: 'launch-plan',
                provider: 'codex',
                mode: 'interactive',
                flowId: 'terminal-flow',
                phaseId: 'plan',
                status: 'running',
                command: 'codex',
                argv: ['Implement plan'],
                cwd: '/worktree',
                startedAt: '2026-06-14T10:00:00.000Z',
                recentOutput: 'seed'
              }
            ]
          }
        ]
      }
    }
    const terminalApi = {
      listTerminals: vi.fn().mockResolvedValue([]),
      writeTerminalInput: vi.fn().mockResolvedValue({}),
      resizeTerminal: vi.fn().mockResolvedValue({}),
      terminateTerminal: vi.fn().mockResolvedValue({}),
      dismissTerminal: vi.fn().mockResolvedValue({}),
      onTerminalEvent: vi.fn((_request: unknown, handler: (event: TerminalEvent) => void) => {
        terminalHandler = handler
        return () => undefined
      })
    }
    setWorkspaceApi(
      vi.fn().mockResolvedValue(terminalState),
      vi.fn().mockResolvedValue(terminalState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: terminalState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(terminalState),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      terminalApi
    )

    render(<App />)
    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    const terminalOutput = within(flowPane).getByLabelText(/plan terminal output/i)
    await waitFor(() => {
      expect(terminalHandler).toBeDefined()
    })

    act(() => {
      terminalHandler?.({
        type: 'output',
        repositoryId: '/repos/grindstone',
        flowId: 'terminal-flow',
        terminalId: 'terminal-plan',
        data: 'x'.repeat(RECENT_TERMINAL_OUTPUT_LIMIT + 10)
      })
    })

    expect(terminalOutput.textContent).toHaveLength(RECENT_TERMINAL_OUTPUT_LIMIT)
    expect(terminalOutput.textContent?.startsWith('seed')).toBe(false)
  })

  it('computes xterm append chunks when the recent-output buffer rolls forward', () => {
    const previousOutput = 'x'.repeat(RECENT_TERMINAL_OUTPUT_LIMIT)
    const rolledOutput = `${'x'.repeat(RECENT_TERMINAL_OUTPUT_LIMIT - 1)}y`

    expect(getTerminalOutputAppend(previousOutput, rolledOutput)).toBe('y')
    expect(getTerminalOutputAppend('abc', 'abcdef')).toBe('def')
    expect(getTerminalOutputAppend('abc', 'xyz')).toBe('xyz')
  })

  it('opens Flow creation in a modal, submits through preload, and clears after success', async () => {
    const user = userEvent.setup()
    const createdState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: null
        },
        flows: [
          {
            id: 'ship-workspace-creation',
            title: 'Ship workspace creation',
            status: 'active',
            repositoryId: '/repos/grindstone',
            repositoryPath: '/repos/grindstone',
            merge: { status: 'pending' },
            branch: 'flow/ship-workspace-creation',
            worktreePath: '/repos/grindstone-worktrees/flow-ship-workspace-creation',
            baseRef: 'main',
            commit: 'abc123',
            createdAt: '2026-06-14T10:00:00.000Z',
            updatedAt: '2026-06-14T10:01:00.000Z'
          }
        ]
      }
    }
    const createFlow = vi.fn().mockResolvedValue(createdState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: selectedCatalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      createFlow
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    expect(within(flowPane).queryByLabelText(/^title$/i)).not.toBeInTheDocument()

    await user.click(within(flowPane).getByRole('button', { name: /new flow/i }))

    const dialog = await screen.findByRole('dialog', { name: /create flow/i })
    const titleInput = within(dialog).getByLabelText(/^title$/i)
    const closeButton = within(dialog).getByRole('button', { name: /close flow creation/i })
    expect(titleInput).toHaveFocus()
    const sentinels = dialog.querySelectorAll<HTMLElement>('[data-focus-sentinel="true"]')
    expect(sentinels).toHaveLength(2)
    sentinels[0]?.focus()
    expect(closeButton).toHaveFocus()
    sentinels[1]?.focus()
    expect(titleInput).toHaveFocus()
    titleInput.focus()
    await user.type(within(dialog).getByLabelText(/^title$/i), 'Ship workspace creation')
    await user.type(within(dialog).getByLabelText(/instructions/i), 'Build the path')
    await user.type(within(dialog).getByLabelText(/base ref/i), 'main')
    await user.click(within(dialog).getByRole('button', { name: /create flow/i }))

    expect(createFlow).toHaveBeenCalledWith({
      title: 'Ship workspace creation',
      instructions: 'Build the path',
      baseRef: 'main'
    } satisfies CreateFlowRequest)
    expect(await within(flowPane).findByText('Ship workspace creation')).toBeInTheDocument()
    expect(within(flowPane).getByText('flow/ship-workspace-creation')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /create flow/i })).not.toBeInTheDocument()

    await user.click(within(flowPane).getByRole('button', { name: /new flow/i }))
    expect(within(await screen.findByRole('dialog', { name: /create flow/i })).getByLabelText(/^title$/i))
      .toHaveValue('')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: /create flow/i })).not.toBeInTheDocument()
    expect(within(flowPane).getByRole('button', { name: /new flow/i })).toHaveFocus()
  })

  it('opens Flow creation from the enabled right-pane shortcut', async () => {
    const user = userEvent.setup()
    const stateWithEnabledShortcut: InitialWorkspaceState = {
      ...selectedCatalogState,
      shortcuts: selectedCatalogState.shortcuts.map((shortcut) =>
        shortcut.id === 'new-flow'
          ? { ...shortcut, disabled: false }
          : shortcut
      )
    }
    setWorkspaceApi(vi.fn().mockResolvedValue(stateWithEnabledShortcut))

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    expect(within(flowPane).queryByLabelText(/^title$/i)).not.toBeInTheDocument()
    const contextPane = await screen.findByRole('region', { name: /contextual hints/i })
    const newFlowShortcut = within(contextPane).getByRole('button', { name: /new flow/i })
    expect(newFlowShortcut).toBeEnabled()

    await user.click(newFlowShortcut)

    expect(await screen.findByRole('dialog', { name: /create flow/i })).toBeInTheDocument()
  })

  it('keeps failed Flow creation input in the modal and renders persisted start failures', async () => {
    const user = userEvent.setup()
    const failedState: InitialWorkspaceState = {
      ...selectedCatalogState,
      flow: {
        status: 'ready',
        repositoryId: '/repos/grindstone',
        repositoryName: 'grindstone',
        create: {
          available: true,
          error: {
            code: 'bootstrap_failed',
            message: 'npm install failed'
          }
        },
        flows: [
          {
            id: 'broken-bootstrap',
            title: 'Broken bootstrap',
            status: 'failed',
            repositoryId: '/repos/grindstone',
            repositoryPath: '/repos/grindstone',
            merge: { status: 'pending' },
            branch: 'flow/broken-bootstrap',
            worktreePath: '/repos/grindstone-worktrees/flow-broken-bootstrap',
            baseRef: 'HEAD',
            commit: 'abc123',
            failure: {
              stage: 'bootstrap',
              message: 'npm install failed',
              command: 'npm install',
              output: 'missing package'
            },
            createdAt: '2026-06-14T10:00:00.000Z',
            updatedAt: '2026-06-14T10:01:00.000Z'
          }
        ]
      }
    }
    const createFlow = vi.fn().mockResolvedValue(failedState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: selectedCatalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(catalogState),
      createFlow
    )

    render(<App />)

    const flowPane = await screen.findByRole('main', { name: /flow workspace/i })
    await user.click(within(flowPane).getByRole('button', { name: /new flow/i }))

    const dialog = await screen.findByRole('dialog', { name: /create flow/i })
    await user.type(within(dialog).getByLabelText(/^title$/i), 'Broken bootstrap')
    await user.type(within(dialog).getByLabelText(/instructions/i), 'Run hooks')
    await user.click(within(dialog).getByRole('button', { name: /create flow/i }))

    expect(await within(dialog).findByRole('alert', { name: /flow creation error/i }))
      .toHaveTextContent('npm install failed')
    const failedRows = within(
      within(flowPane).getByRole('table', { name: /grindstone flow records/i })
    ).getAllByRole('row')
    const failedRow = failedRows[1]
    expect(failedRow).toHaveTextContent('Broken bootstrap')
    expect(failedRow).toHaveTextContent('failed')
    expect(failedRow).toHaveTextContent('bootstrap: npm install failed')
    expect(failedRow).not.toHaveTextContent('missing package')
    const detailsButton = within(failedRow as HTMLElement).getByRole('button', {
      name: /broken bootstrap details/i
    })
    expect(detailsButton).toHaveAttribute('title', expect.stringContaining('Failure: bootstrap'))
    expect(detailsButton).toHaveAttribute('title', expect.stringContaining('Command: npm install'))
    expect(detailsButton).toHaveAttribute('title', expect.stringContaining('Output: missing package'))
    await user.click(detailsButton)
    expect(await within(flowPane).findByRole('region', { name: /broken bootstrap details/i }))
      .toHaveTextContent('Output: missing package')
    expect(within(dialog).getByLabelText(/^title$/i)).toHaveValue('Broken bootstrap')
  })

  it('shows repo-scoped loading while repository selection is pending', async () => {
    const user = userEvent.setup()
    let resolveSelection: (state: InitialWorkspaceState) => void = () => undefined
    const selectRepository = vi.fn(
      () => new Promise<InitialWorkspaceState>((resolve) => {
        resolveSelection = resolve
      })
    )
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState), selectRepository)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /grindstone/i }))

    expect(screen.getByRole('status', { name: /flow workspace loading/i })).toHaveTextContent(
      'Loading grindstone Flows'
    )

    resolveSelection(selectedCatalogState)
    expect(await screen.findByText('Artifact backed Flow')).toBeInTheDocument()
  })

  it('keeps the latest repository selection when earlier IPC responses finish later', async () => {
    const user = userEvent.setup()
    let resolveAlpha: (state: InitialWorkspaceState) => void = () => undefined
    let resolveBeta: (state: InitialWorkspaceState) => void = () => undefined
    const selectRepository = vi.fn(({ repositoryId }: { repositoryId: string }) =>
      new Promise<InitialWorkspaceState>((resolve) => {
        if (repositoryId === '/repos/alpha') {
          resolveAlpha = resolve
        } else {
          resolveBeta = resolve
        }
      })
    )
    setWorkspaceApi(vi.fn().mockResolvedValue(multiRepositoryCatalogState), selectRepository)

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    await user.click(within(repositoryPane).getByRole('button', { name: /alpha/i }))
    await user.click(within(repositoryPane).getByRole('button', { name: /beta/i }))

    await act(async () => {
      resolveBeta(betaSelectedCatalogState)
    })
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent('Beta Flow')

    await act(async () => {
      resolveAlpha(alphaSelectedCatalogState)
    })
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent('Beta Flow')
    expect(screen.getByRole('main', { name: /flow workspace/i })).not.toHaveTextContent('Alpha Flow')
    expect(within(repositoryPane).getByRole('button', { name: /beta/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders selected repository empty and artifact error Flow states', async () => {
    const user = userEvent.setup()
    const selectRepository = vi
      .fn()
      .mockResolvedValueOnce(emptySelectedCatalogState)
      .mockResolvedValueOnce(errorSelectedCatalogState)
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState), selectRepository)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /grindstone/i }))
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'No Flows for grindstone'
    )

    await user.click(
      within(screen.getByRole('region', { name: /^repos$/i }))
        .getByRole('button', { name: /grindstone/i })
    )
    expect(
      await screen.findByRole('alert', { name: /flow workspace error/i })
    ).toHaveTextContent('Flow artifact store unavailable')
  })

  it('shows a Flow-only loading state while the initial workspace state is pending', () => {
    setWorkspaceApi(vi.fn(() => new Promise<typeof defaultInitialState>(() => undefined)))

    render(<App />)

    expect(
      screen.getByRole('status', { name: /flow workspace loading/i })
    ).toHaveTextContent('Loading Flow workspace')
  })

  it('shows a Flow-scoped error when initial workspace state fails', async () => {
    setWorkspaceApi(vi.fn().mockRejectedValue({ name: 'Error', message: 'IPC offline' }))

    render(<App />)

    expect(
      await screen.findByRole('alert', { name: /flow workspace error/i })
    ).toHaveTextContent('IPC offline')
  })

  it('shows a Flow-scoped error for standalone middle-pane route attempts', async () => {
    window.history.pushState({}, '', '/plans')
    setWorkspaceApi(vi.fn().mockResolvedValue(defaultInitialState))

    render(<App />)

    expect(
      await screen.findByRole('alert', { name: /flow workspace error/i })
    ).toHaveTextContent('Only Flow workspace routes are available in this shell.')
    expect(screen.queryByText('No Flow selected')).not.toBeInTheDocument()
  })

  it('renders disabled Flow shortcut affordances in the right pane', async () => {
    setWorkspaceApi(vi.fn().mockResolvedValue(defaultInitialState))

    render(<App />)

    const contextPane = await screen.findByRole('region', { name: /contextual hints/i })
    const newFlow = within(contextPane).getByRole('button', { name: /new flow/i })
    const continueFlow = within(contextPane).getByRole('button', { name: /continue flow/i })

    expect(newFlow).toBeDisabled()
    expect(continueFlow).toBeDisabled()
    expect(within(contextPane).getByText(/Plans and sessions stay attached/i)).toBeInTheDocument()
  })

  it('disables repository creation when no scan roots are configured', async () => {
    setWorkspaceApi(vi.fn().mockResolvedValue(defaultInitialState))

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    expect(
      within(repositoryPane).getByRole('button', { name: /create repository/i })
    ).toBeDisabled()
    expect(within(repositoryPane).queryByLabelText(/repository name/i)).not.toBeInTheDocument()
  })

  it('submits repository creation through preload and updates the catalog', async () => {
    const user = userEvent.setup()
    const createdState: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        repositories: [
          ...catalogState.repository.repositories,
          {
            id: '/repos/new-repo',
            name: 'new-repo',
            path: '/repos/new-repo',
            canonicalPath: '/repos/new-repo',
            sources: ['scan_root']
          }
        ],
        description: '2 repositories configured.'
      }
    }
    const createRepository = vi.fn().mockResolvedValue(createdState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: catalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      createRepository
    )

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    await user.click(within(repositoryPane).getByRole('button', { name: /create repository/i }))
    const dialog = await screen.findByRole('dialog', { name: /create repository/i })
    await user.type(within(dialog).getByLabelText(/repository name/i), 'new-repo')
    await user.click(within(dialog).getByLabelText(/create on github/i))
    await user.selectOptions(within(dialog).getByLabelText(/github visibility/i), 'private')
    await user.click(within(dialog).getByRole('button', { name: /^create repository$/i }))

    expect(createRepository).toHaveBeenCalledWith({
      scanRootId: 'scan-root:0:test',
      name: 'new-repo',
      github: {
        enabled: true,
        visibility: 'private'
      }
    } satisfies CreateRepositoryRequest)
    expect(await screen.findByRole('button', { name: /new-repo/i })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
  })

  it('shows create errors returned by the workspace handler', async () => {
    const user = userEvent.setup()
    const errorState: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        create: {
          ...catalogState.repository.create,
          error: {
            code: 'target_exists',
            message: 'Repository already exists: /repos/new-repo'
          }
        }
      }
    }
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: catalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(errorState)
    )

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    const launcher = within(repositoryPane).getByRole('button', { name: /create repository/i })
    await user.click(launcher)
    let dialog = await screen.findByRole('dialog', { name: /create repository/i })
    await user.type(within(dialog).getByLabelText(/repository name/i), 'new-repo')
    await user.click(within(dialog).getByRole('button', { name: /^create repository$/i }))

    expect(await within(dialog).findByRole('alert', { name: /repository creation error/i }))
      .toHaveTextContent('Repository already exists: /repos/new-repo')
    expect(screen.getByRole('dialog', { name: /create repository/i })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /close repository creation/i }))
    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
    await user.click(launcher)
    dialog = await screen.findByRole('dialog', { name: /create repository/i })
    expect(within(dialog).getByRole('alert', { name: /repository creation error/i }))
      .toHaveTextContent('Repository already exists: /repos/new-repo')
  })

  it('resets transient repository creation input when the modal is dismissed', async () => {
    const user = userEvent.setup()
    const multipleScanRootState: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        create: {
          ...catalogState.repository.create,
          scanRoots: [
            ...catalogState.repository.create.scanRoots,
            {
              id: 'scan-root:1:archive',
              configuredPath: '/archive',
              resolvedPath: '/archive',
              displayPath: '/archive'
            }
          ]
        }
      }
    }
    setWorkspaceApi(vi.fn().mockResolvedValue(multipleScanRootState))

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /^repos$/i })
    const launcher = within(repositoryPane).getByRole('button', { name: /create repository/i })
    await user.click(launcher)
    let dialog = await screen.findByRole('dialog', { name: /create repository/i })
    await user.selectOptions(within(dialog).getByLabelText(/scan root/i), 'scan-root:1:archive')
    await user.type(within(dialog).getByLabelText(/repository name/i), 'draft-repo')
    await user.click(within(dialog).getByLabelText(/create on github/i))
    await user.selectOptions(within(dialog).getByLabelText(/github visibility/i), 'public')
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))

    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
    expect(launcher).toHaveFocus()

    await user.click(launcher)
    dialog = await screen.findByRole('dialog', { name: /create repository/i })
    expect(within(dialog).getByLabelText(/repository name/i)).toHaveValue('')
    expect(within(dialog).getByLabelText(/scan root/i)).toHaveValue('scan-root:0:test')
    expect(within(dialog).getByLabelText(/create on github/i)).not.toBeChecked()
    expect(within(dialog).getByLabelText(/github visibility/i)).toHaveValue('private')
  })

  it('renders partial GitHub failure retry controls and retries remote setup', async () => {
    const user = userEvent.setup()
    const retryState: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        create: {
          ...catalogState.repository.create,
          remoteRetries: [
            {
              id: 'remote-retry:/repos/new-repo',
              repositoryId: '/repos/new-repo',
              repositoryPath: '/repos/new-repo',
              githubRepositoryName: 'new-repo',
              visibility: 'private',
              status: 'remote_create_failed',
              lastError: 'gh auth failed',
              expectedOriginUrl: null
            }
          ]
        }
      }
    }
    const retrySucceededState: InitialWorkspaceState = {
      ...retryState,
      repository: {
        ...retryState.repository,
        create: {
          ...retryState.repository.create,
          remoteRetries: []
        }
      }
    }
    const retryRepositoryRemote = vi.fn().mockResolvedValue(retrySucceededState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(retryState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: catalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      retryRepositoryRemote
    )

    render(<App />)

    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
    expect(await screen.findByText('gh auth failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry remote for new-repo/i }))

    expect(retryRepositoryRemote).toHaveBeenCalledWith({
      retryId: 'remote-retry:/repos/new-repo'
    })
    expect(screen.queryByText('gh auth failed')).not.toBeInTheDocument()
  })

  it('shows remote retry failures outside the create modal', async () => {
    const user = userEvent.setup()
    const retryState: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        create: {
          ...catalogState.repository.create,
          remoteRetries: [
            {
              id: 'remote-retry:/repos/new-repo',
              repositoryId: '/repos/new-repo',
              repositoryPath: '/repos/new-repo',
              githubRepositoryName: 'new-repo',
              visibility: 'private',
              status: 'remote_create_failed',
              lastError: 'gh auth failed',
              expectedOriginUrl: null
            }
          ]
        }
      }
    }
    const retryRepositoryRemote = vi.fn().mockRejectedValue(new Error('gh auth expired'))
    setWorkspaceApi(
      vi.fn().mockResolvedValue(retryState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: catalogState,
        config: editableConfigState
      } satisfies ConfigUpdateResponse),
      vi.fn().mockResolvedValue(catalogState),
      retryRepositoryRemote
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /retry remote for new-repo/i }))

    expect(screen.queryByRole('dialog', { name: /create repository/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('alert', { name: /repository remote retry error/i }))
      .toHaveTextContent('gh auth expired')
    expect(screen.getByRole('alert', { name: /repository remote retry error/i }))
      .toHaveTextContent('new-repo')
  })

  it('opens the common config panel with existing editable values', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))

    expect(await screen.findByRole('region', { name: /common config/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Scan root 1')).toHaveValue('/repos')
    expect(screen.getByLabelText('Repository 1')).toHaveValue('/repos/grindstone')
    expect(screen.getByLabelText('Default agent')).toHaveValue('codex')
    expect(screen.getByLabelText('Artifact root')).toHaveValue('./artifacts')
    expect(screen.getByLabelText('Hook 1 command')).toHaveValue('npm install')
    expect(screen.getByLabelText('Hook 1 environment')).toHaveValue('NODE_ENV=test')
  })

  it('preserves unsaved common config edits when collapsing and expanding the right pane', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))
    await user.clear(await screen.findByLabelText('Artifact root'))
    await user.type(screen.getByLabelText('Artifact root'), './draft-artifacts')

    const configPane = screen.getByRole('region', { name: /common config/i })
    await user.click(within(configPane).getByRole('button', { name: /collapse right pane/i }))

    expect(screen.queryByRole('region', { name: /common config/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /expand right pane/i }))

    expect(await screen.findByRole('region', { name: /common config/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Artifact root')).toHaveValue('./draft-artifacts')
  })

  it('does not save an empty draft when editable config fails to load', async () => {
    const user = userEvent.setup()
    const updateCommonConfig = vi.fn()
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockRejectedValue({ name: 'Error', message: 'Invalid Grindstone config' }),
      updateCommonConfig
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))

    expect(await screen.findByText('Invalid Grindstone config')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(updateCommonConfig).not.toHaveBeenCalled()
  })

  it('saves edited common config through preload', async () => {
    const user = userEvent.setup()
    const updateCommonConfig = vi.fn().mockResolvedValue({
      ok: true,
      workspace: catalogState,
      config: editableConfigState
    } satisfies ConfigUpdateResponse)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      updateCommonConfig
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))
    await user.click(await screen.findByRole('button', { name: /add scan root/i }))
    await user.type(screen.getByLabelText('Scan root 2'), '/more-repos')
    await user.selectOptions(screen.getByLabelText('Default agent'), 'claude')
    await user.clear(screen.getByLabelText('Artifact root'))
    await user.type(screen.getByLabelText('Artifact root'), './new-artifacts')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(updateCommonConfig).toHaveBeenCalledWith({
      scan_roots: ['/repos', '/more-repos'],
      repos: ['/repos/grindstone'],
      default_agent: 'claude',
      artifact_root: './new-artifacts',
      bootstrap_hooks: [
        {
          sourceIndex: 0,
          name: 'Install',
          command: 'npm install',
          cwd: './app',
          env: {
            NODE_ENV: 'test'
          }
        }
      ]
    } satisfies CommonConfigUpdateInput)
    expect(await screen.findByRole('status')).toHaveTextContent('Config saved')
  })

  it('shows configured bootstrap hooks as read-only trusted config', async () => {
    const user = userEvent.setup()
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn()
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))

    expect(screen.queryByRole('button', { name: /add hook/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove hook/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Hook 1 command')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Hook 1 environment')).toHaveAttribute('readonly')
  })

  it('shows field validation errors and keeps unsaved input visible', async () => {
    const user = userEvent.setup()
    const updateCommonConfig = vi.fn().mockResolvedValue({
      ok: false,
      kind: 'validation',
      errors: [
        {
          field: 'scan_roots[0]',
          message: 'scan_roots entries must be non-empty strings.'
        }
      ]
    } satisfies ConfigUpdateResponse)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      updateCommonConfig
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))
    await user.clear(screen.getByLabelText('Scan root 1'))
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('scan_roots entries must be non-empty strings.'))
      .toBeInTheDocument()
    expect(screen.getByLabelText('Scan root 1')).toHaveValue('')
  })

  it('refreshes repository catalog state returned by a successful config save', async () => {
    const user = userEvent.setup()
    const refreshedWorkspace: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        description: '2 repositories configured.',
        repositories: [
          ...catalogState.repository.repositories,
          {
            id: '/repos/another',
            name: 'another',
            path: '/repos/another',
            canonicalPath: '/repos/another',
            sources: ['explicit']
          }
        ]
      }
    }
    setWorkspaceApi(
      vi.fn().mockResolvedValue(catalogState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(editableConfigState),
      vi.fn().mockResolvedValue({
        ok: true,
        workspace: refreshedWorkspace,
        config: {
          ...editableConfigState,
          repos: ['/repos/grindstone', '/repos/another']
        }
      } satisfies ConfigUpdateResponse)
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    const repositoryPane = screen.getByRole('region', { name: /^repos$/i })
    expect(await within(repositoryPane).findByRole('button', { name: /another/i }))
      .toBeInTheDocument()
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'No Flow selected'
    )
  })

  it('shows reload failures as saved-but-not-refreshed config feedback with a manual reload path', async () => {
    const user = userEvent.setup()
    const refreshedWorkspace: InitialWorkspaceState = {
      ...catalogState,
      repository: {
        ...catalogState.repository,
        description: '2 repositories configured.',
        repositories: [
          ...catalogState.repository.repositories,
          {
            id: '/repos/reloaded',
            name: 'reloaded',
            path: '/repos/reloaded',
            canonicalPath: '/repos/reloaded',
            sources: ['explicit']
          }
        ]
      }
    }
    const getInitialState = vi.fn()
      .mockResolvedValueOnce(catalogState)
      .mockResolvedValueOnce(refreshedWorkspace)
    const getEditableConfig = vi.fn()
      .mockResolvedValueOnce(editableConfigState)
      .mockResolvedValueOnce({
        ...editableConfigState,
        repos: ['/repos/grindstone', '/repos/reloaded']
      } satisfies EditableConfigState)

    setWorkspaceApi(
      getInitialState,
      vi.fn().mockResolvedValue(selectedCatalogState),
      getEditableConfig,
      vi.fn().mockResolvedValue({
        ok: false,
        kind: 'reload_failed',
        configPath: '/configs/grindstone.toml',
        message: 'Could not reload repository catalog.',
        config: editableConfigState
      } satisfies ConfigUpdateResponse)
    )

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /configure/i }))
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Config saved to /configs/grindstone.toml, but reload failed: Could not reload repository catalog.'
    )

    await user.click(screen.getByRole('button', { name: /reload config/i }))

    expect(getInitialState).toHaveBeenCalledTimes(2)
    expect(getEditableConfig).toHaveBeenCalledTimes(2)
    const repositoryPane = screen.getByRole('region', { name: /^repos$/i })
    expect(await within(repositoryPane).findByRole('button', { name: /reloaded/i }))
      .toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Config reloaded')
  })
})
