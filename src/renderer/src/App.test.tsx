import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const defaultInitialState = {
  repository: {
    status: 'empty',
    title: 'No repository selected',
    description: 'Repository catalog integration will connect this area to Flow setup.'
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

const setWorkspaceApi = (getInitialState: () => Promise<typeof defaultInitialState>): void => {
  Object.defineProperty(window, 'grindstone', {
    configurable: true,
    value: {
      workspace: {
        getInitialState
      }
    }
  })
}

describe('App shell', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'grindstone')
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

    expect(within(repositoryPane).getByText('No repository selected')).toBeInTheDocument()
    expect(within(flowPane).getByText('No Flow selected')).toBeInTheDocument()
    expect(within(contextPane).getByText('Select a repository')).toBeInTheDocument()
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
