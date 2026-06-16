import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const currentWindow = {
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn()
    }
  }
  const browserWindow = vi.fn(function BrowserWindow() {
    return currentWindow
  })
  Object.assign(browserWindow, {
    getAllWindows: vi.fn(() => [])
  })

  return {
    app: {
      on: vi.fn(),
      quit: vi.fn(),
      setName: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve())
    },
    browserWindow,
    currentWindow,
    ipcMain: {},
    shell: {
      openExternal: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.browserWindow,
  ipcMain: electron.ipcMain,
  shell: electron.shell
}))

vi.mock('./workspaceHandlers', () => ({
  registerWorkspaceHandlers: vi.fn()
}))

describe('main process entrypoint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('sets the native app name used by the menu bar', async () => {
    await import('./index')

    expect(electron.app.setName).toHaveBeenCalledWith('Grindstone')
  })

  it('denies renderer-created windows and opens HTTPS links externally', async () => {
    await import('./index')
    await Promise.resolve()

    expect(electron.currentWindow.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = electron.currentWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (
      details: { url: string }
    ) => { action: 'deny' }

    expect(handler({ url: 'https://github.com/acme/grindstone/pull/44' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://github.com/acme/grindstone/pull/44')

    expect(handler({ url: 'file:///tmp/unsafe.html' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
  })
})
