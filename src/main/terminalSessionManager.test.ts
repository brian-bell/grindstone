import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FlowListRow, RepositoryRow } from '@shared/workspace'
import { createFlowStore, type FlowStore } from './flowStore'
import {
  TerminalSessionManager,
  type PtyAdapter,
  type PtyProcess
} from './terminalSessionManager'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-terminal-'))
}

function repository(root: string): RepositoryRow {
  return {
    id: join(root, 'repo'),
    name: 'repo',
    path: join(root, 'repo'),
    canonicalPath: join(root, 'repo'),
    sources: ['explicit']
  }
}

function flow(root: string): FlowListRow {
  return {
    id: 'launch-terminal',
    title: 'Launch terminal',
    status: 'creating',
    repositoryId: join(root, 'repo'),
    repositoryPath: join(root, 'repo'),
    instructions: 'Implement the plan.',
    branch: 'flow/launch-terminal',
    worktreePath: join(root, 'worktree'),
    baseRef: 'main',
    commit: 'abc123',
    start: {
      repositoryPath: join(root, 'repo'),
      worktreePath: join(root, 'worktree'),
      branch: 'flow/launch-terminal',
      baseRef: 'main',
      commit: 'abc123'
    },
    planId: 'plan-123',
    planPath: join(root, 'plans', 'plan.md'),
    createdAt: '2026-06-14T12:00:00.000Z',
    updatedAt: '2026-06-14T12:00:00.000Z'
  }
}

async function waitForExpectation(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  throw lastError
}

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = []
  readonly resizes: Array<{ columns: number; rows: number }> = []
  readonly kills: string[] = []
  private dataHandlers: Array<(data: string) => void> = []
  private exitHandlers: Array<(event: { exitCode: number; signal?: string }) => void> = []

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandlers.push(handler)
    return { dispose: () => undefined }
  }

  onExit(handler: (event: { exitCode: number; signal?: string }) => void): { dispose: () => void } {
    this.exitHandlers.push(handler)
    return { dispose: () => undefined }
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows })
  }

  kill(signal?: string): void {
    this.kills.push(signal ?? 'SIGTERM')
  }

  emitData(data: string): void {
    this.dataHandlers.forEach((handler) => handler(data))
  }

  emitExit(event: { exitCode: number; signal?: string }): void {
    this.exitHandlers.forEach((handler) => handler(event))
  }
}

