import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FlowListRow, RepositoryRow } from '@shared/workspace'
import { createFlowOperations } from './flowOperations'
import { runExclusiveFlowMutation } from './flowMutationQueue'
import { createFlowStore } from './flowStore'
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
    merge: { status: 'pending' },
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
  private exitHandlers: Array<(event: { exitCode: number; signal?: string | number }) => void> = []

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandlers.push(handler)
    return { dispose: () => undefined }
  }

  onExit(handler: (event: { exitCode: number; signal?: string | number }) => void): { dispose: () => void } {
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

  emitExit(event: { exitCode: number; signal?: string | number }): void {
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

  it('uses a supplied launch id for terminal metadata and wtui env', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const store = await createFlowStore({ artifactRoot })
    const repo = repository(root)
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
    const spawned: Array<{ env: Record<string, string> }> = []
    const pty: PtyAdapter = {
      spawn(_command, _args, options) {
        spawned.push({ env: options.env })
        return new FakePtyProcess()
      }
    }
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      pty,
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn().mockReturnValueOnce('terminal-123')
    })

    const terminal = await manager.launchTerminal({
      flow: storedFlow,
      provider: 'codex',
      mode: 'headless',
      phaseId: 'implementation',
      prompt: 'Implement the approved plan.',
      launchId: 'phase-launch-123'
    })

    expect(terminal).toMatchObject({
      terminalId: 'terminal-123',
      launchId: 'phase-launch-123',
      phaseId: 'implementation'
    })
    expect(spawned).toEqual([
      {
        env: expect.objectContaining({
          WTUI_LAUNCH_ID: 'phase-launch-123',
          WTUI_FLOW_PHASE_ID: 'implementation'
        })
      }
    ])
    await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
      terminals: [
        expect.objectContaining({
          terminalId: 'terminal-123',
          launchId: 'phase-launch-123'
        })
      ]
    })
  })

  it('persists concurrent terminal sidecars without dropping sibling terminals', async () => {
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
    const processes = [new FakePtyProcess(), new FakePtyProcess()]
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: realStore,
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

    await expect(realStore.readFlow('launch-terminal')).resolves.toMatchObject({
      terminals: expect.arrayContaining([
        expect.objectContaining({ terminalId: 'terminal-a' }),
        expect.objectContaining({ terminalId: 'terminal-b' })
      ])
    })
  })

  it('records numeric Unix termination signals as terminated terminals', async () => {
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
      status: 'active',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
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
    await manager.terminate({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123'
    })
    fakeProcess.emitExit({ exitCode: 1, signal: 15 })

    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        terminals: [
          {
            terminalId: 'terminal-123',
            status: 'terminated',
            signal: '15'
          }
        ]
      })
    })
  })

  it('marks headless launch phases as needing attention when their terminal exits non-zero', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const store = await createFlowStore({ artifactRoot })
    const repo = repository(root)
    const storedFlow = await store.createFlowRecord({
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
      phases: [
        {
          phase_id: 'implementation',
          title: 'Implementation',
          kind: 'implementation',
          status: 'running',
          order: 3,
          launch_ids: ['launch-123']
        }
      ],
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      pty: {
        spawn() {
          return fakeProcess
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn().mockReturnValueOnce('terminal-123')
    })

    await manager.launchTerminal({
      flow: storedFlow,
      provider: 'codex',
      mode: 'headless',
      phaseId: 'implementation',
      prompt: 'Implement the approved plan.',
      launchId: 'launch-123'
    })
    fakeProcess.emitExit({ exitCode: 1 })

    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        phases: [
          expect.objectContaining({
            id: 'implementation',
            status: 'needs_attention',
            notes: 'Phase terminal failed: codex exited with status 1.',
            launchIds: ['launch-123']
          })
        ],
        terminals: [
          expect.objectContaining({
            terminalId: 'terminal-123',
            status: 'failed',
            exitCode: 1
          })
        ]
      })
    })
  })

  it('marks headless launch phases as needing attention when their terminal is terminated', async () => {
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
      status: 'active',
      repositoryPath: repo.path,
      branch: 'flow/launch-terminal',
      worktreePath: join(root, 'worktree'),
      baseRef: 'main',
      commit: 'abc123',
      start: flow(root).start,
      phases: [
        {
          phase_id: 'implementation',
          title: 'Implementation',
          kind: 'implementation',
          status: 'running',
          order: 3,
          launch_ids: ['launch-123']
        }
      ],
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      pty: {
        spawn() {
          return fakeProcess
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn().mockReturnValueOnce('terminal-123')
    })

    await manager.launchTerminal({
      flow: storedFlow,
      provider: 'codex',
      mode: 'headless',
      phaseId: 'implementation',
      prompt: 'Implement the approved plan.',
      launchId: 'launch-123'
    })
    await manager.terminate({
      repositoryId,
      flowId: 'launch-terminal',
      terminalId: 'terminal-123'
    })
    fakeProcess.emitExit({ exitCode: 1, signal: 'SIGTERM' })

    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        phases: [
          expect.objectContaining({
            id: 'implementation',
            status: 'needs_attention',
            notes: 'Phase terminal failed: codex exited after signal SIGTERM.',
            launchIds: ['launch-123']
          })
        ],
        terminals: [
          expect.objectContaining({
            terminalId: 'terminal-123',
            status: 'terminated',
            signal: 'SIGTERM'
          })
        ]
      })
    })
  })

  it('does not overwrite newer serialized phase mutations after headless terminal failure', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'repo'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    const artifactRoot = join(root, 'artifacts')
    const store = await createFlowStore({ artifactRoot })
    const repo = repository(root)
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
      phases: [
        {
          phase_id: 'implementation',
          title: 'Implementation',
          kind: 'implementation',
          status: 'running',
          order: 3,
          launch_ids: ['launch-123']
        }
      ],
      createdAt: '2026-06-14T12:00:00.000Z',
      updatedAt: '2026-06-14T12:00:00.000Z'
    })
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store,
      pty: {
        spawn() {
          return fakeProcess
        }
      },
      now: vi.fn().mockReturnValue('2026-06-14T12:02:00.000Z'),
      idFactory: vi.fn().mockReturnValueOnce('terminal-123')
    })
    const flowOperations = createFlowOperations({ artifactRoot })
    let releaseCompletion!: () => void
    const completionMayContinue = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    const completion = runExclusiveFlowMutation('launch-terminal', async () => {
      await completionMayContinue
      await flowOperations.completePhase({
        flowId: 'launch-terminal',
        phaseId: 'implementation',
        summary: 'Implementation finished.'
      })
    })

    await manager.launchTerminal({
      flow: await store.readFlow('launch-terminal') as FlowListRow,
      provider: 'codex',
      mode: 'headless',
      phaseId: 'implementation',
      prompt: 'Implement the approved plan.',
      launchId: 'launch-123'
    })
    fakeProcess.emitExit({ exitCode: 1 })
    releaseCompletion()
    await completion

    await waitForExpectation(async () => {
      await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
        phases: [
          expect.objectContaining({
            id: 'implementation',
            status: 'completed',
            summary: 'Implementation finished.',
            launchIds: ['launch-123']
          })
        ],
        terminals: [
          expect.objectContaining({
            terminalId: 'terminal-123',
            status: 'failed',
            exitCode: 1
          })
        ]
      })
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

  it('marks orphaned headless launch phases as needing attention during terminal reconciliation', async () => {
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
      phases: [
        {
          phase_id: 'implementation',
          title: 'Implementation',
          kind: 'implementation',
          status: 'running',
          order: 3,
          launch_ids: ['launch-running']
        }
      ],
      terminals: [
        {
          terminalId: 'terminal-running',
          launchId: 'launch-running',
          provider: 'codex',
          mode: 'headless',
          flowId: 'launch-terminal',
          phaseId: 'implementation',
          status: 'running',
          command: 'codex',
          argv: ['Implement'],
          cwd: join(root, 'worktree'),
          startedAt: '2026-06-14T12:01:00.000Z'
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
      })
    ])
    await expect(store.readFlow('launch-terminal')).resolves.toMatchObject({
      phases: [
        expect.objectContaining({
          id: 'implementation',
          status: 'needs_attention',
          notes: 'Phase terminal failed: codex exited unsuccessfully.',
          launchIds: ['launch-running']
        })
      ]
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
    const fakeProcess = new FakePtyProcess()
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: realStore,
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
    fakeProcess.emitExit({ exitCode: 0 })

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
    const fakeProcess = new FakePtyProcess()
    let spawned = false
    const manager = new TerminalSessionManager({
      artifactRoot,
      store: realStore,
      pty: {
        spawn() {
          spawned = true
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
      expect(spawned).toBe(true)
    })
    fakeProcess.emitExit({ exitCode: 0 })
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
