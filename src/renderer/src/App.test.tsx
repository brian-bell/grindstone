import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { CreateRepositoryRequest, InitialWorkspaceState } from '@shared/workspace'

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
    status: 'empty',
    title: 'grindstone Flow workspace',
    description: 'Flow context is scoped to /repos/grindstone.'
  }
}

const setWorkspaceApi = (
  getInitialState: () => Promise<InitialWorkspaceState>,
  selectRepository = vi.fn().mockResolvedValue(selectedCatalogState),
  createRepository = vi.fn().mockResolvedValue(catalogState),
  retryRepositoryRemote = vi.fn().mockResolvedValue(catalogState)
): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState,
        selectRepository,
        createRepository,
        retryRepositoryRemote
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

  it('selects a repository through preload and scopes the Flow workspace', async () => {
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
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'grindstone Flow workspace'
    )
    expect(screen.getByRole('main', { name: /flow workspace/i })).toHaveTextContent(
      'Flow context is scoped to /repos/grindstone.'
    )
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
          remoteRetries: [
            {
              ...retryState.repository.create.remoteRetries[0],
              status: 'succeeded',
              lastError: ''
            }
          ]
        }
      }
    }
    const retryRepositoryRemote = vi.fn().mockResolvedValue(retrySucceededState)
    setWorkspaceApi(
      vi.fn().mockResolvedValue(retryState),
      vi.fn().mockResolvedValue(selectedCatalogState),
      vi.fn().mockResolvedValue(catalogState),
      retryRepositoryRemote
    )

    render(<App />)

    expect(await screen.findByText('gh auth failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry remote for new-repo/i }))

    expect(retryRepositoryRemote).toHaveBeenCalledWith({
      retryId: 'remote-retry:/repos/new-repo'
    })
    expect(await screen.findByText(/Remote setup succeeded/i)).toBeInTheDocument()
  })
})