describe('terminal session manager', () => {
  it('launches a Flow terminal, persists fallback logs, and tracks lifecycle operations', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const store = await createFlowStore({ artifactRoot })
    const repo = repository(root)
    const repositoryId = await realpath(repo.path)
    const storedFlow = await store.createFlowRecord({
      id: 'launch-terminal',
      title: 'Launch terminal',
      instructions: 'Implement the plan.',
      status: 'creating',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    const launchFlow = {
      ...storedFlow,
      planId: 'plan-123',
      planPath: join(root, 'plans', 'plan.md')
    }
    const fakeProcess = new FakePtyProcess()
    const spawned: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = []
    const pty: PtyAdapter = {
      spawn(command, args, options) {
        spawned.push({ command, args, cwd: options.cwd, env: options.env })
        return fakeProcess
      }
    }
    const events: unknown[] = []
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      pty,
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn()
        .mockReturnValueOnce('terminal-123')
        .mockReturnValueOnce('launch-123'),
      onEvent: (event) => events.push(event)
    })

    const terminal = await manager.launchTerminal({
      flow: launchFlow,
      provider: 'codex',
      mode: 'interactive',
      phaseId: 'plan',
      prompt: 'Implement the approved plan.'
    })

    expect(terminal).toMatchObject({
      terminalId: 'terminal-123',
      launchId: 'launch-123',
      provider: 'codex',
      mode: 'interactive',
      flowId: 'launch-terminal',
      phaseId: 'plan',
      planId: 'plan-123',
      status: 'running',
      command: 'codex',
      argv: ['Implement the approved plan.'],
      cwd: join(root, 'worktree'),
      logPath: join(artifactRoot, 'flows', 'launch-terminal', 'terminals', 'terminal-123', 'raw.log')
    })
    await expect(stat(terminal.logPath ?? '')).resolves.toMatchObject({
      mode: expect.any(Number)
    })
    expect((await stat(terminal.logPath ?? '')).mode & 0o777).toBe(0o600)
    expect((await stat(join(
      artifactRoot,
      'flows',
      'launch-terminal',
      'terminals',
      'terminal-123',
      'meta.json'
    ))).mode & 0o777).toBe(0o600)
    expect(spawned).toEqual([
      expect.objectContaining({
        command: 'codex',
        args: ['Implement the approved plan.'],
        cwd: join(root, 'worktree'),
        env: expect.objectContaining({
          WTUI_FLOW_ID: 'launch-terminal',
          WTUI_FLOW_PHASE_ID: 'plan',
          WTUI_LAUNCH_ID: 'launch-123'
        })
      })
    ])

    fakeProcess.emitData('hello terminal\n')
    await waitForExpectation(async () => {
      await expect(readFile(terminal.logPath ?? '', 'utf8')).resolves.toBe('hello terminal\n')
    })
    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        terminals: [
          {
            terminalId: 'terminal-123',
            recentOutput: 'hello terminal\n'
          }
        ]
      })
    })
    await waitForExpectation(() => {
      expect(events).toContainEqual({
        type: 'output',
        repositoryId,
        flowId: 'launch-terminal',
        terminalId: 'terminal-123',
        data: 'hello terminal\n'
      })
    })

    await manager.writeInput({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123',
      data: 'q'
    })
    await manager.resize({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123',
      columns: 100,
      rows: 32
    })
    expect(fakeProcess.writes).toEqual(['q'])
    expect(fakeProcess.resizes).toEqual([{ columns: 100, rows: 32 }])

    fakeProcess.emitExit({ exitCode: 0 })
    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        terminals: [
          {
            terminalId: 'terminal-123',
            status: 'exited',
            exitCode: 0,
            endedAt: '2026-06-14T12:02:00.000Z'
          }
        ]
      })
    })

    await manager.dismiss({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123'
    })
    await expect(manager.listTerminals({
      repositoryId,
      flowId: 'launch-terminal'
    })).resolves.toEqual([
      expect.objectContaining({
        terminalId: 'terminal-123',
        status: 'dismissed'
      })
    ])
  })

  it('serializes concurrent terminal persists without dropping sibling terminals', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const realStore = await createFlowStore({ artifactRoot })
    const storedFlow = await realStore.createFlowRecord({
      id: 'launch-terminal',
      title: 'Launch terminal',
      instructions: 'Implement the plan.',
      status: 'active',
      repositoryPath: join(root, 'repo'),
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    let activeTerminalPersists = 0
    let maxActiveTerminalPersists = 0
    const delayedStore: FlowStore = {
      ...realStore,
      async updateFlowRecord(flowId, update) {
        if (update.terminals !== undefined) {
          activeTerminalPersists += 1
          maxActiveTerminalPersists = Math.max(
            maxActiveTerminalPersists,
            activeTerminalPersists
          )
          await new Promise((resolve) => setTimeout(resolve, 10))
          try {
            return await realStore.updateFlowRecord(flowId, update)
          } finally {
            activeTerminalPersists -= 1
          }
        }

        return realStore.updateFlowRecord(flowId, update)
      }
    }
    const processes = [new FakePtyProcess(), new FakePtyProcess()]
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: delayedStore,
      pty: {
        spawn() {
          const process = processes.shift()
          if (process === undefined) {
            throw new Error('unexpected extra spawn')
          }

          return process
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn()
        .mockReturnValueOnce('terminal-a')
        .mockReturnValueOnce('launch-a')
        .mockReturnValueOnce('terminal-b')
        .mockReturnValueOnce('launch-b')
    })

    await Promise.all([
      manager.launchTerminal({
        flow: storedFlow,
        provider: 'codex',
        mode: 'interactive',
        phaseId: 'plan',
        prompt: 'Implement the approved plan.'
      }),
      manager.launchTerminal({
        flow: storedFlow,
        provider: 'claude',
        mode: 'interactive',
        phaseId: 'review',
        prompt: 'Review the implementation.'
      })
    ])

    expect(maxActiveTerminalPersists).toBe(1)
    await expect(realStore.readFlow('launch-terminal')).resolves.toMatchObject({
      terminals: expect.arrayContaining([
        expect.objectContaining({ terminalId: 'terminal-a' }),
        expect.objectContaining({ terminalId: 'terminal-b' })
      ])
    })
  })

  it('reconciles persisted terminals without a live PTY and allows completed dismissal after reload', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const store = await createFlowStore({ artifactRoot })
    const repo = repository(root)
    const repositoryId = await realpath(repo.path)
    await store.createFlowRecord({
      id: 'launch-terminal',
      title: 'Launch terminal',
      instructions: 'Implement the plan.',
      status: 'active',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      terminals: [
        {
          terminalId: 'terminal-running',
          launchId: 'launch-running',
          provider: 'codex',
          mode: 'interactive',
          flowId: 'launch-terminal',
          phaseId: 'plan',
          status: 'running',
          command: 'codex',
          argv: ['Plan'],
          cwd: join(root, 'worktree'),
          startedAt: '2026-06-14T12:01:00.000Z'
        },
        {
          terminalId: 'terminal-exited',
          launchId: 'launch-exited',
          provider: 'claude',
          mode: 'interactive',
          flowId: 'launch-terminal',
          phaseId: 'plan',
          status: 'exited',
          command: 'claude',
          argv: ['Plan'],
          cwd: join(root, 'worktree'),
          startedAt: '2026-06-14T12:02:00.000Z',
          endedAt: '2026-06-14T12:03:00.000Z',
          exitCode: 0
        }
      ],
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:03:00.000Z'
    })
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      now: vi.fn().mockReturnValue('2026-06-14T12:04:00.000Z')
    })

    await expect(manager.listTerminals({
      repositoryId,
      flowId: 'launch-terminal'
    })).resolves.toEqual([
      expect.objectContaining({
        terminalId: 'terminal-running',
        status: 'failed',
        endedAt: '2026-06-14T12:04:00.000Z'
      }),
      expect.objectContaining({
        terminalId: 'terminal-exited',
        status: 'exited'
      })
    ])

    await expect(manager.writeInput({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-running',
      data: 'q'
    })).rejects.toThrow('Terminal is not attached to a running process: terminal-running')
    await expect(manager.dismiss({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-exited'
    })).resolves.toMatchObject({
      terminalId: 'terminal-exited',
      status: 'dismissed'
    })
  })

  it('serializes exit persistence after queued output persistence', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const realStore = await createFlowStore({ artifactRoot })
    const repo = repository(root)
    const repositoryId = await realpath(repo.path)
    const storedFlow = await realStore.createFlowRecord({
      id: 'launch-terminal',
      title: 'Launch terminal',
      instructions: 'Implement the plan.',
      status: 'creating',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    let releaseOutputPersist: (() => void) | undefined
    let outputPersistFinished: Promise<void> | undefined
    let resolveOutputPersistFinished: (() => void) | undefined
    const delayedStore: FlowStore = {
      ...realStore,
      async updateFlowRecord(flowId, update) {
        const terminal = update.terminals?.[0]
        if (
          terminal?.terminalId === 'terminal-123' &&
          terminal.status === 'running' &&
          terminal.recentOutput === 'final output\n'
        ) {
          outputPersistFinished = new Promise<void>((resolve) => {
            resolveOutputPersistFinished = resolve
          })
          await new Promise<void>((resolve) => {
            releaseOutputPersist = resolve
          })
          const result = await realStore.updateFlowRecord(flowId, update)
          resolveOutputPersistFinished?.()
          return result
        }

        return realStore.updateFlowRecord(flowId, update)
      }
    }
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: delayedStore,
      pty: {
        spawn() {
          return fakeProcess
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn()
        .mockReturnValueOnce('terminal-123')
        .mockReturnValueOnce('launch-123')
    })

    await manager.launchTerminal({
      flow: storedFlow,
      provider: 'codex',
      mode: 'interactive',
      phaseId: 'plan',
      prompt: 'Implement the approved plan.'
    })
    fakeProcess.emitData('final output\n')
    await waitForExpectation(() => {
      expect(releaseOutputPersist).toBeDefined()
    })
    fakeProcess.emitExit({ exitCode: 0 })
    releaseOutputPersist?.()
    await outputPersistFinished

    await waitForExpectation(async () => {
      await expect(realStore.readFlow('launch-terminal')).resolves.toMatchObject({
        terminals: [
          {
            terminalId: 'terminal-123',
            status: 'exited',
            recentOutput: 'final output\n',
            exitCode: 0
          }
        ]
      })
    })
    await expect(manager.writeInput({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123',
      data: 'q'
    })).rejects.toThrow('Terminal is not running: terminal-123')
  })

  it('serializes fast exit after the initial running persist', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const realStore = await createFlowStore({ artifactRoot })
    const repo = repository(root)
    const storedFlow = await realStore.createFlowRecord({
      id: 'launch-terminal',
      title: 'Launch terminal',
      instructions: 'Implement the plan.',
      status: 'creating',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    let releaseInitialPersist: (() => void) | undefined
    const delayedStore: FlowStore = {
      ...realStore,
      async updateFlowRecord(flowId, update) {
        const terminal = update.terminals?.[0]
        if (
          terminal?.terminalId === 'terminal-123' &&
          terminal.status === 'running' &&
          terminal.recentOutput === ''
        ) {
          await new Promise<void>((resolve) => {
            releaseInitialPersist = resolve
          })
        }

        return realStore.updateFlowRecord(flowId, update)
      }
    }
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: delayedStore,
      pty: {
        spawn() {
          return fakeProcess
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn()
        .mockReturnValueOnce('terminal-123')
        .mockReturnValueOnce('launch-123')
    })

    const launch = manager.launchTerminal({
      flow: storedFlow,
      provider: 'codex',
      mode: 'interactive',
      phaseId: 'plan',
      prompt: 'Implement the approved plan.'
    })
    await waitForExpectation(() => {
      expect(releaseInitialPersist).toBeDefined()
    })
    fakeProcess.emitExit({ exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseInitialPersist?.()
    await launch

    await waitForExpectation(async () => {
      await expect(realStore.readFlow('launch-terminal')).resolves.toMatchObject({
        terminals: [
          {
            terminalId: 'terminal-123',
            status: 'exited',
            exitCode: 0
          }
        ]
      })
    })
  })
})
