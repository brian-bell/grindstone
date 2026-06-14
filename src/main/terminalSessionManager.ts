import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as nodePty from 'node-pty'
import type {
  AgentLaunchMode,
  AgentProvider,
  FlowListRow,
  FlowTerminalSummary,
  TerminalActionRequest,
  TerminalEvent,
  TerminalInputRequest,
  TerminalListRequest,
  TerminalResizeRequest
} from '@shared/workspace'
import { buildAgentLaunchCommand } from './agentLaunch'
import type { FlowStore } from './flowStore'

type Disposable = {
  dispose: () => void
}

export type PtyProcess = {
  onData: (handler: (data: string) => void) => Disposable
  onExit: (handler: (event: { exitCode: number; signal?: string | number }) => void) => Disposable
  write: (data: string) => void
  resize: (columns: number, rows: number) => void
  kill: (signal?: string) => void
}

export type PtyAdapter = {
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string
      env: Record<string, string>
      columns: number
      rows: number
    }
  ) => PtyProcess
}

export type LaunchTerminalRequest = {
  flow: FlowListRow
  provider: AgentProvider
  mode: AgentLaunchMode
  phaseId: string
  prompt: string
  sessionId?: string
}

type ManagedTerminal = {
  flow: FlowListRow
  process: PtyProcess | null
  terminal: FlowTerminalSummary
  terminateTimer: NodeJS.Timeout | null
}

const RECENT_OUTPUT_LIMIT = 20_000

