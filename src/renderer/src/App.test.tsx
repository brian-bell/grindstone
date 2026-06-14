import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type {
  CommonConfigUpdateInput,
  ConfigUpdateResponse,
  EditableConfigState
} from '@shared/config'
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

const editableConfigState: EditableConfigState = {
  configPath: '/configs/grindstone.toml',
  scan_roots: ['/repos'],
  repos: ['/repos/grindstone'],
  default_agent: 'codex',
  artifact_root: './artifacts',
  bootstrap_hooks: [
    {
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
  } satisfies ConfigUpdateResponse)
): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState,
        selectRepository
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
    await user.click(screen.getByRole('button', { name: /add hook/i }))
    await user.type(screen.getByLabelText('Hook 2 command'), 'npm test')
    await user.type(screen.getByLabelText('Hook 2 environment'), 'CI=true')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(updateCommonConfig).toHaveBeenCalledWith({
      scan_roots: ['/repos', '/more-repos'],
      repos: ['/repos/grindstone'],
      default_agent: 'claude',
      artifact_root: './new-artifacts',
      bootstrap_hooks: [
        {
          name: 'Install',
          command: 'npm install',
          cwd: './app',
          env: {
            NODE_ENV: 'test'
          }
        },
        {
          command: 'npm test',
          env: {
            CI: 'true'
          }
        }
      ]
    } satisfies CommonConfigUpdateInput)
    expect(await screen.findByRole('status')).toHaveTextContent('Config saved')
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
