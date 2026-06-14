import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { InitialWorkspaceState } from '@shared/workspace'

const defaultInitialState: InitialWorkspaceState = {
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
    ]
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
    repositoryName: 'grindstone'
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

const setWorkspaceApi = (
  getInitialState: () => Promise<InitialWorkspaceState>,
  selectRepository = vi.fn().mockResolvedValue(selectedCatalogState)
): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState,
        selectRepository
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
})
