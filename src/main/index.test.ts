import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const browserWindow = vi.fn(function BrowserWindow() {
    return {
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
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
    ipcMain: {}
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.browserWindow,
  ipcMain: electron.ipcMain
}))

vi.mock('./workspaceHandlers', () => ({
  registerWorkspaceHandlers: vi.fn()
}))

describe('main process entrypoint', () => {
  it('sets the native app name used by the menu bar', async () => {
    await import('./index')

    expect(electron.app.setName).toHaveBeenCalledWith('Grindstone')
  })
})
