import { render, screen, within } from '@testing-library/react'
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
    status: 'empty',
    title: 'grindstone Flow workspace',
    description: 'Flow context is scoped to /repos/grindstone.'
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
})