export const nodePtyAdapter: PtyAdapter = {
  spawn(command, args, options) {
    return nodePty.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      cols: options.columns,
      rows: options.rows
    })
  }
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, ManagedTerminal>()

  constructor(
    private readonly options: {
      artifactRoot: string
      store: FlowStore
      pty?: PtyAdapter
      now?: () => string
      idFactory?: () => string
      onEvent?: (event: TerminalEvent) => void
      env?: NodeJS.ProcessEnv
      terminateGraceMs?: number
    }
  ) {}

  async launchTerminal(request: LaunchTerminalRequest): Promise<FlowTerminalSummary> {
    const start = request.flow.start
    if (start === undefined || request.flow.worktreePath === undefined) {
      throw new Error('Flow start metadata is required before launching a terminal.')
    }

    const terminalId = this.createId()
    const launchId = this.createId()
    const terminalDir = join(
      this.options.artifactRoot,
      'flows',
      request.flow.id,
      'terminals',
      terminalId
    )
    const logPath = join(terminalDir, 'raw.log')
    const metaPath = join(terminalDir, 'meta.json')
    await mkdir(terminalDir, { recursive: true })

    const launchCommand = buildAgentLaunchCommand({
      provider: request.provider,
      mode: request.mode,
      flowId: request.flow.id,
      phaseId: request.phaseId,
      planId: request.flow.planId,
      planPath: request.flow.planPath,
      sessionId: request.sessionId,
      launchId,
      prompt: request.prompt,
      repositoryPath: start.repositoryPath,
      worktreePath: start.worktreePath,
      branch: start.branch,
      commit: start.commit,
      artifactRoots: {
        flowStateRoot: this.options.artifactRoot,
        planStateRoot: this.options.artifactRoot,
        sessionStateRoot: this.options.artifactRoot
      }
    })

    const terminal: FlowTerminalSummary = {
      terminalId,
      launchId,
      provider: request.provider,
      mode: request.mode,
      flowId: request.flow.id,
      phaseId: request.phaseId,
      planId: request.flow.planId,
      sessionId: request.sessionId,
      status: 'starting',
      command: launchCommand.executable,
      argv: launchCommand.argv,
      cwd: launchCommand.cwd,
      logPath,
      startedAt: this.now(),
      recentOutput: ''
    }

    await writeFile(logPath, '', { flag: 'a' })
    await this.writeTerminalMetadata(metaPath, terminal)
    await this.persistTerminal(request.flow.id, terminal)

    try {
      const ptyProcess = (this.options.pty ?? nodePtyAdapter).spawn(
        launchCommand.executable,
        launchCommand.argv,
        {
          cwd: launchCommand.cwd,
          env: {
            ...processEnvToRecord(this.options.env ?? process.env),
            ...launchCommand.env
          },
          columns: 100,
          rows: 30
        }
      )
      const managed: ManagedTerminal = {
        flow: request.flow,
        process: ptyProcess,
        terminal: {
          ...terminal,
          status: 'running'
        },
        terminateTimer: null
      }
      this.sessions.set(terminalId, managed)
      ptyProcess.onData((data) => {
        void this.handleData(managed, data, metaPath)
      })
      ptyProcess.onExit((event) => {
        void this.handleExit(managed, event, metaPath)
      })
      await this.writeTerminalMetadata(metaPath, managed.terminal)
      await this.persistTerminal(request.flow.id, managed.terminal)
      this.emitState(managed)
      return managed.terminal
    } catch (error) {
      const failed = {
        ...terminal,
        status: 'failed' as const,
        endedAt: this.now()
      }
      await this.writeTerminalMetadata(metaPath, failed)
      await this.persistTerminal(request.flow.id, failed)
      throw error
    }
  }

  async listTerminals(request: TerminalListRequest): Promise<FlowTerminalSummary[]> {
    const flow = await this.getOwnedFlow(request.repositoryId, request.flowId)
    return flow.terminals ?? []
  }

  async writeInput(request: TerminalInputRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getOwnedManagedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }

    managed.process?.write(request.data)
    return managed.terminal
  }

  async resize(request: TerminalResizeRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getOwnedManagedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }
    if (!Number.isInteger(request.columns) || request.columns <= 0 || !Number.isInteger(request.rows) || request.rows <= 0) {
      throw new Error('Terminal resize dimensions must be positive integers.')
    }

    managed.process?.resize(request.columns, request.rows)
    return managed.terminal
  }

  async terminate(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getOwnedManagedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }

    managed.process?.kill('SIGTERM')
    managed.terminateTimer = setTimeout(() => {
      managed.process?.kill('SIGKILL')
    }, this.options.terminateGraceMs ?? 1_000)
    return managed.terminal
  }

  async dismiss(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getOwnedManagedTerminal(request)
    if (!['exited', 'terminated', 'failed'].includes(managed.terminal.status)) {
      throw new Error(`Only completed terminals can be dismissed: ${request.terminalId}`)
    }

    managed.terminal = {
      ...managed.terminal,
      status: 'dismissed'
    }
    const metaPath = this.getMetaPath(managed.terminal)
    await this.writeTerminalMetadata(metaPath, managed.terminal)
    await this.persistTerminal(managed.terminal.flowId, managed.terminal)
    this.emitState(managed)
    return managed.terminal
  }

  private async handleData(
    managed: ManagedTerminal,
    data: string,
    metaPath: string
  ): Promise<void> {
    await appendFile(managed.terminal.logPath ?? '', data, 'utf8')
    managed.terminal = {
      ...managed.terminal,
      recentOutput: trimRecentOutput(`${managed.terminal.recentOutput ?? ''}${data}`)
    }
    await this.writeTerminalMetadata(metaPath, managed.terminal)
    await this.persistTerminal(managed.terminal.flowId, managed.terminal)
    this.options.onEvent?.({
      type: 'output',
      repositoryId: managed.flow.repositoryId,
      flowId: managed.terminal.flowId,
      terminalId: managed.terminal.terminalId,
      data
    })
  }

  private async handleExit(
    managed: ManagedTerminal,
    event: { exitCode: number; signal?: string | number },
    metaPath: string
  ): Promise<void> {
    if (managed.terminateTimer !== null) {
      clearTimeout(managed.terminateTimer)
      managed.terminateTimer = null
    }

    const signal = event.signal === undefined ? undefined : String(event.signal)
    managed.terminal = {
      ...managed.terminal,
      status: signal === 'SIGTERM' || signal === 'SIGKILL'
        ? 'terminated'
        : event.exitCode === 0
          ? 'exited'
          : 'failed',
      endedAt: this.now(),
      exitCode: event.exitCode,
      signal
    }
    managed.process = null
    await this.writeTerminalMetadata(metaPath, managed.terminal)
    await this.persistTerminal(managed.terminal.flowId, managed.terminal)
    this.emitState(managed)
  }

  private async getOwnedManagedTerminal(request: TerminalActionRequest): Promise<ManagedTerminal> {
    const flow = await this.getOwnedFlow(request.repositoryId, request.flowId)
    const managed = this.sessions.get(request.terminalId)
    if (managed === undefined || managed.terminal.flowId !== flow.id) {
      throw new Error(`Terminal not found: ${request.terminalId}`)
    }

    return managed
  }

  private async getOwnedFlow(repositoryId: string, flowId: string): Promise<FlowListRow> {
    const flow = await this.options.store.readFlow(flowId)
    if (flow === undefined || flow.repositoryId !== repositoryId) {
      throw new Error(`Flow not found for repository: ${flowId}`)
    }

    return flow
  }

  private async persistTerminal(flowId: string, terminal: FlowTerminalSummary): Promise<void> {
    const flow = await this.options.store.readFlow(flowId)
    if (flow === undefined) {
      throw new Error(`Flow record not found: ${flowId}`)
    }

    const terminals = [
      ...(flow.terminals ?? []).filter((candidate) => candidate.terminalId !== terminal.terminalId),
      terminal
    ]

    await this.options.store.updateFlowRecord(flowId, {
      terminals,
      updatedAt: flow.updatedAt
    })
  }

  private async writeTerminalMetadata(
    metaPath: string,
    terminal: FlowTerminalSummary
  ): Promise<void> {
    await writeFile(`${metaPath}`, `${JSON.stringify(toRawTerminal(terminal), null, 2)}\n`, 'utf8')
  }

  private emitState(managed: ManagedTerminal): void {
    this.options.onEvent?.({
      type: 'state',
      repositoryId: managed.flow.repositoryId,
      flowId: managed.terminal.flowId,
      terminal: managed.terminal
    })
  }

  private getMetaPath(terminal: FlowTerminalSummary): string {
    return join(
      this.options.artifactRoot,
      'flows',
      terminal.flowId,
      'terminals',
      terminal.terminalId,
      'meta.json'
    )
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private createId(): string {
    return this.options.idFactory?.() ?? randomUUID()
  }
}

function processEnvToRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    )
  )
}

function trimRecentOutput(output: string): string {
  return output.length <= RECENT_OUTPUT_LIMIT
    ? output
    : output.slice(output.length - RECENT_OUTPUT_LIMIT)
}

function toRawTerminal(terminal: FlowTerminalSummary): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      terminal_id: terminal.terminalId,
      launch_id: terminal.launchId,
      provider: terminal.provider,
      mode: terminal.mode,
      flow_id: terminal.flowId,
      phase_id: terminal.phaseId,
      plan_id: terminal.planId,
      session_id: terminal.sessionId,
      status: terminal.status,
      command: terminal.command,
      argv: terminal.argv,
      cwd: terminal.cwd,
      log_path: terminal.logPath,
      started_at: terminal.startedAt,
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      recent_output: terminal.recentOutput
    }).filter((entry) => entry[1] !== undefined)
  )
}
