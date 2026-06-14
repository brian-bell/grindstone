import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type {
  CommonConfigUpdateInput,
  ConfigUpdateResponse,
  EditableConfigState
} from '@shared/config'
import type { CreateFlowRequest, CreateRepositoryRequest, InitialWorkspaceState } from '@shared/workspace'

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
        branch: 'flow/list',
        planId: 'plan-flow-list',
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-11T12:30:00.000Z',
        phases: [
          {
            id: 'phase-render',
            title: 'Render list',
            status: 'done',
            order: 1,
            summary: 'Rows are visible'
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
  createFlow = vi.fn().mockResolvedValue(selectedCatalogState)
): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState,
        selectRepository,
        createFlow,
        createRepository,
        retryRepositoryRemote
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

    expect(
      await screen.findByRole('region', { name: /repository area/i })
    ).toBeInTheDocument()

    const repositoryPane = screen.getByRole('region', { name: /repository area/i })
    const flowPane = screen.getByRole('main', { name: /flow workspace/i })
    const contextPane = screen.getByRole('region', { name: /contextual hints/i })

    expect(within(repositoryPane).getByText('No repositories configured')).toBeInTheDocument()
    expect(within(flowPane).getByText('No Flow selected')).toBeInTheDocument()
    expect(within(contextPane).getByText('Select a repository')).toBeInTheDocument()
  })

  it('renders configured repositories and non-fatal catalog diagnostics', async () => {
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState))

    render(<App />)

    const repositoryPane = await screen.findByRole('region', { name: /repository area/i })
    expect(within(repositoryPane).getByRole('button', { name: /grindstone/i })).toHaveTextContent(
      '/repos/grindstone'
    )
    expect(within(repositoryPane).getByText('explicit')).toBeInTheDocument()
    expect(within(repositoryPane).getByRole('alert')).toHaveTextContent('/missing/repo')
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'No Flow selected'
    )
  })

  it('selects a repository through preload and renders its Flow rows', async () => {
    const user = userEvent.setup()
    const selectRepository = vi.fn().mockResolvedValue(selectedCatalogState)
    setWorkspaceApi(vi.fn().mockResolvedValue(catalogState), selectRepository)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /grindstone/i }))

    expect(selectRepository).toHaveBeenCalledWith({ repositoryId: '/repos/grindstone' })
    expect(screen.getByRole('button', { name: /grindstone/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const flowPane = screen.getByRole('main', { name: /flow workspace/i })
    expect(flowPane).toHaveTextContent('Artifact backed Flow')
    expect(flowPane).toHaveTextContent('active')
    expect(flowPane).toHaveTextContent('Updated 2026-06-11T12:30:00.000Z')
    expect(flowPane).toHaveTextContent('flow/list')
    expect(flowPane).toHaveTextContent('plan-flow-list')
    expect(flowPane).toHaveTextContent('Render list')
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
    expect(within(flowPane).getByText('npm install')).toBeInTheDocument()
    expect(within(flowPane).getByText('missing package')).toBeInTheDocument()
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

    await user.click(await screen.findByRole('button', { name: /alpha/i }))
    await user.click(screen.getByRole('button', { name: /beta/i }))

    await act(async () => {
      resolveBeta(betaSelectedCatalogState)
    })
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent('Beta Flow')

    await act(async () => {
      resolveAlpha(alphaSelectedCatalogState)
    })
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent('Beta Flow')
    expect(screen.getByRole('main', { name: /flow workspace/i })).not.toHaveTextContent('Alpha Flow')
    expect(screen.getByRole('button', { name: /beta/i })).toHaveAttribute('aria-pressed', 'true')
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

    await user.click(screen.getByRole('button', { name: /grindstone/i }))
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

    const repositoryPane = await screen.findByRole('region', { name: /repository area/i })
    expect(
      within(repositoryPane).getByRole('button', { name: /create repository/i })
    ).toBeDisabled()
    expect(within(repositoryPane).getByLabelText(/repository name/i)).toBeDisabled()
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

    await user.type(await screen.findByLabelText(/repository name/i), 'new-repo')
    await user.click(screen.getByLabelText(/create on github/i))
    await user.selectOptions(screen.getByLabelText(/github visibility/i), 'private')
    await user.click(screen.getByRole('button', { name: /create repository/i }))

    expect(createRepository).toHaveBeenCalledWith({
      scanRootId: 'scan-root:0:test',
      name: 'new-repo',
      github: {
        enabled: true,
        visibility: 'private'
      }
    } satisfies CreateRepositoryRequest)
    expect(await screen.findByRole('button', { name: /new-repo/i })).toBeInTheDocument()
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

    await user.type(await screen.findByLabelText(/repository name/i), 'new-repo')
    await user.click(screen.getByRole('button', { name: /create repository/i }))

    expect(await screen.findByRole('alert', { name: /repository creation error/i }))
      .toHaveTextContent('Repository already exists: /repos/new-repo')
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

    expect(await screen.findByText('gh auth failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry remote for new-repo/i }))

    expect(retryRepositoryRemote).toHaveBeenCalledWith({
      retryId: 'remote-retry:/repos/new-repo'
    })
    expect(screen.queryByText('gh auth failed')).not.toBeInTheDocument()
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

    const repositoryPane = screen.getByRole('region', { name: /repository area/i })
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
    const repositoryPane = screen.getByRole('region', { name: /repository area/i })
    expect(await within(repositoryPane).findByRole('button', { name: /reloaded/i }))
      .toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Config reloaded')
  })
})
